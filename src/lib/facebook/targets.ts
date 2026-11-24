/**
 * FB Magic Tool — Mục tiêu quảng cáo: so chi, doanh thu và tỉ lệ quảng cáo/doanh thu với mục tiêu ngày, tháng;
 * tính hôm nay dự chi bao nhiêu và còn phải lên thêm bao nhiêu quảng cáo. Hàm thuần, không gọi mạng.
 * Mọi số tiền mục tiêu và số chi trong file này là CHI THẬT (số Meta × 1,111), trừ khi tên ghi rõ "Meta".
 */
import { META_FEE } from "./rules";

export type Targets = {
  /** Mục tiêu chi thật cả tháng (đ). null = chưa đặt. */
  month_budget: number | null;
  /** Mục tiêu chi thật mỗi ngày (đ). null = tự tính từ mục tiêu tháng. */
  day_budget: number | null;
  /** Mục tiêu chi thật / doanh thu, vd 0,2 = 20%. */
  ratio: number;
  /** Ngân sách/ngày (số Meta, đ) của một quảng cáo mới, dùng để đổi "còn thiếu" ra số quảng cáo cần lên. */
  ad_budget: number;
  /** Ngày này mục tiêu là 0 (nghỉ, không chạy). Chỉ đặt qua khoảng ngày. */
  zeroDay?: boolean;
};
export const DEFAULT_TARGETS: Targets = { month_budget: null, day_budget: null, ratio: 0.2, ad_budget: 65_000 };

/** Mục tiêu cho một khoảng ngày (bảng fb_target_periods). Tiền là chi thật. */
export type TargetPeriod = { id: number; tu: string; den: string; day_budget: number; ratio: number | null; note: string | null };

/**
 * Mục tiêu áp cho một ngày: khoảng ngày chứa ngày đó (nhiều khoảng trùng thì lấy khoảng nhập sau cùng, tức id lớn
 * nhất) thắng mục tiêu ngày chung; không có khoảng nào thì giữ mục tiêu chung. Trả về mục tiêu đã gộp và khoảng đang áp.
 */
export function targetsForDay(day: string, t: Targets, periods: TargetPeriod[]): { targets: Targets; period: TargetPeriod | null } {
  const hit = periods.filter((p) => p.tu <= day && day <= p.den).sort((a, b) => b.id - a.id)[0] ?? null;
  if (!hit) return { targets: t, period: null };
  // Khoảng đặt 0đ (nghỉ) vẫn là mục tiêu hợp lệ: giữ đúng 0, không rơi về mục tiêu chung.
  return { targets: { ...t, day_budget: hit.day_budget, ratio: hit.ratio ?? t.ratio, zeroDay: hit.day_budget === 0 }, period: hit };
}

/** Các khoảng ngày bị trùng nhau (để báo anh), theo cặp id. */
export function overlaps(periods: TargetPeriod[]): [number, number][] {
  const out: [number, number][] = [];
  const xs = [...periods].sort((a, b) => a.tu.localeCompare(b.tu));
  for (let i = 0; i < xs.length; i++) for (let j = i + 1; j < xs.length; j++) if (xs[j].tu <= xs[i].den) out.push([xs[i].id, xs[j].id]);
  return out;
}

/**
 * Nháp kế hoạch được tính vào ngày nào: nháp có hẹn giờ chạy thì tính từ ngày hẹn trở đi; nháp không hẹn thì tính từ
 * hôm nay (lên là chạy). Ngày xem trước ngày bắt đầu của nháp thì không tính.
 */
export const draftCountsOn = (day: string, today: string, startTime: string | null): boolean => day >= (startTime ? startTime.slice(0, 10) : today);

/**
 * Một ngày của tháng. `revenue`, `orders` = doanh thu và đơn chốt của CẢ KÊNH Facebook trên Pancake (anh chốt
 * 23/11/2026: tỉ lệ tính trên số Pancake). `hasRevenue` = false khi đơn Pancake ngày đó chưa đồng bộ về; ngày đó
 * không được đưa vào tỉ lệ. `adRevenue` = phần doanh thu của đơn có gắn mã quảng cáo, chỉ để tham khảo.
 */
export type DayRow = { ngay: string; spendReal: number; revenue: number; orders: number; hasRevenue?: boolean; adRevenue?: number };
const counted = (d: DayRow) => d.hasRevenue !== false;

export const realOf = (meta: number) => Math.round(meta * META_FEE);
const ratioOf = (spend: number, revenue: number): number | null => (revenue > 0 ? spend / revenue : null);

