import { db } from "../supabase";
import { editsToday, propose, proposeGroup, recentlyTouched, type ProposalInput } from "./actions";
import { automationBlocked, loadSettings, type ShopSettings } from "./settings";
import { vnd } from "./telegram";
import { addDays, vnDate, vnHour } from "./time";

const n = (v: unknown) => Number(v ?? 0) || 0;
const MAX_PROPOSALS_PER_RUN = 10;

interface Camp {
  campaign_id: number;
  ad_name: string | null;
  campaign_status: string;
  campaign_budget: number;
  roas_target: number | null;
  tool_paused_at: string | null;
}

async function ongoingCampaigns(shopId: number): Promise<Camp[]> {
  const { data, error } = await db()
    .from("ads_campaigns")
    .select("campaign_id, ad_name, campaign_status, campaign_budget, roas_target, tool_paused_at")
    .eq("shop_id", shopId)
    .eq("campaign_status", "ongoing")
    .eq("autopilot_excluded", false);
  if (error) throw new Error(error.message);
  return (data ?? []).map((c) => ({
    ...c,
    campaign_id: Number(c.campaign_id),
    campaign_budget: n(c.campaign_budget),
    roas_target: c.roas_target == null ? null : n(c.roas_target),
  }));
}

// ---------------------------------------------------------------------------
// F2: luật trong ngày (chạy sau mỗi lần thu số liệu)
// ---------------------------------------------------------------------------

export async function evaluateIntraday(shopId: number): Promise<{ proposals: number; skipped?: string }> {
  const s = await loadSettings(shopId);
  const blocked = automationBlocked(s);
  if (blocked) return { proposals: 0, skipped: blocked };
  const p = s.params;
  const today = vnDate();
  const hour = vnHour();

  const camps = await ongoingCampaigns(shopId);
  if (!camps.length) return { proposals: 0 };
  const { data: hourly, error } = await db()
    .from("ads_campaign_hourly")
    .select("campaign_id, hour, clicks, expense, broad_gmv")
    .eq("shop_id", shopId)
    .eq("date", today)
    .in("campaign_id", camps.map((c) => c.campaign_id))
    .gt("impression", 0)
    .limit(10000);
  if (error) throw new Error(error.message);
  const byCamp = new Map<number, { hour: number; clicks: number; expense: number; gmv: number }[]>();
  for (const r of hourly ?? []) {
    const id = Number(r.campaign_id);
    if (!byCamp.has(id)) byCamp.set(id, []);
    byCamp.get(id)!.push({ hour: r.hour, clicks: n(r.clicks), expense: n(r.expense), gmv: n(r.broad_gmv) });
  }

  const candidates: (ProposalInput & { priority: number })[] = [];
  for (const c of camps) {
    const rows = byCamp.get(c.campaign_id) ?? [];
    const exp = rows.reduce((s, r) => s + r.expense, 0);
    const gmv = rows.reduce((s, r) => s + r.gmv, 0);
    const roas = exp > 0 ? gmv / exp : 0;
    const target = c.roas_target;

    // Tăng ngân sách: sắp tiêu hết và đang hiệu quả.
    if (c.campaign_budget > 0 && exp >= p.scale_spend_ratio * c.campaign_budget && roas >= (target ?? p.cut_roas_floor * 2)) {
      const step = Math.max(p.scale_min_step, (c.campaign_budget * p.scale_step_pct) / 100);
      const wanted = Math.round((c.campaign_budget + step) / 1000) * 1000;
      candidates.push({
        priority: 1,
        shop_id: shopId,
        campaign_id: c.campaign_id,
        action: "change_budget",
        before: { budget: c.campaign_budget },
        after: { budget: wanted },
        reason: `Đã tiêu ${vnd(exp)} (${Math.round((exp / c.campaign_budget) * 100)}% ngân sách), ROAS hôm nay ${roas.toFixed(1)} ≥ ${target ?? "ngưỡng"}`,
        source: "rule:scale_up",
      });
      continue;
    }

    // Tạm dừng tới 0h: khung W giờ đã trọn vẹn, đủ click, ROAS quá thấp. Không phạt dựa trên 1–2 giờ.
    const W = Math.max(3, p.cut_window_hours);
    if (hour >= W) {
      const win = rows.filter((r) => r.hour >= hour - W && r.hour < hour);
      const wClicks = win.reduce((s, r) => s + r.clicks, 0);
      const wExp = win.reduce((s, r) => s + r.expense, 0);
      const wGmv = win.reduce((s, r) => s + r.gmv, 0);
      const wRoas = wExp > 0 ? wGmv / wExp : 0;
      const threshold = target ? target * p.cut_roas_ratio : p.cut_roas_floor;
      // Cần chi tiêu ở ≥ 2 giờ trong khung: một giờ đột biến không đủ để phạt.
      const activeHours = win.filter((r) => r.expense > 0).length;
      if (activeHours >= 2 && wClicks >= p.cut_min_clicks && wExp >= p.cut_min_expense && wRoas < threshold) {
        candidates.push({
          priority: 0,
          shop_id: shopId,
          campaign_id: c.campaign_id,
          action: "pause",
          before: { status: "ongoing", budget: c.campaign_budget },
          after: { status: "paused", until_midnight: true },
          reason: `${W} giờ qua (${hour - W}h–${hour - 1}h): ${wClicks} click, chi ${vnd(wExp)}, ROAS ${wRoas.toFixed(1)} < ${threshold.toFixed(1)}. Hôm nay: chi ${vnd(exp)}, ROAS ${roas.toFixed(1)}`,
          source: "rule:cut",
        });
      }
    }
  }

  candidates.sort((a, b) => a.priority - b.priority);
  let made = 0;
  for (const cand of candidates) {
    if (made >= MAX_PROPOSALS_PER_RUN) break;
    if (await recentlyTouched(shopId, cand.campaign_id, p.cooldown_minutes)) continue;
    if ((await editsToday(shopId, cand.campaign_id)) >= s.max_edits_per_day) continue;
    const { priority: _p, ...input } = cand;
    await propose(input, p.proposal_ttl_minutes, s);
    made++;
  }
  return { proposals: made };
}

