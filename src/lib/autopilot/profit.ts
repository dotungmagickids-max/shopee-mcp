import { db } from "../supabase";
import { costOf, loadCostMap } from "./pancake";
import { INVALID_STATUSES, ordersBetween, payoutRatio } from "./report";
import { loadSettings } from "./settings";

/**
 * Kinh tế của một sản phẩm, quy về 1đ GMV quảng cáo (cùng thước đo với ROAS Shopee):
 *   margin   = (1 − tỉ lệ hủy) × (tỉ lệ tiền về − tỉ lệ giá vốn − chi phí khác/giá)   lãi trước QC trên 1đ GMV
 *   allow    = margin − (1 − tỉ lệ hủy) × lãi mong muốn                              tiền QC được phép trên 1đ GMV
 *   ROAS hòa vốn = 1 / margin;  ROAS theo lãi = 1 / allow (null nếu không thể đạt lãi mong muốn)
 */
export interface Econ {
  price: number; // giá bán TB/đơn vị (30 ngày)
  units: number; // số đơn vị bán (30 ngày, đơn hợp lệ)
  cost_ratio: number; // giá vốn / giá bán
  payout: number; // tiền về / khách trả
  cancel_rate: number;
  margin: number; // lãi trước QC trên 1đ GMV
  breakeven: number | null; // ROAS hòa vốn
  target: number | null; // ROAS cần để đạt lãi mong muốn
  profit_pct: number; // lãi mong muốn (% giá bán) lúc tính
  source: "item" | "shop"; // số liệu của chính sản phẩm hay TB shop
  at: string;
}

const MIN_UNITS = 5;
const MIN_COVERAGE = 0.5;
const round1 = (x: number) => Math.round(x * 10) / 10;

export function econFrom(
  a: { revenue: number; units: number; costedRevenue: number; cogs: number },
  ctx: { payout: number; cancelRate: number; profitPct: number; extraPerUnit: number },
  source: Econ["source"]
): Econ | null {
  if (a.units <= 0 || a.costedRevenue <= 0) return null;
  const price = a.revenue / a.units;
  const costRatio = a.cogs / a.costedRevenue;
  const keep = 1 - ctx.cancelRate;
  const margin = keep * (ctx.payout - costRatio - ctx.extraPerUnit / price);
  const allow = margin - keep * (ctx.profitPct / 100);
  return {
    price: Math.round(price),
    units: a.units,
    cost_ratio: Math.round(costRatio * 1000) / 1000,
    payout: Math.round(ctx.payout * 1000) / 1000,
    cancel_rate: Math.round(ctx.cancelRate * 1000) / 1000,
    margin: Math.round(margin * 1000) / 1000,
    breakeven: margin > 0 ? round1(1 / margin) : null,
    target: allow > 0 ? round1(1 / allow) : null,
    profit_pct: ctx.profitPct,
    source,
    at: new Date().toISOString(),
  };
}

/**
 * Tính kinh tế cho mọi chiến dịch của shop từ đơn 30 ngày + giá vốn, lưu vào ads_campaigns.econ.
 * Sản phẩm bán ít (< 5 đơn vị) hoặc thiếu giá vốn quá nửa thì dùng số trung bình shop.
 */
export async function computeEconomics(shopId: number) {
  const s = await loadSettings(shopId);
  const costs = await loadCostMap(shopId);
  if (!costs.size) return { skipped: "Chưa có giá vốn (đồng bộ Pancake trước)" };
  const now = Math.floor(Date.now() / 1000);
  const orders = await ordersBetween(shopId, now - 30 * 86400, now);
  const counted = orders.filter((o) => o.order_status !== "UNPAID");
  const cancelled = counted.filter((o) => INVALID_STATUSES.includes(o.order_status ?? "")).length;
  const cancelRate = counted.length ? cancelled / counted.length : 0;
  const payout = await payoutRatio(shopId);

  type Agg = { revenue: number; units: number; costedRevenue: number; cogs: number; costedUnits: number };
  const empty = (): Agg => ({ revenue: 0, units: 0, costedRevenue: 0, cogs: 0, costedUnits: 0 });
  const byItem = new Map<number, Agg>();
  const shop = empty();
  for (const o of counted) {
    if (INVALID_STATUSES.includes(o.order_status ?? "")) continue;
    for (const it of (o.items ?? []) as any[]) {
      const qty = Number(it.qty ?? 1);
      const price = Number(it.price ?? 0);
      if (!(qty > 0) || !(price > 0)) continue;
      const id = Number(it.item_id);
      const a = byItem.get(id) ?? empty();
      const c = costOf(costs, it);
      for (const x of [a, shop]) {
        x.revenue += price * qty;
        x.units += qty;
        if (c != null) {
          x.costedRevenue += price * qty;
          x.cogs += c * qty;
          x.costedUnits += qty;
        }
      }
      byItem.set(id, a);
    }
  }
  const ctx = {
    payout,
    cancelRate,
    profitPct: s.params.profit_target_pct,
    extraPerUnit: s.params.extra_cost_per_unit,
  };
  const shopEcon = econFrom(shop, ctx, "shop");
  if (!shopEcon) return { skipped: "Không có đơn có giá vốn trong 30 ngày" };

  const { data: camps, error } = await db()
    .from("ads_campaigns")
    .select("campaign_id, item_ids, campaign_status")
    .eq("shop_id", shopId)
    .in("campaign_status", ["ongoing", "paused", "scheduled"]);
  if (error) throw new Error(error.message);
  let item = 0;
  for (const c of camps ?? []) {
    const ids: number[] = (c.item_ids ?? []).map(Number);
    const agg = ids.reduce<Agg>((m, id) => {
      const a = byItem.get(id);
      if (a) for (const k of Object.keys(m) as (keyof Agg)[]) m[k] += a[k];
      return m;
    }, empty());
    const ok = agg.units >= MIN_UNITS && agg.costedUnits / agg.units >= MIN_COVERAGE;
    const econ = ok ? econFrom(agg, ctx, "item") : null;
    if (econ) item++;
    await db()
      .from("ads_campaigns")
      .update({ econ: econ ?? { ...shopEcon, units: agg.units } })
      .eq("shop_id", shopId)
      .eq("campaign_id", c.campaign_id);
  }
  return {
    campaigns: camps?.length ?? 0,
    item_level: item,
    shop: { breakeven: shopEcon.breakeven, target: shopEcon.target, cost_ratio: shopEcon.cost_ratio, payout, cancel_rate: cancelRate },
  };
}

/** ROAS luật dùng: ROAS theo lãi nếu bật và tính được, ngược lại ROAS mục tiêu đang đặt. */
export function ruleTarget(c: { roas_target: number | null; econ?: Econ | null }, useProfit: boolean): number | null {
  if (useProfit && c.econ?.target) return c.econ.target;
  return c.roas_target;
}