export function daysInMonth(day: string): number {
  const [y, m] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

export type Plan = {
  month: {
    spent: number;
    revenue: number;
    orders: number;
    ratio: number | null;
    /** Chi thật của những ngày đã có doanh thu Pancake (mẫu số của tỉ lệ dùng đúng các ngày này). */
    spentWithRevenue: number;
    /** Ngày mới nhất đã có doanh thu Pancake; null = chưa ngày nào. */
    revenueThrough: string | null;
    adRevenue: number;
    target: number | null;
    /** Còn được chi tới hết tháng (âm = đã vượt). */
    left: number | null;
    /** Số ngày còn lại của tháng, tính cả hôm nay. */
    daysLeft: number;
    /** Mỗi ngày còn lại cần chi bao nhiêu để vừa đủ mục tiêu tháng (không tính số đã chi hôm nay). */
    needPerDay: number | null;
    /** Nếu giữ mức dự chi hôm nay tới hết tháng thì cả tháng chi bao nhiêu. */
    forecast: number | null;
  };
  today: {
    /** Dự chi hôm nay = (ngân sách ngày của quảng cáo đang bật + ngân sách các nháp kế hoạch) × 1,111. null = chưa đọc được phần đang bật từ Meta. */
    planned: number | null;
    plannedMeta: number | null;
    /** Phần đang thực chạy và phần kế hoạch (nháp chưa lên), đều là chi thật. */
    running: number | null;
    drafts: number;
    spentSoFar: number;
    target: number | null;
    /** Mục tiêu ngày lấy từ đâu: anh đặt riêng, hay chia từ mục tiêu tháng. */
    targetFrom: "day" | "month" | null;
    /** Mục tiêu − dự chi. Dương = còn thiếu, âm = đang dự chi vượt. */
    gap: number | null;
    /** Còn phải lên thêm bao nhiêu quảng cáo (mỗi cái ad_budget) để đủ mục tiêu ngày. */
    adsNeeded: number | null;
    /** Doanh thu hôm nay cần có để dự chi này đạt tỉ lệ mục tiêu. */
    revenueNeeded: number | null;
  };
  yesterday: { ngay: string; spent: number; revenue: number | null; ratio: number | null } | null;
  /** Tỉ lệ tháng so mục tiêu: true = đạt, false = vượt, null = chưa có doanh thu. */
  ratioOk: boolean | null;
};

const shift = (day: string, n: number): string => {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/**
 * `days` = các ngày của tháng hiện tại (có thể thiếu ngày, có thể gồm hôm nay đang chạy dở).
 * `activeMetaDaily` = tổng ngân sách ngày (số Meta) của nhóm/chiến dịch đang bật; null nếu chưa đọc được.
 * `draftMetaDaily` = tổng ngân sách ngày (số Meta) của các nháp kế hoạch chưa lên.
 */
export function buildPlan(today: string, days: DayRow[], activeMetaDaily: number | null, t: Targets, draftMetaDaily = 0): Plan {
  const prefix = today.slice(0, 7);
  const inMonth = days.filter((d) => d.ngay.startsWith(prefix) && d.ngay <= today);
  const sum = (f: (d: DayRow) => number, xs = inMonth) => xs.reduce((s, d) => s + f(d), 0);
  const spent = sum((d) => d.spendReal);
  const withRevenue = inMonth.filter(counted);
  const revenue = sum((d) => d.revenue, withRevenue);
  const spentWithRevenue = sum((d) => d.spendReal, withRevenue);
  const spentBeforeToday = sum((d) => d.spendReal, inMonth.filter((d) => d.ngay < today));
  const spentSoFar = sum((d) => d.spendReal, inMonth.filter((d) => d.ngay === today));
  const daysLeft = daysInMonth(today) - Number(today.slice(8, 10)) + 1;

  const target = t.month_budget && t.month_budget > 0 ? t.month_budget : null;
  const needPerDay = target == null ? null : Math.round((target - spentBeforeToday) / daysLeft);
  const running = activeMetaDaily == null ? null : realOf(activeMetaDaily);
  const draftsReal = realOf(Math.max(0, draftMetaDaily));
  const planned = running == null ? null : running + draftsReal;

  const fixedDay = t.zeroDay || (t.day_budget != null && t.day_budget > 0);
  const dayTarget = fixedDay ? (t.day_budget ?? 0) : needPerDay != null ? Math.max(0, needPerDay) : null;
  const targetFrom: Plan["today"]["targetFrom"] = fixedDay ? "day" : needPerDay != null ? "month" : null;
  const gap = dayTarget == null || planned == null ? null : dayTarget - planned;
  const perAd = realOf(Math.max(1, t.ad_budget));
  const adsNeeded = gap == null ? null : gap > 0 ? Math.ceil(gap / perAd) : 0;

  const y = shift(today, -1);
  const yRow = days.find((d) => d.ngay === y);
  const ratio = ratioOf(spentWithRevenue, revenue);
  return {
    month: {
      spent,
      revenue,
      orders: sum((d) => d.orders, withRevenue),
      ratio,
      spentWithRevenue,
      revenueThrough: withRevenue.length ? withRevenue[withRevenue.length - 1].ngay : null,
      adRevenue: sum((d) => d.adRevenue ?? 0),
      target,
      left: target == null ? null : target - spent,
      daysLeft,
      needPerDay,
      forecast: planned == null ? null : spentBeforeToday + planned * daysLeft,
    },
    today: {
      planned,
      plannedMeta: activeMetaDaily == null ? null : activeMetaDaily + Math.max(0, draftMetaDaily),
      running,
      drafts: draftsReal,
      spentSoFar,
      target: dayTarget,
      targetFrom,
      gap,
      adsNeeded,
      revenueNeeded: planned == null || t.ratio <= 0 ? null : Math.round(planned / t.ratio),
    },
    yesterday: yRow
      ? counted(yRow)
        ? { ngay: y, spent: yRow.spendReal, revenue: yRow.revenue, ratio: ratioOf(yRow.spendReal, yRow.revenue) }
        : { ngay: y, spent: yRow.spendReal, revenue: null, ratio: null }
      : null,
    ratioOk: ratio == null ? null : ratio <= t.ratio,
  };
}

/**
 * Các ngày của tháng (từ ngày 1 tới hôm qua) chưa có số chi quảng cáo. Thường là ngày chưa được thu số;
 * cũng có thể là ngày thật sự không chi đồng nào.
 */
export function missingSpendDays(today: string, days: DayRow[]): string[] {
  const have = new Set(days.filter((d) => d.spendReal > 0).map((d) => d.ngay));
  const out: string[] = [];
  for (let d = `${today.slice(0, 7)}-01`; d < today; d = shift(d, 1)) if (!have.has(d)) out.push(d);
  return out;
}

/** Ô nhập tiền: "200tr", "6,5 triệu", "65k", "65.000", "65000" → đồng. Sai dạng hoặc ≤ 0 → null. */
export function parseMoney(input: unknown): number | null {
  const s = String(input ?? "").trim().toLowerCase().replace(/đ|vnd|\s/g, "");
  if (!s) return null;
  const m = /^([\d.,]+)(tr|triệu|trieu|m|k|n|nghìn|nghin)?$/.exec(s);
  if (!m) return null;
  const unit = m[2] ?? "";
  // Có đơn vị (tr, k): dấu phẩy/chấm là phần thập phân. Không đơn vị: dấu là phân cách hàng nghìn.
  const n = unit ? Number(m[1].replace(",", ".")) : Number(m[1].replace(/[.,]/g, ""));
  if (!Number.isFinite(n) || n <= 0) return null;
  const mul = /^(tr|triệu|trieu|m)$/.test(unit) ? 1_000_000 : unit ? 1_000 : 1;
  return Math.round(n * mul);
}

/** Ô nhập phần trăm: "20", "20%", "17,5" hoặc tỉ lệ "0,2" → 0,2. Ngoài khoảng 1%–100% → null. */
export function parseRatio(input: unknown): number | null {
  const n = Number(String(input ?? "").replace("%", "").replace(",", ".").trim());
  if (!Number.isFinite(n) || n <= 0) return null;
  const r = n >= 1 ? n / 100 : n;
  return r >= 0.01 && r <= 1 ? r : null;
}

/** Nhóm thực sự đang chạy: cả nhóm và chiến dịch đều ACTIVE. Nhóm bật mà chiến dịch tắt thì không tiêu tiền. */
export const isRunning = (r: { adset_status?: string; campaign_status?: string }): boolean => r.adset_status === "ACTIVE" && r.campaign_status === "ACTIVE";

/**
 * Tổng ngân sách ngày (số Meta) từ danh sách nhóm đang bật. Chiến dịch CBO (ngân sách ở chiến dịch) chỉ tính một lần
 * dù có nhiều nhóm; còn lại cộng ngân sách từng nhóm. Nhóm không có ngân sách ngày (ngân sách trọn đời) bị bỏ qua
 * và đếm riêng để báo.
 */
export function sumActiveBudgets(adsets: { adset_daily: number | null; campaign_id: string | null; campaign_daily: number | null }[]): { metaDaily: number; adsets: number; skipped: number } {
  const cbo = new Map<string, number>();
  let total = 0;
  let skipped = 0;
  for (const a of adsets) {
    if (a.campaign_daily && a.campaign_id) cbo.set(a.campaign_id, a.campaign_daily);
    else if (a.adset_daily) total += a.adset_daily;
    else skipped += 1;
  }
  for (const v of cbo.values()) total += v;
  return { metaDaily: total, adsets: adsets.length, skipped };
}