// ---------------------------------------------------------------------------
// F3: reset 0h
// ---------------------------------------------------------------------------

export async function proposeMidnightReset(shopId: number) {
  const s = await loadSettings(shopId);
  const blocked = automationBlocked(s);
  if (blocked) return { skipped: blocked };
  const { data, error } = await db()
    .from("ads_campaigns")
    .select("campaign_id, campaign_status, campaign_budget, tool_paused_at")
    .eq("shop_id", shopId)
    .in("campaign_status", ["ongoing", "paused"])
    .eq("autopilot_excluded", false);
  if (error) throw new Error(error.message);
  const items: { campaign_id: number; action: ProposalInput["action"]; before: any; after: any }[] = [];
  for (const c of data ?? []) {
    const id = Number(c.campaign_id);
    const budget = n(c.campaign_budget);
    if (c.campaign_status === "paused" && c.tool_paused_at) {
      items.push({ campaign_id: id, action: "resume", before: { status: "paused" }, after: { status: "ongoing" } });
    }
    const resetThis = budget > s.start_budget || (budget === 0 && s.reset_unlimited);
    if (resetThis && (c.campaign_status === "ongoing" || c.tool_paused_at)) {
      items.push({ campaign_id: id, action: "change_budget", before: { budget }, after: { budget: s.start_budget } });
    }
  }
  const group = await proposeGroup(
    shopId,
    "Reset 0h: ngân sách về mức khởi điểm, bật lại chiến dịch tool đã dừng",
    items,
    "rule:reset",
    `Ngân sách khởi điểm ${vnd(s.start_budget)}; trong ngày tăng dần theo luật.${s.reset_unlimited ? "" : " (Chiến dịch không giới hạn ngân sách giữ nguyên; bật 'Áp dụng cho chiến dịch không giới hạn' trong Cài đặt để đưa vào.)"}`,
    10 * 60,
    { autoExecute: s.mode === "auto" }
  );
  return { items: items.length, group: group?.id ?? null };
}

// ---------------------------------------------------------------------------
// F4: ROAS mục tiêu hằng ngày (chỉ đề xuất)
// ---------------------------------------------------------------------------

