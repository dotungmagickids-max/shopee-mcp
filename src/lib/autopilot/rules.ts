import { allRows, db } from "../supabase";
import { editsToday, propose, proposeGroup, recentlyTouched, type ProposalInput } from "./actions";
import { ruleTarget, type Econ } from "./profit";
import { floorBlock, mixBoost, scaleStyle, scaleTargetFor, type ProductClass } from "./classes";
import { esc, sendAlertOnce } from "./telegram";
import { shopName } from "./config";
import { automationBlocked, editsLimit, isPeakDay, loadSettings, SALE_TIER_VI, saleTier, type ShopSettings } from "./settings";
import { vnd } from "./telegram";
import { addDays, vnDate, vnDayStartUnix, vnHour } from "./time";

const n = (v: unknown) => Number(v ?? 0) || 0;
const MAX_PROPOSALS_PER_RUN = 15;

interface Camp {
  campaign_id: number;
  ad_name: string | null;
  campaign_status: string;
  campaign_budget: number;
  roas_target: number | null;
  tool_paused_at: string | null;
  throttled_at: string | null;
  restore_budget: number | null;
  econ: Econ | null;
  scale_block?: string | null; // lý do lần quét trước không tăng ngân sách dù đã chạm ngân sách
}

/** Mô tả ngưỡng ROAS dùng trong lý do đề xuất. */
function targetLabel(c: Camp, useProfit: boolean): string {
  const t = ruleTarget(c, useProfit);
  if (t == null) return "ngưỡng";
  if (!(useProfit && c.econ?.target)) return String(t);
  return `${t} (${c.econ.target_label ?? `ROAS cho lãi ${c.econ.profit_pct}%`})`;
}

async function ongoingCampaigns(shopId: number): Promise<Camp[]> {
  const { data, error } = await db()
    .from("ads_campaigns")
    .select("*") // gồm scale_block nếu đã chạy migration 0016
    .eq("shop_id", shopId)
    .eq("campaign_status", "ongoing")
    .eq("autopilot_excluded", false);
  if (error) throw new Error(error.message);
  return (data ?? []).map((c) => ({
    ...c,
    campaign_id: Number(c.campaign_id),
    campaign_budget: n(c.campaign_budget),
    roas_target: c.roas_target == null ? null : n(c.roas_target),
    restore_budget: c.restore_budget == null ? null : n(c.restore_budget),
    econ: (c.econ ?? null) as Econ | null,
  }));
}

/**
 * Khung giờ tốt của shop: giờ có lượng click ≥ 80% trung vị và ROAS ≥ ROAS chung,
 * tính từ N tuần gần nhất, bỏ ngày sale (ngày đôi). Luôn gồm 0h. Ví dụ Magickids: 0h, 8h–10h.
 */
export async function goodHours(shopId: number, weeks: number): Promise<Set<number>> {
  const today = vnDate();
  const { data } = await db()
    .from("ads_shop_hourly")
    .select("date, hour, clicks, expense, broad_gmv")
    .eq("shop_id", shopId)
    .gte("date", addDays(today, -weeks * 7))
    .lt("date", today)
    .limit(5000);
  const agg = Array.from({ length: 24 }, () => ({ c: 0, e: 0, g: 0 }));
  for (const r of data ?? []) {
    const [, m, d] = String(r.date).split("-").map(Number);
    if (m === d) continue;
    agg[r.hour].c += n(r.clicks);
    agg[r.hour].e += n(r.expense);
    agg[r.hour].g += n(r.broad_gmv);
  }
  const totalE = agg.reduce((s, a) => s + a.e, 0);
  if (totalE === 0) return new Set([0, 8, 9, 10]);
  const overall = agg.reduce((s, a) => s + a.g, 0) / totalE;
  const median = agg.map((a) => a.c).sort((a, b) => a - b)[12];
  const good = new Set<number>([0]);
  agg.forEach((a, h) => {
    if (a.c >= median * 0.8 && a.e > 0 && a.g / a.e >= overall) good.add(h);
  });
  return good;
}

/** Giờ bắt đầu của khung tốt liền mạch đang chứa giờ hiện tại. */
function windowStart(good: Set<number>, hour: number): number {
  let h = hour;
  while (h > 0 && good.has(h - 1)) h--;
  return h;
}

interface DayRow {
  date: string;
  exp: number;
  gmv: number;
}

/**
 * Chi và GMV theo ngày của các chiến dịch trong [from, to]. Lấy từ ads_campaign_daily; ngày `to`
 * (thường là hôm qua) chưa có số ngày thì cộng từ số theo giờ.
 */
