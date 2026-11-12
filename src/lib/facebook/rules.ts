/**
 * Nhân viên Facebook — luật đánh giá quảng cáo (hàm thuần, không gọi mạng, dễ test).
 * Ngưỡng lấy từ bản nháp "Luật chạy ads Facebook" (bản đồ: luat-ads-fb); sửa bằng biến FB_RULES (JSON).
 */

/** Phí thật trên số Meta: 1,1 thuế × 1,011 phí thẻ. */
export const META_FEE = 1.111;

export type FbRules = {
  /** Chi (số Meta, chưa nhân phí) từ mức này mà 0 đơn → đề xuất tắt. */
  pauseSpendNoOrder: number;
  /** Tỉ lệ chi thật / doanh thu tối đa để đề xuất tăng ngân sách. */
  scaleMaxRatio: number;
  /** Số ngày liên tiếp phải đạt tỉ lệ trên. */
  scaleDays: number;
  /** Số đơn tối thiểu mỗi ngày để tính là đạt (tránh 1 đơn may mắn). */
  scaleMinOrders: number;
  /** Mức tăng ngân sách đề xuất (0,2 = 20%). */
  scaleStep: number;
  /** Tỉ lệ chi / doanh thu mục tiêu. Trên mức này là "kém". */
  targetRatio: number;
  /** Chi tối thiểu để xếp hạng tốt/kém (bỏ quảng cáo chi quá ít). */
  rankMinSpend: number;
};

export const DEFAULT_RULES: FbRules = {
  pauseSpendNoOrder: 140_000,
  scaleMaxRatio: 0.18,
  scaleDays: 2,
  scaleMinOrders: 2,
  scaleStep: 0.2,
  targetRatio: 0.2,
  rankMinSpend: 200_000,
};

export function loadRules(env: string | undefined = process.env.FB_RULES): FbRules {
  if (!env) return DEFAULT_RULES;
  try {
    const o = JSON.parse(env);
    const r = { ...DEFAULT_RULES };
    for (const k of Object.keys(DEFAULT_RULES) as (keyof FbRules)[]) {
      const v = Number(o?.[k]);
      if (o?.[k] != null && Number.isFinite(v) && v >= 0) r[k] = v;
    }
    return r;
  } catch {
    return DEFAULT_RULES;
  }
}

/** Số của một quảng cáo trong một ngày. */
export type AdDay = {
  ngay: string;
  ad_id: string;
  account_id: string;
  account_name: string;
  campaign_name: string | null;
  adset_name: string | null;
  ad_name: string | null;
  /** Chi theo Meta (VND, chưa nhân phí). */
  spend: number;
  /** Đơn chốt (không hủy) trên Pancake gắn mã quảng cáo này. */
  orders: number;
  /** Doanh thu Pancake của các đơn đó. */
  revenue: number;
  /** Tài khoản CPAS (đơn về Shopee): đo bằng số mua Meta ghi nhận. */
  cpas: boolean;
  meta_purchases: number;
  meta_purchase_value: number;
};

export const realSpend = (spend: number) => Math.round(spend * META_FEE);

/** Đơn và doanh thu dùng để đánh giá: CPAS lấy số Meta, còn lại lấy Pancake. */
export function outcome(a: Pick<AdDay, "cpas" | "orders" | "revenue" | "meta_purchases" | "meta_purchase_value">) {
  return a.cpas ? { orders: a.meta_purchases, revenue: a.meta_purchase_value } : { orders: a.orders, revenue: a.revenue };
}

/** Chi thật / doanh thu. Không có doanh thu → null (vô cùng). */
export function ratio(a: AdDay): number | null {
  const { revenue } = outcome(a);
  return revenue > 0 ? realSpend(a.spend) / revenue : null;
}

export type Proposal = {
  kind: "pause" | "scale";
  ad: AdDay;
  reason: string;
};

