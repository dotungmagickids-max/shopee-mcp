/**
 * FB Magic Tool — Phần 2: đánh giá quảng cáo (hàm thuần, không gọi mạng, dễ test).
 * Đặc tả: D:\Magic OS\docs\FB-MAGIC-TOOL-DAC-TA.md (anh chốt 21/11/2026).
 */
import { META_FEE } from "./rules";

export type Level = "ad" | "adset" | "campaign";

/** Trần chi thật / doanh thu của một mã. */
export type Ceiling = { profit_ceiling: number; breakeven: number };
export const DEFAULT_CEILING: Ceiling = { profit_ceiling: 0.2, breakeven: 0.36 };

/** Chi từ mức này (chi thật, đã × 1,111) mà 0 đơn → gợi ý tắt. */
export const PAUSE_SPEND_NO_ORDER = 150_000;
/** Hàng còn dưới số ngày này → không scale. */
export const MIN_STOCK_DAYS_TO_SCALE = 3;
/** Cần ít nhất ngần này đơn mới gợi ý scale (tránh 1 đơn may mắn). */
export const MIN_ORDERS_TO_SCALE = 2;

/**
 * Mã sản phẩm trong tên quảng cáo theo quy ước `MÃ-Pxx-Vxx`; nhiều mã nối bằng dấu chấm.
 * "BD26011.BD24066-P01-V01" → ["BD26011", "BD24066"]. Không theo quy ước thì tìm mã dạng 2–3 chữ + 5 số.
 */
export function codesFromName(name: string | null | undefined): string[] {
  const s = String(name ?? "").toUpperCase().trim();
  const head = /^([A-Z0-9.]+?)-P\d+/.exec(s)?.[1];
  const parts = head ? head.split(".").filter((x) => /^[A-Z]{1,4}\d{3,}$/.test(x)) : [];
  if (parts.length) return [...new Set(parts)];
  return [...new Set(s.match(/[A-Z]{2,3}\d{5}/g) ?? [])];
}

/** Trần áp cho một nhóm mã: lấy trần chặt nhất (thấp nhất) trong các mã; không có dòng riêng thì dùng '*'. */
export function ceilingFor(codes: string[], table: Map<string, Ceiling>): Ceiling {
  const base = table.get("*") ?? DEFAULT_CEILING;
  const hits = codes.map((c) => table.get(c)).filter((x): x is Ceiling => !!x);
  if (!hits.length) return base;
  return {
    profit_ceiling: Math.min(...hits.map((h) => h.profit_ceiling)),
    breakeven: Math.min(...hits.map((h) => h.breakeven)),
  };
}

export type Color = "green" | "yellow" | "red" | "none";

/** Xanh dưới trần lãi, vàng giữa trần lãi và hòa vốn, đỏ vượt hòa vốn. Có chi mà không doanh thu → đỏ. */
export function colorOf(spendReal: number, revenue: number, c: Ceiling): Color {
  if (revenue <= 0) return spendReal > 0 ? "red" : "none";
  const r = spendReal / revenue;
  if (r < c.profit_ceiling) return "green";
  if (r <= c.breakeven) return "yellow";
  return "red";
}

export type Suggestion = { action: "pause" | "keep" | "scale" | "reduce"; reason: string };

const k = (n: number) => `${Math.round(n / 1000).toLocaleString("vi-VN")}k`;
const pct = (x: number) => `${Math.round(x * 100)}%`;

/** Gợi ý tắt / giữ / scale kèm lý do (đặc tả mục "Gợi ý tự động"). */
export function suggest(r: { spendReal: number; orders: number; revenue: number; stockDays: number | null; ceiling: Ceiling }): Suggestion {
  const { spendReal, orders, revenue, stockDays, ceiling } = r;
  if (orders === 0 && spendReal >= PAUSE_SPEND_NO_ORDER) {
    return { action: "pause", reason: `Chi ${k(spendReal)} mà 0 đơn (ngưỡng ${k(PAUSE_SPEND_NO_ORDER)})` };
  }
  if (orders === 0 || revenue <= 0) return { action: "keep", reason: `Chưa có đơn, chi ${k(spendReal)} còn dưới ngưỡng tắt` };
  const ratio = spendReal / revenue;
  if (ratio > ceiling.breakeven) {
    return { action: "reduce", reason: `Chi/DT ${pct(ratio)} vượt hòa vốn ${pct(ceiling.breakeven)}: giảm hoặc tắt` };
  }
  if (ratio < ceiling.profit_ceiling) {
    if (stockDays != null && stockDays < MIN_STOCK_DAYS_TO_SCALE) {
      return { action: "keep", reason: `Lãi (${pct(ratio)}) nhưng hàng chỉ còn ~${Math.max(0, Math.floor(stockDays))} ngày: không scale` };
    }
    if (orders < MIN_ORDERS_TO_SCALE) return { action: "keep", reason: `Chi/DT ${pct(ratio)} tốt nhưng mới ${orders} đơn` };
    return { action: "scale", reason: `Chi/DT ${pct(ratio)} dưới trần lãi ${pct(ceiling.profit_ceiling)}, ${orders} đơn` };
  }
  return { action: "keep", reason: `Chi/DT ${pct(ratio)} giữa trần lãi và hòa vốn` };
}