async function campaignDays(shopId: number, ids: number[], from: string, to: string): Promise<Map<number, DayRow[]>> {
  const out = new Map<number, DayRow[]>();
  if (!ids.length) return out;
  const add = (id: number, r: DayRow) => {
    if (!out.has(id)) out.set(id, []);
    out.get(id)!.push(r);
  };
  const data = await allRows(() =>
    db()
      .from("ads_campaign_daily")
      .select("campaign_id, date, expense, broad_gmv")
      .eq("shop_id", shopId)
      .gte("date", from)
      .lte("date", to)
      .in("campaign_id", ids)
      .order("campaign_id")
      .order("date")
  );
  let hasTo = false;
  for (const r of data) {
    if (r.date === to) hasTo = true;
    add(Number(r.campaign_id), { date: r.date, exp: n(r.expense), gmv: n(r.broad_gmv) });
  }
  if (!hasTo) {
    const hourly = await allRows(() =>
      db()
        .from("ads_campaign_hourly")
        .select("campaign_id, expense, broad_gmv")
        .eq("shop_id", shopId)
        .eq("date", to)
        .in("campaign_id", ids)
        .order("campaign_id")
        .order("hour")
    );
    const agg = new Map<number, DayRow>();
    for (const r of hourly) {
      const id = Number(r.campaign_id);
      const a = agg.get(id) ?? { date: to, exp: 0, gmv: 0 };
      a.exp += n(r.expense);
      a.gmv += n(r.broad_gmv);
      agg.set(id, a);
    }
    for (const [id, a] of agg) add(id, a);
  }
  return out;
}

/** Chi trung bình/ngày của 7 ngày thường gần nhất (bỏ ngày sale lớn, trước sale, sale nhỏ). null = chưa có số. */
export function normalDailySpend(s: ShopSettings, days: DayRow[]): number | null {
  const normal = days
    .filter((d) => saleTier(s, d.date) === "thuong" && d.exp > 0)
    .sort((a, b) => (a.date < b.date ? 1 : -1))
    .slice(0, 7);
  if (!normal.length) return null;
  return normal.reduce((t, d) => t + d.exp, 0) / normal.length;
}

/** Ngân sách khởi điểm 0h của một chiến dịch: % chi ngày thường, làm tròn 10k, thấp nhất start_budget. */
export function startBudgetFor(s: ShopSettings, normalDaily: number | null): number {
  if (!normalDaily || !s.params.start_share_pct) return s.start_budget;
  const v = Math.round((normalDaily * s.params.start_share_pct) / 100 / 10_000) * 10_000;
  return Math.max(s.start_budget, v);
}

/**
 * Tốc độ tiêu (đ/giờ) ước từ giờ đang chạy (và giờ trước nếu giờ này mới bắt đầu), cùng mức tiêu
 * mạnh nhất trong 3 giờ gần nhất (dùng khi chiến dịch đã hết tiền nên đang tiêu ~0).
 */
export function burnRate(rows: { hour: number; expense: number }[], hour: number, minute: number): { rate: number; peak: number } {
  const at = (h: number) => rows.find((r) => r.hour === h)?.expense ?? 0;
  const cur = at(hour);
  const m = Math.max(5, minute);
  const rate = m >= 10 || hour === 0 ? cur / (m / 60) : (at(hour - 1) + cur) / (1 + m / 60);
  const peak = Math.max(rate, at(hour - 1), at(hour - 2), at(hour - 3));
  return { rate, peak };
}

/**
 * Lãi của đơn từ quảng cáo hôm qua + hôm nay, % trên doanh thu thực nhận (sau hủy, hoàn), dùng giá vốn thật
 * (cả hàng xả). Chiến dịch chưa có số kinh tế dùng số trung bình shop. Kèm tỷ trọng chi hôm nay theo nhóm.
 */
export function portfolioProfit(
  camps: { campaign_id: number; econ: (Econ & { class?: string }) | null }[],
  today: Map<number, { expense: number; gmv: number }[]>,
  history: Map<number, DayRow[]>,
  yesterday: string,
  shopEcon: Econ | null,
  fee: number
): { pct: number | null; share: Partial<Record<ProductClass, number>> } {
  let profit = 0;
  let net = 0;
  let total = 0;
  const byClass: Partial<Record<ProductClass, number>> = {};
  for (const c of camps) {
    const rows = today.get(c.campaign_id) ?? [];
    const expT = rows.reduce((t, r) => t + r.expense, 0);
    const gmvT = rows.reduce((t, r) => t + r.gmv, 0);
    const y = (history.get(c.campaign_id) ?? []).find((d) => d.date === yesterday);
    const e = c.econ?.margin ? c.econ : shopEcon;
    total += expT;
    const cls = (c.econ?.class ?? "thuong") as ProductClass;
    byClass[cls] = (byClass[cls] ?? 0) + expT;
    if (!e?.margin) continue;
    const g = gmvT + (y?.gmv ?? 0);
    const x = expT + (y?.exp ?? 0);
    profit += g * e.margin - x * fee;
    net += g * (1 - e.cancel_rate) * (1 - e.return_rate);
  }
  const share: Partial<Record<ProductClass, number>> = {};
  if (total > 0) for (const [k, v] of Object.entries(byClass)) share[k as ProductClass] = (v ?? 0) / total;
  return { pct: net > 0 ? (100 * profit) / net : null, share };
}