/** Trong ngày: quảng cáo chi ≥ ngưỡng mà chưa có đơn → đề xuất tắt. */
export function pauseCandidates(today: AdDay[], rules: FbRules = DEFAULT_RULES): Proposal[] {
  return today
    .filter((a) => a.spend >= rules.pauseSpendNoOrder && outcome(a).orders === 0)
    .sort((x, y) => y.spend - x.spend)
    .map((ad) => ({
      kind: "pause" as const,
      ad,
      reason: `Chi ${fmtK(ad.spend)} hôm nay mà chưa có đơn (ngưỡng ${fmtK(rules.pauseSpendNoOrder)}).`,
    }));
}

/**
 * Tăng ngân sách: `scaleDays` ngày gần nhất (tính đến `lastDay`) ngày nào cũng có ≥ scaleMinOrders đơn
 * và tỉ lệ ≤ scaleMaxRatio.
 */
export function scaleCandidates(history: AdDay[], lastDay: string, rules: FbRules = DEFAULT_RULES): Proposal[] {
  const days = Array.from({ length: rules.scaleDays }, (_, i) => shiftDay(lastDay, -i));
  const byAd = new Map<string, Map<string, AdDay>>();
  for (const a of history) {
    if (!byAd.has(a.ad_id)) byAd.set(a.ad_id, new Map());
    byAd.get(a.ad_id)!.set(a.ngay, a);
  }
  const out: Proposal[] = [];
  for (const m of byAd.values()) {
    const rows = days.map((d) => m.get(d));
    if (rows.some((r) => !r)) continue;
    const ok = rows.every((r) => {
      const q = ratio(r!);
      return outcome(r!).orders >= rules.scaleMinOrders && q != null && q <= rules.scaleMaxRatio;
    });
    if (!ok) continue;
    const last = rows[0]!;
    const pct = rows.map((r) => `${Math.round(ratio(r!)! * 100)}%`).reverse().join(", ");
    out.push({
      kind: "scale",
      ad: last,
      reason: `${rules.scaleDays} ngày liền tỉ lệ chi/doanh thu ${pct} (≤ ${Math.round(rules.scaleMaxRatio * 100)}%). Đề xuất tăng ${Math.round(rules.scaleStep * 100)}% ngân sách.`,
    });
  }
  return out.sort((x, y) => (ratio(x.ad) ?? 9) - (ratio(y.ad) ?? 9));
}

export type AccountSum = {
  account_id: string;
  account_name: string;
  cpas: boolean;
  spend: number;
  spendReal: number;
  orders: number;
  revenue: number;
  ratio: number | null;
};

export function sumByAccount(rows: AdDay[]): AccountSum[] {
  const m = new Map<string, AccountSum>();
  for (const a of rows) {
    const s =
      m.get(a.account_id) ??
      ({ account_id: a.account_id, account_name: a.account_name, cpas: a.cpas, spend: 0, spendReal: 0, orders: 0, revenue: 0, ratio: null } as AccountSum);
    const o = outcome(a);
    s.spend += a.spend;
    s.orders += o.orders;
    s.revenue += o.revenue;
    m.set(a.account_id, s);
  }
  for (const s of m.values()) {
    s.spendReal = realSpend(s.spend);
    s.ratio = s.revenue > 0 ? s.spendReal / s.revenue : null;
  }
  return [...m.values()].sort((x, y) => y.spend - x.spend);
}

/** 3 tốt nhất / 3 kém nhất theo tỉ lệ, chỉ xét quảng cáo chi ≥ rankMinSpend. */
export function rankAds(rows: AdDay[], rules: FbRules = DEFAULT_RULES, n = 3) {
  const eligible = rows.filter((a) => a.spend >= rules.rankMinSpend);
  const key = (a: AdDay) => ratio(a) ?? Number.POSITIVE_INFINITY;
  const sorted = [...eligible].sort((x, y) => key(x) - key(y) || y.spend - x.spend);
  const best = sorted.filter((a) => key(a) <= rules.targetRatio).slice(0, n);
  const worst = sorted
    .filter((a) => key(a) > rules.targetRatio && !best.includes(a))
    .reverse()
    .slice(0, n);
  return { best, worst };
}

export function shiftDay(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function fmtK(n: number): string {
  return `${Math.round(n / 1000).toLocaleString("vi-VN")}k`;
}