export async function proposeRoasTargets(shopId: number) {
  const s = await loadSettings(shopId);
  const blocked = automationBlocked(s);
  if (blocked) return { skipped: blocked };
  const p = s.params;
  const today = vnDate();
  const camps = (await ongoingCampaigns(shopId)).filter((c) => c.roas_target != null && c.roas_target > 0);
  if (!camps.length) return { items: 0 };
  const { data, error } = await db()
    .from("ads_campaign_daily")
    .select("campaign_id, date, expense, broad_gmv")
    .eq("shop_id", shopId)
    .gte("date", addDays(today, -8))
    .lte("date", addDays(today, -2))
    .in("campaign_id", camps.map((c) => c.campaign_id))
    .limit(10000);
  if (error) throw new Error(error.message);
  const recentFrom = addDays(today, -4);
  const agg = new Map<number, { e: number; g: number; re: number; rg: number }>();
  for (const r of data ?? []) {
    const a = agg.get(Number(r.campaign_id)) ?? { e: 0, g: 0, re: 0, rg: 0 };
    a.e += n(r.expense);
    a.g += n(r.broad_gmv);
    if (r.date >= recentFrom) {
      a.re += n(r.expense);
      a.rg += n(r.broad_gmv);
    }
    agg.set(Number(r.campaign_id), a);
  }

  const items: { campaign_id: number; action: ProposalInput["action"]; before: any; after: any }[] = [];
  const maxChange = p.roas_max_change_pct / 100;
  for (const c of camps) {
    const a = agg.get(c.campaign_id);
    if (!a || a.e < p.roas_min_week_expense) continue;
    const target = c.roas_target!;
    const week = a.g / a.e;
    const recent = a.re > 0 ? a.rg / a.re : week;
    let next: number | null = null;
    let why = "";
    if (week < target * p.roas_low_ratio && recent < target * p.roas_low_ratio) {
      // Thực tế thấp hơn mục tiêu > 20% liên tục: nâng mục tiêu để Shopee thầu chặt hơn.
      next = target * (1 + maxChange);
      why = `ROAS 7 ngày ${week.toFixed(1)}, 3 ngày ${recent.toFixed(1)} < ${Math.round(p.roas_low_ratio * 100)}% mục tiêu`;
    } else if (week > target * p.roas_high_ratio && recent > target * p.roas_high_ratio && (c.campaign_budget === 0 || a.re / 3 < c.campaign_budget * 0.8)) {
      // Vượt mục tiêu và còn dư ngân sách: hạ nhẹ để mở rộng.
      next = target * (1 - Math.min(maxChange, 0.1));
      why = `ROAS 7 ngày ${week.toFixed(1)}, 3 ngày ${recent.toFixed(1)} > ${Math.round(p.roas_high_ratio * 100)}% mục tiêu, còn dư ngân sách`;
    }
    if (next == null) continue;
    next = Math.round(next * 10) / 10;
    if (next === target) continue;
    items.push({ campaign_id: c.campaign_id, action: "change_roas_target", before: { roas_target: target }, after: { roas_target: next, why } });
  }
  const group = await proposeGroup(
    shopId,
    "Đề xuất ROAS mục tiêu (theo 7 ngày D-8…D-2)",
    items,
    "rule:roas_target",
    `Mỗi lần đổi tối đa ±${p.roas_max_change_pct}%. Duyệt từng chiến dịch trên dashboard nếu muốn chọn lọc.`,
    12 * 60
  );
  return { items: items.length, group: group?.id ?? null };
}

// ---------------------------------------------------------------------------
// Lệnh nhanh: tạm dừng / bật lại tất cả
// ---------------------------------------------------------------------------

export async function proposePauseAll(shopId: number, source: string) {
  const { data } = await db()
    .from("ads_campaigns")
    .select("campaign_id")
    .eq("shop_id", shopId)
    .eq("campaign_status", "ongoing");
  return proposeGroup(
    shopId,
    "Tạm dừng TẤT CẢ chiến dịch đang chạy",
    (data ?? []).map((c) => ({
      campaign_id: Number(c.campaign_id),
      action: "pause" as const,
      before: { status: "ongoing" },
      after: { status: "paused", until_midnight: false, by_pause_all: true },
    })),
    source,
    "Lệnh /pause_all",
    30
  );
}

export async function proposeResumeAll(shopId: number, source: string) {
  // Chỉ bật lại chiến dịch do tool / pause_all tạm dừng, không đụng chiến dịch anh tự tắt.
  const { data: paused } = await db()
    .from("autopilot_actions")
    .select("campaign_id")
    .eq("shop_id", shopId)
    .eq("action", "pause")
    .in("status", ["executed"])
    .gte("created_at", new Date(Date.now() - 7 * 86400_000).toISOString());
  const ids = [...new Set((paused ?? []).map((r) => Number(r.campaign_id)))];
  if (!ids.length) return null;
  const { data } = await db()
    .from("ads_campaigns")
    .select("campaign_id")
    .eq("shop_id", shopId)
    .eq("campaign_status", "paused")
    .in("campaign_id", ids);
  return proposeGroup(
    shopId,
    "Bật lại các chiến dịch tool đã tạm dừng",
    (data ?? []).map((c) => ({
      campaign_id: Number(c.campaign_id),
      action: "resume" as const,
      before: { status: "paused" },
      after: { status: "ongoing" },
    })),
    source,
    "Lệnh /resume_all",
    30
  );
}

export type { ShopSettings };