// ---------------------------------------------------------------------------
// F2: luật trong ngày (chạy sau mỗi lần thu số liệu)
// ---------------------------------------------------------------------------

export async function evaluateIntraday(shopId: number): Promise<{ proposals: number; skipped?: string; stuck?: number }> {
  const s = await loadSettings(shopId);
  const blocked = automationBlocked(s);
  if (blocked) return { proposals: 0, skipped: blocked };
  const p = s.params;
  const today = vnDate();
  const hour = vnHour();
  // Ngày cao điểm (sale lớn + các ngày ngay trước): tăng nhanh hơn, chỉ siết khi lỗ (dưới hòa vốn).
  const peak = isPeakDay(s, today);
  const tierNote = peak ? ` [${SALE_TIER_VI[saleTier(s, today)]}]` : "";
  const scaleRatio = peak ? p.peak_scale_spend_ratio : p.scale_spend_ratio;
  const scaleStepPct = peak ? p.peak_scale_step_pct : p.scale_step_pct;
  const cooldown = peak ? p.peak_cooldown_minutes : p.cooldown_minutes;

  const camps = await ongoingCampaigns(shopId);
  if (!camps.length) return { proposals: 0 };
  const hourly = await allRows(() =>
    db()
      .from("ads_campaign_hourly")
      .select("campaign_id, hour, clicks, expense, broad_gmv")
      .eq("shop_id", shopId)
      .eq("date", today)
      .in("campaign_id", camps.map((c) => c.campaign_id))
      .gt("impression", 0)
      .order("campaign_id")
      .order("hour")
  );
  const byCamp = new Map<number, { hour: number; clicks: number; expense: number; gmv: number }[]>();
  for (const r of hourly) {
    const id = Number(r.campaign_id);
    if (!byCamp.has(id)) byCamp.set(id, []);
    byCamp.get(id)!.push({ hour: r.hour, clicks: n(r.clicks), expense: n(r.expense), gmv: n(r.broad_gmv) });
  }

  // Khung giờ tốt: anh đặt trong Cài đặt; để trống thì tự tính từ số liệu.
  const good = s.good_hours.length ? new Set(s.good_hours) : await goodHours(shopId, p.good_hours_weeks);
  const { data: restores } = await db()
    .from("autopilot_actions")
    .select("campaign_id")
    .eq("shop_id", shopId)
    .eq("source", "rule:restore")
    .gte("created_at", new Date(vnDayStartUnix(today) * 1000).toISOString());
  const restoredToday = new Set((restores ?? []).map((r) => Number(r.campaign_id)));
  // Số 14 ngày trước: mức chi ngày thường (khởi điểm, "đầu ngày") và ROAS 3 ngày gần nhất.
  const history = await campaignDays(shopId, camps.map((c) => c.campaign_id), addDays(today, -14), addDays(today, -1));
  const minute = new Date().getUTCMinutes();
  // Lãi toàn hệ thống (hôm nay + hôm qua) và tỷ trọng chi theo nhóm hôm nay — cho sàn lãi.
  const { data: st } = await db().from("autopilot_settings").select("econ_summary").eq("shop_id", shopId).maybeSingle();
  const shopEcon = (st?.econ_summary?.shop ?? null) as Econ | null;
  const portfolio = portfolioProfit(camps, byCamp, history, addDays(today, -1), shopEcon, 1 + p.ad_fee_pct / 100);
  if (portfolio.pct != null && portfolio.pct < p.system_profit_floor_pct) {
    await sendAlertOnce(
      `floor:${shopId}:${today}`,
      `📉 <b>Lãi chung dưới sàn</b> — ${esc(shopName(shopId))}\nĐơn từ quảng cáo hôm qua + hôm nay lãi ${portfolio.pct.toFixed(1)}% (sàn ${p.system_profit_floor_pct}%). Tool chỉ còn tăng ngân sách cho mã tự nó lãi ≥ ${p.system_profit_floor_pct}%, không cắt gì.`,
      360
    );
  }

  const candidates: (ProposalInput & { priority: number; fast?: boolean })[] = [];
  const stuck = new Map<number, string>(); // chiến dịch chạm ngân sách mà không tăng → lý do
  for (const c of camps) {
    const rows = byCamp.get(c.campaign_id) ?? [];
    const exp = rows.reduce((s, r) => s + r.expense, 0);
    const gmv = rows.reduce((s, r) => s + r.gmv, 0);
    const roas = exp > 0 ? gmv / exp : 0;
    // Ngưỡng: ROAS theo lãi (giá vốn Pancake) nếu bật và tính được, ngược lại ROAS mục tiêu đang đặt.
    const useProfit = !!p.use_profit_roas;
    const target = ruleTarget(c, useProfit);
    const days = history.get(c.campaign_id) ?? [];
    const normalDaily = normalDailySpend(s, days);
    const startBudget = startBudgetFor(s, normalDaily);

    // Đang bị siết: chỉ xét nới lại khi sang khung giờ tốt kế tiếp (mỗi ngày nới 1 lần).
    if (c.throttled_at) {
      const throttledAt = Date.parse(c.throttled_at);
      const startOfWindow = Date.parse(`${today}T${String(windowStart(good, hour)).padStart(2, "0")}:00:00+07:00`);
      if (good.has(hour) && throttledAt < startOfWindow && !restoredToday.has(c.campaign_id)) {
        const back = Math.max(c.restore_budget ?? 0, startBudget);
        if (back > c.campaign_budget) candidates.push({
          priority: 1,
          shop_id: shopId,
          campaign_id: c.campaign_id,
          action: "change_budget",
          before: { budget: c.campaign_budget },
          after: { budget: back, restore: true },
          reason: `Vào khung giờ tốt (${hour}h): nới lại ngân sách đã siết lúc ${new Date(throttledAt + 7 * 3600_000).toISOString().slice(11, 16)}`,
          source: "rule:restore",
        });
      }
      continue;
    }

    // Tăng ngân sách: sắp tiêu hết (theo tỉ lệ đã tiêu hoặc theo tốc độ tiêu) và đang hiệu quả.
    if (c.campaign_budget > 0) {
      const { rate, peak: peakRate } = burnRate(rows, hour, minute);
      const left = c.campaign_budget - exp;
      const minutesLeft = rate > 0 ? (left / rate) * 60 : Infinity;
      const burning = minutesLeft <= p.burn_trigger_minutes;
      const exhausted = exp >= 0.95 * c.campaign_budget;
      // Ngôi sao (Chủ lực) tăng sớm hơn và mạnh hơn; nhóm khác theo nhịp thường (hoặc nhịp ngày cao điểm).
      const style = scaleStyle(c.econ?.class, p);
      // Nhóm Chủ lực / Thường dưới mục tiêu cơ cấu: tăng sớm và mạnh như Chủ lực.
      const boost = mixBoost(c.econ?.class, portfolio.share, p);
      const ratio = Math.min(scaleRatio, style.ratio, boost ? p.scale_core_spend_ratio : 1);
      const stepPct = Math.max(scaleStepPct, style.stepPct, boost ? p.scale_core_step_pct : 0);
      const nearFull = exp >= ratio * c.campaign_budget;
      // Đầu ngày Shopee ghi nhận đơn chậm: còn tiêu ít thì xét ROAS 3 ngày + ROAS gộp (3 ngày + hôm nay) ≥ hòa vốn.
      const last3 = days.filter((d) => d.date >= addDays(today, -3));
      const exp3 = last3.reduce((t, d) => t + d.exp, 0);
      const gmv3 = last3.reduce((t, d) => t + d.gmv, 0);
      const roas3 = exp3 > 0 ? gmv3 / exp3 : 0;
      const blended = exp3 + exp > 0 ? (gmv3 + gmv) / (exp3 + exp) : 0;
      const early = normalDaily != null && exp3 > 0 && exp < (normalDaily * p.early_spend_pct) / 100;
      // Ngưỡng tăng theo nhóm BCG (xem scaleTargetFor).
      const scaleT = useProfit ? scaleTargetFor(c.econ, p) : null;
      const tgt = scaleT?.target ?? target ?? p.cut_roas_floor * 2;
      const tgtLabel = scaleT?.target ? `${scaleT.target} (${scaleT.label})` : targetLabel(c, useProfit);
      // Xả kho: giá vốn coi như đã chi nên mốc dưới là chính ngưỡng nhóm, không phải hòa vốn.
      const breakeven = c.econ?.class === "xa_kho" ? tgt : c.econ?.breakeven ?? tgt * 0.6;
      // Phanh: đã tiêu kha khá mà ROAS hôm nay tụt sâu so với 7 ngày → tăng thêm chỉ mua lượt kém, thôi tăng.
      const last7 = days.filter((d) => d.date >= addDays(today, -7));
      const exp7 = last7.reduce((t, d) => t + d.exp, 0);
      const roas7 = exp7 > 0 ? last7.reduce((t, d) => t + d.gmv, 0) / exp7 : 0;
      const decayed = !early && p.scale_decay_pct > 0 && exp >= p.scale_decay_min_spend && roas7 > 0 && roas < (roas7 * p.scale_decay_pct) / 100;
      const roasOk = !decayed && (early ? roas3 >= tgt && blended >= breakeven : roas >= tgt);
      const econ = c.econ?.margin ? c.econ : shopEcon;
      const ownPct = econ && gmv > 0 ? (100 * (gmv * econ.margin - exp * (1 + p.ad_fee_pct / 100))) / (gmv * (1 - econ.cancel_rate) * (1 - econ.return_rate)) : null;
      const blocked = roasOk ? floorBlock(c.econ?.class, portfolio.pct, ownPct, portfolio.share, p) : null;
      if ((nearFull || burning) && roasOk && !blocked) {
        const fast = burning || exhausted;
        const step = Math.max(p.scale_min_step, (c.campaign_budget * stepPct) / 100);
        // Tiêu nhanh: thêm đủ tiêu tiếp burn_cover_hours giờ theo tốc độ hiện tại (trần mỗi lần fast_max_increase_pct).
        const cover = fast ? peakRate * p.burn_cover_hours : 0;
        const wanted = Math.round((c.campaign_budget + Math.max(step, cover)) / 1000) * 1000;
        const why = burning && rate > 0
          ? `đang tiêu ${vnd(Math.round(rate))}/giờ, còn ~${Math.max(0, Math.round(minutesLeft))} phút là hết`
          : `đã tiêu ${vnd(exp)} (${Math.round((exp / c.campaign_budget) * 100)}% ngân sách)`;
        const roasWhy = early
          ? `đầu ngày: ROAS 3 ngày ${roas3.toFixed(1)} ≥ ${tgtLabel}, gộp cả hôm nay ${blended.toFixed(1)} ≥ ${c.econ?.class === "xa_kho" ? "ngưỡng" : "hòa vốn"} ${breakeven.toFixed(1)}`
          : `ROAS hôm nay ${roas.toFixed(1)} ≥ ${tgtLabel}`;
        candidates.push({
          priority: 1,
          fast,
          shop_id: shopId,
          campaign_id: c.campaign_id,
          action: "change_budget",
          before: { budget: c.campaign_budget },
          after: { budget: wanted, ...(fast ? { fast: true } : {}) },
          reason: `${why[0].toUpperCase()}${why.slice(1)}; ${roasWhy}${tierNote}${boost ? `; ${boost}` : ""}`,
          source: "rule:scale_up",
        });
        continue;
      }
      // Đã chạm ngân sách mà không tăng: ghi lý do để báo anh (Telegram, dashboard).
      if (exhausted) {
        const prof = ownPct != null ? `, lãi hôm nay ~${Math.round(ownPct)}%` : "";
        stuck.set(
          c.campaign_id,
          decayed
            ? `ROAS hôm nay ${roas.toFixed(1)} tụt dưới ${p.scale_decay_pct}% ROAS 7 ngày (${roas7.toFixed(1)}): phanh, chờ ROAS hồi`
            : !roasOk
              ? early
                ? `đầu ngày: ROAS 3 ngày ${roas3.toFixed(1)} / gộp ${blended.toFixed(1)} chưa đạt ngưỡng ${tgtLabel}`
                : `ROAS hôm nay ${roas.toFixed(1)} < ngưỡng tăng ${tgtLabel}${prof}`
              : `${blocked}`
        );
      }
    }

    // Siết ngân sách (thay cho tạm dừng): khung W giờ đã trọn vẹn, đủ click, ROAS quá thấp. Không phạt dựa trên 1–2 giờ.
    const W = Math.max(3, p.cut_window_hours);
    if (hour >= W) {
      const win = rows.filter((r) => r.hour >= hour - W && r.hour < hour);
      const wClicks = win.reduce((s, r) => s + r.clicks, 0);
      const wExp = win.reduce((s, r) => s + r.expense, 0);
      const wGmv = win.reduce((s, r) => s + r.gmv, 0);
      const wRoas = wExp > 0 ? wGmv / wExp : 0;
      // Ngày cao điểm: chỉ siết khi cả khung và cả ngày đều dưới hòa vốn (đang lỗ), không theo mức lãi mục tiêu.
      const breakeven = useProfit ? c.econ?.breakeven ?? null : null;
      const threshold = peak && breakeven ? breakeven : target ? target * p.cut_roas_ratio : p.cut_roas_floor;
      // Cần chi tiêu ở ≥ 2 giờ trong khung: một giờ đột biến không đủ để phạt.
      const activeHours = win.filter((r) => r.expense > 0).length;
      // Và cả ngày cũng kém: chiến dịch cả ngày vẫn tốt thì không dừng vì vài giờ chững.
      const dayThreshold = peak && breakeven ? breakeven : target ? target * p.cut_day_roas_ratio : p.cut_roas_floor * 2;
      // Siết thay cho tạm dừng: ngân sách = đã chi hôm nay + một khoản nhỏ, chiến dịch vẫn "đang chạy" nên sửa lại được.
      const throttleTo = Math.ceil((exp + p.throttle_buffer) / 1000) * 1000;
      const lower = c.campaign_budget === 0 || throttleTo < c.campaign_budget;
      if (lower && activeHours >= 2 && wClicks >= p.cut_min_clicks && wExp >= p.cut_min_expense && wRoas < threshold && roas < dayThreshold) {
        const next = [...good].filter((h) => h > hour).sort((a, b) => a - b)[0];
        candidates.push({
          priority: 0,
          shop_id: shopId,
          campaign_id: c.campaign_id,
          action: "change_budget",
          before: { budget: c.campaign_budget },
          after: { budget: throttleTo, throttle: true, restore_budget: c.campaign_budget > 0 ? c.campaign_budget : s.start_budget },
          reason: `Siết ngân sách: ${W} giờ qua (${hour - W}h–${hour - 1}h) ${wClicks} click, chi ${vnd(wExp)}, ROAS ${wRoas.toFixed(1)} < ${threshold.toFixed(1)} (${peak && breakeven ? "hòa vốn" : `${Math.round(p.cut_roas_ratio * 100)}% của ${targetLabel(c, useProfit)}`})${tierNote}; cả ngày chi ${vnd(exp)}, ROAS ${roas.toFixed(1)}. Nới lại ${next != null ? `lúc ${next}h` : "lúc 0h"}.`,
          source: "rule:throttle",
        });
      }
    }
  }

  candidates.sort((a, b) => a.priority - b.priority);
  let made = 0;
  for (const cand of candidates) {
    if (made >= MAX_PROPOSALS_PER_RUN) break;
    const fast = !!cand.fast;
    const cid = Number(cand.campaign_id);
    if (await recentlyTouched(shopId, cid, fast ? Math.min(cooldown, p.fast_cooldown_minutes) : cooldown)) continue;
    const maxEdits = fast ? Math.max(editsLimit(s, today), p.fast_max_edits_per_day) : editsLimit(s, today);
    if ((await editsToday(shopId, cid)) >= maxEdits) {
      if (cand.source === "rule:scale_up") stuck.set(cid, `đã chỉnh ${maxEdits} lần hôm nay (giới hạn số lần chỉnh/ngày)`);
      continue;
    }
    const { priority: _p, fast: _f, ...input } = cand;
    await propose(input, p.proposal_ttl_minutes, s);
    made++;
  }
  await reportStuck(s, camps, stuck, byCamp);
  return { proposals: made, stuck: stuck.size };
}

