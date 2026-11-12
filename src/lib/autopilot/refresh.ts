import { allRows, db } from "../supabase";
import { proposeGroup } from "./actions";
import { automationBlocked, loadSettings } from "./settings";
import { callShopee, chunk } from "./shopee-call";
import { esc, sendTelegram, vnd } from "./telegram";
import { addDays, vnDate } from "./time";

const n = (v: unknown) => Number(v ?? 0) || 0;

/** Ngưỡng làm mới chiến dịch (không đưa vào rule_params để giữ đơn giản). */
export const REFRESH = {
  lookbackDays: 14, // xét D-15 … D-2
  deadDays: 5, // "không chạy": 5 ngày gần nhất (D-6 … D-2) đều chi dưới deadExpense
  deadExpense: 10_000,
  poorMinExpense: 500_000,
  poorRoasRatio: 0.5,
  noOrderClicks: 80,
  minAgeDays: 7, // chiến dịch mới chạy chưa đủ 7 ngày thì bỏ qua
  itemCooldownDays: 14,
  maxPerWeek: 5,
  deadTargetCut: 0.85, // chiến dịch không chạy: hạ ROAS mục tiêu 15% để dễ thắng thầu
};

export interface RefreshCandidate {
  campaign_id: number;
  item_id: number;
  ad_name: string | null;
  kind: "dead" | "poor" | "no_orders";
  why: string;
  budget: number;
  roas_target: number | null;
  new_roas_target: number | null;
  shopee_suggest: number | null;
}

/**
 * Tìm chiến dịch nên làm mới (dừng hẳn + tạo chiến dịch mới cho cùng sản phẩm).
 * Trả về cả danh sách bị loại vì lỗi ở sản phẩm (hết hàng, bị khóa) để anh xử lý.
 */
export async function findRefreshCandidates(shopId: number) {
  const today = vnDate();
  const from = addDays(today, -(REFRESH.lookbackDays + 1));
  const to = addDays(today, -2);
  const deadFrom = addDays(today, -(REFRESH.deadDays + 1));

  const { data: camps, error } = await db()
    .from("ads_campaigns")
    .select("campaign_id, ad_name, campaign_budget, roas_target, bidding_method, item_ids, start_time")
    .eq("shop_id", shopId)
    .eq("campaign_status", "ongoing")
    .eq("autopilot_excluded", false);
  if (error) throw new Error(error.message);
  const minStart = Date.now() / 1000 - REFRESH.minAgeDays * 86400;
  const eligible = (camps ?? []).filter(
    (c) => c.bidding_method === "auto" && (c.item_ids ?? []).length === 1 && n(c.start_time) > 0 && n(c.start_time) < minStart
  );
  if (!eligible.length) return { candidates: [] as RefreshCandidate[], productIssues: [] as string[], recentlyRefreshed: 0 };

  const daily: any[] = [];
  for (const ids of chunk(eligible.map((c) => Number(c.campaign_id)), 100)) {
    const data = await allRows(() =>
      db()
        .from("ads_campaign_daily")
        .select("campaign_id, date, impression, clicks, expense, broad_order, broad_gmv")
        .eq("shop_id", shopId)
        .gte("date", from)
        .lte("date", to)
        .in("campaign_id", ids)
        .order("campaign_id")
        .order("date")
    );
    daily.push(...data);
  }
  const byCamp = new Map<number, any[]>();
  for (const r of daily) {
    const id = Number(r.campaign_id);
    if (!byCamp.has(id)) byCamp.set(id, []);
    byCamp.get(id)!.push(r);
  }

  // Sản phẩm đã làm mới gần đây, và chiến dịch sinh ra từ lần làm mới trước.
  const since = new Date(Date.now() - REFRESH.itemCooldownDays * 86400_000).toISOString();
  const { data: past } = await db()
    .from("autopilot_actions")
    .select("after, status, created_at")
    .eq("shop_id", shopId)
    .eq("action", "refresh")
    .in("status", ["executed", "proposed", "approved", "dry_run"])
    .gte("created_at", since);
  const recentItems = new Set((past ?? []).map((p) => Number(p.after?.item_id)));
  const refreshedCampaigns = new Set((past ?? []).map((p) => Number(p.after?.new_campaign_id)).filter(Boolean));

  const raw: Omit<RefreshCandidate, "new_roas_target" | "shopee_suggest">[] = [];
  const secondRound: string[] = [];
  for (const c of eligible) {
    const id = Number(c.campaign_id);
    const rows = byCamp.get(id) ?? [];
    const exp = rows.reduce((s, r) => s + n(r.expense), 0);
    const gmv = rows.reduce((s, r) => s + n(r.broad_gmv), 0);
    const clicks = rows.reduce((s, r) => s + n(r.clicks), 0);
    const orders = rows.reduce((s, r) => s + n(r.broad_order), 0);
    const roas = exp > 0 ? gmv / exp : 0;
    const target = c.roas_target == null ? null : n(c.roas_target);

    // Không chạy: 5 ngày gần nhất ngày nào cũng chi dưới 10k (kể cả không có dòng số liệu).
    let deadDays = 0;
    for (let d = deadFrom; d <= to; d = addDays(d, 1)) {
      const r = rows.find((x) => x.date === d);
      if (!r || n(r.expense) < REFRESH.deadExpense) deadDays++;
    }
    let kind: RefreshCandidate["kind"] | null = null;
    let why = "";
    if (deadDays >= REFRESH.deadDays) {
      kind = "dead";
      why = `${REFRESH.deadDays} ngày gần nhất gần như không chạy (14 ngày chi ${vnd(exp)}, ${clicks} click)`;
    } else if (clicks >= REFRESH.noOrderClicks && orders === 0) {
      kind = "no_orders";
      why = `14 ngày: ${clicks} click, 0 đơn, chi ${vnd(exp)}`;
    } else if (target && exp >= REFRESH.poorMinExpense && roas < target * REFRESH.poorRoasRatio) {
      kind = "poor";
      why = `14 ngày: chi ${vnd(exp)}, ROAS ${roas.toFixed(1)} < 50% mục tiêu ${target}`;
    }
    if (!kind) continue;
    const itemId = Number(c.item_ids[0]);
    if (refreshedCampaigns.has(id)) {
      secondRound.push(`${c.ad_name ?? id} #${id}: đã làm mới mà vẫn kém (${why}) — xem lại sản phẩm`);
      continue;
    }
    if (recentItems.has(itemId)) continue;
    raw.push({ campaign_id: id, item_id: itemId, ad_name: c.ad_name, kind, why, budget: n(c.campaign_budget), roas_target: target });
  }

  // Kiểm tra sản phẩm: hết hàng / không bán được thì làm mới chiến dịch cũng vô ích.
  const productIssues: string[] = [...secondRound];
  const okItems = new Set<number>();
  for (const ids of chunk([...new Set(raw.map((r) => r.item_id))], 50)) {
    const res = await callShopee(shopId, "product.get_item_base_info", { item_id_list: ids.join(",") });
    for (const it of res.response?.item_list ?? []) {
      const stock = it.stock_info_v2?.summary_info?.total_available_stock;
      const name = raw.find((r) => r.item_id === Number(it.item_id))?.ad_name ?? it.item_id;
      if (it.item_status && it.item_status !== "NORMAL") productIssues.push(`${name}: sản phẩm đang ${it.item_status}`);
      else if (stock != null && Number(stock) <= 0) productIssues.push(`${name}: HẾT HÀNG — chiến dịch không chạy vì hết hàng`);
      else okItems.add(Number(it.item_id));
    }
  }

  const order = { dead: 0, no_orders: 1, poor: 2 };
  const candidates: RefreshCandidate[] = [];
  for (const r of raw.filter((x) => okItems.has(x.item_id)).sort((a, b) => order[a.kind] - order[b.kind])) {
    let suggest: number | null = null;
    try {
      const rec = await callShopee(shopId, "ads.get_product_recommended_roi_target", {
        reference_id: crypto.randomUUID(),
        item_id: r.item_id,
      });
      suggest = rec.response?.exact?.value ?? null;
    } catch {
      suggest = null;
    }
    const base = r.roas_target ?? suggest;
    const next = base == null ? null : Math.round((r.kind === "dead" ? base * REFRESH.deadTargetCut : base) * 10) / 10;
    candidates.push({ ...r, new_roas_target: next, shopee_suggest: suggest });
  }
  return { candidates, productIssues, recentlyRefreshed: past?.length ?? 0 };
}