/** Một quảng cáo trong khoảng ngày, đã ghép Meta + Pancake. */
export type AdRow = {
  account_id: string;
  account_name: string;
  ad_id: string;
  ad_name: string | null;
  adset_id: string | null;
  adset_name: string | null;
  campaign_id: string | null;
  campaign_name: string | null;
  page_id: string | null;
  status: string;
  adset_status: string;
  campaign_status: string;
  adset_daily: number | null;
  campaign_daily: number | null;
  spend: number; // số Meta
  messages: number;
  orders: number;
  revenue: number;
};

export type EvalRow = {
  level: Level;
  id: string;
  name: string;
  account_id: string;
  account_name: string;
  campaign_name: string | null;
  adset_name: string | null;
  status: string;
  /** Ngân sách ngày đang áp (của nhóm hoặc chiến dịch), và nơi nó nằm. */
  budget: number | null;
  budget_level: "adset" | "campaign" | null;
  budget_id: string | null;
  spend: number;
  spendReal: number;
  messages: number;
  costPerMessage: number | null;
  orders: number;
  revenue: number;
  ratio: number | null;
  codes: string[];
  stockDays: number | null;
  ceiling: Ceiling;
  color: Color;
  suggestion: Suggestion;
  ads: number;
};

export const real = (spend: number) => Math.round(spend * META_FEE);

/** Gom quảng cáo theo cấp (quảng cáo / nhóm / chiến dịch), tính màu và gợi ý. */
export function evaluate(
  ads: AdRow[],
  level: Level,
  ceilings: Map<string, Ceiling>,
  stockDays: (code: string) => number | null
): EvalRow[] {
  const groups = new Map<string, AdRow[]>();
  for (const a of ads) {
    const key = level === "ad" ? a.ad_id : level === "adset" ? a.adset_id ?? a.ad_id : a.campaign_id ?? a.ad_id;
    const g = groups.get(key);
    if (g) g.push(a);
    else groups.set(key, [a]);
  }
  const out: EvalRow[] = [];
  for (const [id, xs] of groups) {
    const a = xs[0];
    const spend = xs.reduce((s, x) => s + x.spend, 0);
    const messages = xs.reduce((s, x) => s + x.messages, 0);
    const orders = xs.reduce((s, x) => s + x.orders, 0);
    const revenue = xs.reduce((s, x) => s + x.revenue, 0);
    const spendReal = real(spend);
    const codes = [...new Set(xs.flatMap((x) => codesFromName(x.ad_name)))];
    const days = codes.map(stockDays).filter((d): d is number => d != null);
    const ceiling = ceilingFor(codes, ceilings);
    const stock = days.length ? Math.min(...days) : null;

    // Ngân sách: ABO ở nhóm, CBO ở chiến dịch. Cấp chiến dịch ABO = tổng ngân sách các nhóm.
    let budget: number | null = null;
    let budget_level: EvalRow["budget_level"] = null;
    let budget_id: string | null = null;
    if (a.campaign_daily) {
      budget = a.campaign_daily;
      budget_level = "campaign";
      budget_id = a.campaign_id;
    } else if (level !== "campaign" && a.adset_daily) {
      budget = a.adset_daily;
      budget_level = "adset";
      budget_id = a.adset_id;
    } else if (level === "campaign") {
      const perSet = new Map<string, number>();
      for (const x of xs) if (x.adset_id && x.adset_daily) perSet.set(x.adset_id, x.adset_daily);
      budget = perSet.size ? [...perSet.values()].reduce((s, v) => s + v, 0) : null;
    }

    out.push({
      level,
      id,
      name: (level === "ad" ? a.ad_name : level === "adset" ? a.adset_name : a.campaign_name) ?? id,
      account_id: a.account_id,
      account_name: a.account_name,
      campaign_name: a.campaign_name,
      adset_name: a.adset_name,
      status: level === "ad" ? a.status : level === "adset" ? a.adset_status : a.campaign_status,
      budget,
      budget_level,
      budget_id,
      spend,
      spendReal,
      messages,
      costPerMessage: messages > 0 ? Math.round(spendReal / messages) : null,
      orders,
      revenue,
      ratio: revenue > 0 ? spendReal / revenue : null,
      codes,
      stockDays: stock,
      ceiling,
      color: colorOf(spendReal, revenue, ceiling),
      suggestion: suggest({ spendReal, orders, revenue, stockDays: stock, ceiling }),
      ads: xs.length,
    });
  }
  return out.sort((x, y) => y.spendReal - x.spendReal);
}

/** Khoảng ngày theo nút chọn nhanh (giờ VN). "3" = 3 ngày gần nhất tính cả hôm nay. */
export function rangeOf(preset: string, today: string, addDays: (d: string, n: number) => string): { since: string; until: string } {
  if (preset === "today") return { since: today, until: today };
  if (preset === "yesterday") {
    const y = addDays(today, -1);
    return { since: y, until: y };
  }
  const n = Number(preset);
  if ([3, 7, 14, 30].includes(n)) return { since: addDays(today, -(n - 1)), until: today };
  const y = addDays(today, -1);
  return { since: y, until: y };
}