/**
 * Chiến dịch chạm ngân sách mà tool không tăng: lưu lý do (ads_campaigns.scale_block) và báo Telegram
 * tối đa 3 giờ một lần (7h–23h), kèm các lần tăng bị trần/cầu chì chặn trong 2 giờ qua.
 */
async function reportStuck(
  s: ShopSettings,
  camps: Camp[],
  stuck: Map<number, string>,
  byCamp: Map<number, { hour: number; expense: number; gmv: number }[]>
) {
  const shopId = s.shop_id;
  const nowIso = new Date().toISOString();
  for (const c of camps) {
    const why = stuck.get(c.campaign_id) ?? null;
    if ((why ?? null) === (c.scale_block ?? null)) continue;
    if (!("scale_block" in c)) break; // chưa chạy migration 0016: bỏ qua lưu, vẫn báo Telegram
    await db()
      .from("ads_campaigns")
      .update({ scale_block: why, scale_block_at: why ? nowIso : null })
      .eq("shop_id", shopId)
      .eq("campaign_id", c.campaign_id);
  }
  const { data: capped } = await db()
    .from("autopilot_actions")
    .select("campaign_id, error")
    .eq("shop_id", shopId)
    .eq("source", "rule:scale_up")
    .eq("status", "skipped")
    .gte("created_at", new Date(Date.now() - 2 * 3600_000).toISOString());
  for (const r of capped ?? []) if (r.campaign_id && r.error && !stuck.has(Number(r.campaign_id))) stuck.set(Number(r.campaign_id), String(r.error));
  const hour = vnHour();
  if (!stuck.size || hour < 7) return;
  const lines = [...stuck.entries()].map(([id, why]) => {
    const c = camps.find((x) => x.campaign_id === id);
    const rows = byCamp.get(id) ?? [];
    const exp = rows.reduce((t, r) => t + r.expense, 0);
    const name = (c?.ad_name ?? `#${id}`).slice(0, 45);
    return `• <b>${esc(name)}</b> — đã tiêu ${vnd(exp)}/${vnd(c?.campaign_budget ?? 0)}\n   Lý do: ${esc(why)}`;
  });
  await sendAlertOnce(
    `stuck:${shopId}:${vnDate()}:${Math.floor(hour / 3)}`,
    `⏸️ <b>${stuck.size} chiến dịch hết ngân sách nhưng tool chưa tăng</b> — ${esc(s.shop_name ?? String(shopId))}\n${lines.join("\n")}\n\nMuốn đẩy mã nào: chuyển nhóm trên trang Vòng đời sản phẩm, hạ ngưỡng lãi của nhóm trong Cài đặt, hoặc tự tăng trên Shopee.`,
    170
  );
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
    .select("campaign_id, campaign_status, campaign_budget, tool_paused_at, throttled_at, restore_budget")
    .eq("shop_id", shopId)
    .in("campaign_status", ["ongoing", "paused"])
    .eq("autopilot_excluded", false);
  if (error) throw new Error(error.message);
  // 0h của ngày cao điểm (sale lớn hoặc ngày ngay trước): KHÔNG hạ ngân sách — 0h là giờ bán tốt nhất.
  const today = vnDate();
  const peak = isPeakDay(s, today);
  // Ngân sách khởi điểm riêng từng chiến dịch theo mức chi ngày thường của nó.
  const history = await campaignDays(shopId, (data ?? []).map((c) => Number(c.campaign_id)), addDays(today, -14), addDays(today, -1));
  const items: { campaign_id: number; action: ProposalInput["action"]; before: any; after: any }[] = [];
  for (const c of data ?? []) {
    const id = Number(c.campaign_id);
    const budget = n(c.campaign_budget);
    const start = startBudgetFor(s, normalDailySpend(s, history.get(id) ?? []));
    if (c.campaign_status === "paused" && c.tool_paused_at) {
      items.push({ campaign_id: id, action: "resume", before: { status: "paused" }, after: { status: "ongoing" } });
    }
    const canEdit = c.campaign_status === "ongoing" || c.tool_paused_at;
    if (peak) {
      // Chỉ nới các chiến dịch đã siết về mức trước khi siết.
      const back = Math.max(n(c.restore_budget), start);
      if (c.throttled_at && canEdit && budget < back) {
        items.push({ campaign_id: id, action: "change_budget", before: { budget }, after: { budget: back, restore: true } });
      }
      continue;
    }
    // Về mức khởi điểm: hạ chiến dịch đang cao hơn, nới chiến dịch đã siết (chiến dịch anh đặt thấp hơn thì giữ).
    const throttled = !!c.throttled_at && budget !== start;
    const resetThis = throttled || budget > start || (budget === 0 && s.reset_unlimited);
    if (resetThis && canEdit) {
      items.push({ campaign_id: id, action: "change_budget", before: { budget }, after: { budget: start, restore: true } });
    }
  }
  const group = await proposeGroup(
    shopId,
    peak
      ? `0h ${SALE_TIER_VI[saleTier(s)]}: giữ nguyên ngân sách, chỉ nới chiến dịch đã siết và bật lại chiến dịch tool đã dừng`
      : "Reset 0h: ngân sách về mức khởi điểm, nới chiến dịch đã siết, bật lại chiến dịch tool đã dừng",
    items,
    "rule:reset",
    peak
      ? "Ngày cao điểm không hạ ngân sách lúc 0h; trong ngày tăng nhanh hơn (tối đa +100%/lần) khi còn lãi, chỉ siết khi dưới hòa vốn."
      : `${s.params.start_share_pct ? `Khởi điểm = ${s.params.start_share_pct}% chi trung bình 7 ngày thường của từng chiến dịch (thấp nhất ${vnd(s.start_budget)})` : `Ngân sách khởi điểm ${vnd(s.start_budget)}`}; trong ngày tool tự tăng khi tiêu nhanh mà còn lãi.${s.reset_unlimited ? "" : " (Chiến dịch không giới hạn ngân sách giữ nguyên; bật 'Áp dụng cho chiến dịch không giới hạn' trong Cài đặt để đưa vào.)"}`,
    10 * 60,
    // Reset 0h tự chạy (anh không thức duyệt lúc 0h), tóm tắt trong báo cáo 8h.
    { autoExecute: s.mode === "auto" || !!s.params.auto_reset }
  );
  return { items: items.length, group: group?.id ?? null };
}