/** Đề xuất gộp (luôn chờ anh duyệt, kể cả chế độ auto). */
export async function proposeRefresh(shopId: number, source = "rule:refresh") {
  const s = await loadSettings(shopId);
  const blocked = automationBlocked(s);
  if (blocked) return { skipped: blocked };
  const { candidates, productIssues, recentlyRefreshed } = await findRefreshCandidates(shopId);
  const room = Math.max(0, REFRESH.maxPerWeek - recentlyRefreshed);
  const picked = candidates.slice(0, room);
  const label = { dead: "không chạy", no_orders: "có click không ra đơn", poor: "kém kéo dài" };
  if (!picked.length) {
    if (productIssues.length) {
      await sendTelegram(`🔎 <b>Rà chiến dịch</b> — ${esc(s.shop_name ?? String(shopId))}\nKhông có chiến dịch cần làm mới. Cần xem sản phẩm:\n- ${productIssues.slice(0, 15).map(esc).join("\n- ")}`);
    }
    return { items: 0, candidates: candidates.length, productIssues: productIssues.length, group: null };
  }
  const group = await proposeGroup(
    shopId,
    `Làm mới ${picked.length} chiến dịch (dừng hẳn chiến dịch cũ, tạo chiến dịch mới cho cùng sản phẩm)`,
    picked.map((c) => ({
      campaign_id: c.campaign_id,
      action: "refresh" as const,
      before: { budget: c.budget, roas_target: c.roas_target },
      after: {
        item_id: c.item_id,
        budget: s.start_budget,
        roas_target: c.new_roas_target,
        why: `${label[c.kind]}: ${c.why}${c.shopee_suggest != null ? `; Shopee gợi ý ROAS ${c.shopee_suggest}` : ""}`,
      },
    })),
    source,
    [
      "Dừng hẳn là KHÔNG hoàn tác được. Chiến dịch mới: ngân sách khởi điểm, ROAS mục tiêu giữ mức cũ (chiến dịch không chạy: hạ 15%).",
      productIssues.length ? `\nCần xem sản phẩm (không đề xuất làm mới):\n- ${productIssues.slice(0, 10).join("\n- ")}` : "",
      candidates.length > picked.length ? `\nCòn ${candidates.length - picked.length} chiến dịch khác chờ tuần sau (tối đa ${REFRESH.maxPerWeek}/tuần).` : "",
    ].join(""),
    3 * 24 * 60
  );
  return { items: picked.length, candidates: candidates.length, productIssues: productIssues.length, group: group?.id ?? null };
}