// ---------------------------------------------------------------------------
// Đặt hạn mức cho chiến dịch đang "không giới hạn" (campaign_budget = 0)
// ---------------------------------------------------------------------------

/**
 * Hạn mức = chi trung bình/ngày của 7 ngày thường gần nhất (bỏ ngày đôi), làm tròn lên 10k,
 * thấp nhất bằng ngân sách khởi điểm. Gửi một đề xuất gộp để anh duyệt.
 */
export async function proposeCapsForUnlimited(shopId: number, source = "rule:caps") {
  const s = await loadSettings(shopId);
  const blocked = automationBlocked(s);
  if (blocked) return { skipped: blocked };
  const camps = (await ongoingCampaigns(shopId)).filter((c) => c.campaign_budget === 0);
  if (!camps.length) return { items: 0 };
  const today = vnDate();
  const days: string[] = [];
  for (let d = 1; days.length < 7 && d <= 14; d++) {
    const date = addDays(today, -d);
    const [, m, dd] = date.split("-").map(Number);
    if (m !== dd && saleTier(s, date) === "thuong") days.push(date);
  }
  const data = await allRows(() =>
    db()
      .from("ads_campaign_daily")
      .select("campaign_id, date, expense, broad_gmv")
      .eq("shop_id", shopId)
      .in("date", days)
      .in("campaign_id", camps.map((c) => c.campaign_id))
      .order("campaign_id")
      .order("date")
  );
  const sum = new Map<number, { e: number; g: number }>();
  for (const r of data) {
    const a = sum.get(Number(r.campaign_id)) ?? { e: 0, g: 0 };
    a.e += n(r.expense);
    a.g += n(r.broad_gmv);
    sum.set(Number(r.campaign_id), a);
  }
  const items = camps.map((c) => {
    const a = sum.get(c.campaign_id) ?? { e: 0, g: 0 };
    const avg = a.e / days.length;
    const budget = Math.max(s.start_budget, Math.ceil(avg / 10_000) * 10_000);
    return {
      campaign_id: c.campaign_id,
      action: "change_budget" as const,
      before: { budget: 0 },
      after: {
        budget,
        why: `chi TB ${vnd(avg)}/ngày, ROAS ${a.e > 0 ? (a.g / a.e).toFixed(1) : "-"} (${days.length} ngày thường)`,
      },
    };
  });
  const group = await proposeGroup(
    shopId,
    `Đặt hạn mức cho ${items.length} chiến dịch đang KHÔNG GIỚI HẠN ngân sách`,
    items,
    source,
    `Hạn mức = chi trung bình/ngày ngày thường, làm tròn lên 10k, thấp nhất ${vnd(s.start_budget)}. Sau đó luật tự tăng khi chiến dịch tiêu hết mà vẫn hiệu quả.`,
    24 * 60
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
  // Chiến dịch có sản phẩm đang thử giá: giữ nguyên ROAS mục tiêu tới khi chấm xong (mỗi mã một thay đổi một lúc).
  const { data: priceRows } = await db().from("price_tests").select("campaign_ids").eq("shop_id", shopId).eq("status", "running");
  const frozen = new Set((priceRows ?? []).flatMap((r: any) => (r.campaign_ids ?? []).map(Number)));
  const camps = (await ongoingCampaigns(shopId)).filter((c) => c.roas_target != null && c.roas_target > 0 && !frozen.has(c.campaign_id));
  if (!camps.length) return { items: 0 };
  const data = await allRows(() =>
    db()
      .from("ads_campaign_daily")
      .select("campaign_id, date, expense, broad_gmv")
      .eq("shop_id", shopId)
      .gte("date", addDays(today, -8))
      .lte("date", addDays(today, -2))
      .in("campaign_id", camps.map((c) => c.campaign_id))
      .order("campaign_id")
      .order("date")
  );
  const recentFrom = addDays(today, -4);
  const agg = new Map<number, { e: number; g: number; re: number; rg: number }>();
  for (const r of data) {
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
    const a = agg.get(c.campaign_id) ?? { e: 0, g: 0, re: 0, rg: 0 };
    const target = c.roas_target!;
    const week = a.e > 0 ? a.g / a.e : 0;
    const recent = a.re > 0 ? a.rg / a.re : week;
    let next: number | null = null;
    let why = "";
    const goal = p.use_profit_roas ? c.econ?.target ?? null : null;
    if (goal) {
      // Theo lãi: đưa ROAS mục tiêu dần về mức cần cho lãi mong muốn (mỗi lần tối đa ±maxChange).
      const econ = c.econ!;
      const basis = `ROAS mục tiêu ${econ.target_label ?? `cho lãi ${econ.profit_pct}%`}: ${goal}, hòa vốn ${econ.breakeven ?? "-"} (giá vốn ${Math.round(econ.cost_ratio * 100)}% giá bán${econ.source === "shop" ? ", số TB shop" : ""})`;
      if (target > goal * 1.1) {
        // Đặt cao quá: Shopee thầu quá chặt, mất đơn có lãi. Không cần điều kiện chi tiêu (chiến dịch "không chạy" thường do đây).
        next = Math.max(goal, target * (1 - maxChange));
        why = `Đang đặt cao hơn mức cần. ${basis}`;
      } else if (target < goal * 0.9 && a.e >= p.roas_min_week_expense && week < goal) {
        // Đặt thấp và thực tế dưới mức lãi: nâng để thầu chặt hơn.
        next = Math.min(goal, target * (1 + maxChange));
        why = `ROAS 7 ngày ${week.toFixed(1)} dưới mức lãi. ${basis}`;
      }
    } else if (a.e < p.roas_min_week_expense) {
      continue;
    } else if (week < target * p.roas_low_ratio && recent < target * p.roas_low_ratio) {
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
    p.use_profit_roas ? `Đề xuất ROAS mục tiêu theo lãi mong muốn ${p.profit_target_pct}%` : "Đề xuất ROAS mục tiêu (theo 7 ngày D-8…D-2)",
    items,
    "rule:roas_target",
    `Mỗi lần đổi tối đa ±${p.roas_max_change_pct}%, đi dần qua nhiều ngày để Shopee kịp học. Giá vốn lấy từ Pancake; sửa lãi mong muốn trong Cài đặt.`,
    12 * 60,
    // Anh không thức canh (12/11/2026): đổi ROAS trong giới hạn ±15% tự chạy, tóm tắt trong báo cáo 8h.
    { autoExecute: s.mode === "auto" || !!p.auto_roas }
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
