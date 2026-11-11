import { db } from "../supabase";
import { cancelReturnRates, shopFees, type FeeStats } from "./fees";
import { costOf, loadCostMap } from "./pancake";
import { REASON_VI } from "./returns";
import { INVALID_STATUSES, ordersBetween } from "./report";
import { loadSettings } from "./settings";

/**
 * Kinh tế của một sản phẩm, quy về 1đ GMV quảng cáo (cùng thước đo với ROAS Shopee).
 * Đơn hủy không có tiền và không tốn giá vốn. Phần bị hoàn tiền mất doanh thu; hàng gửi trả về thì thu lại giá vốn,
 * chỉ hoàn tiền (không gửi trả) thì mất cả hàng:
 *   c = tỉ lệ hủy, r = tiền hoàn / giá bán, rb = phần hoàn có hàng gửi về / giá bán,
 *   rf = phí hoàn (đơn quay về × phí mỗi đơn) / giá bán, f = phí nạp ví QC
 *   margin  = (1 − c) × (tiền về × (1 − r) − giá vốn/giá bán × (1 − rb) − chi phí khác/giá bán − rf)   lãi trước QC trên 1đ GMV
 *   allow   = margin − (1 − c) × (1 − r) × lãi mong muốn                                            tiền QC thật được phép
 *   ROAS hòa vốn = (1 + f) / margin;  ROAS theo lãi = (1 + f) / allow (null nếu không thể đạt lãi mong muốn)
 *   (ROAS tính theo chi Shopee báo; chi thật = chi báo × (1 + f))
 * Tỉ lệ tiền về lấy từ escrow thật (đã trừ mọi phí Shopee, voucher shop, thuế, ship shop chịu).
 */
export interface Econ {
  price: number; // giá bán TB/đơn vị (30 ngày)
  units: number; // số đơn vị bán (30 ngày, đơn không hủy)
  cost_ratio: number; // giá vốn / giá bán
  payout: number; // tiền về / giá bán
  payout_estimated: boolean; // chưa đủ escrow thật
  cancel_rate: number;
  return_rate: number; // tiền hoàn / giá bán
  return_back_rate: number; // phần hoàn có hàng gửi về shop
  return_source: "item" | "shop"; // tỉ lệ hoàn của chính sản phẩm hay TB shop
  return_fee_ratio?: number; // phí hoàn / giá bán
  ad_fee_pct?: number; // phí nạp ví QC (%)
  margin: number; // lãi trước QC trên 1đ GMV
  breakeven: number | null; // ROAS hòa vốn
  target: number | null; // ROAS cần để đạt lãi mong muốn
  profit_pct: number; // lãi mong muốn (% giá bán) lúc tính
  source: "item" | "shop"; // số liệu của chính sản phẩm hay TB shop
  at: string;
}

export interface EconCtx {
  payout: number;
  payoutEstimated: boolean;
  cancelRate: number;
  returnRate: number;
  returnBackRate: number;
  returnSource?: "item" | "shop";
  returnFeeRatio?: number;
  adFeePct?: number;
  profitPct: number;
  extraPerUnit: number;
}

/** Sản phẩm cần ít nhất ngần này doanh số (đơn không hủy, 45→10 ngày trước) để dùng tỉ lệ hoàn riêng. */
const MIN_ITEM_RETURN_SELLING = 3_000_000;

const MIN_UNITS = 5;
const MIN_COVERAGE = 0.5;
const round1 = (x: number) => Math.round(x * 10) / 10;
const r3 = (x: number) => Math.round(x * 1000) / 1000;

export function econFrom(
  a: { revenue: number; units: number; costedRevenue: number; cogs: number },
  ctx: EconCtx,
  source: Econ["source"]
): Econ | null {
  if (a.units <= 0 || a.costedRevenue <= 0) return null;
  const price = a.revenue / a.units;
  const costRatio = a.cogs / a.costedRevenue;
  const keepC = 1 - ctx.cancelRate;
  const rf = ctx.returnFeeRatio ?? 0;
  const fee = 1 + (ctx.adFeePct ?? 0) / 100;
  const margin =
    keepC * (ctx.payout * (1 - ctx.returnRate) - costRatio * (1 - ctx.returnBackRate) - ctx.extraPerUnit / price - rf);
  const allow = margin - keepC * (1 - ctx.returnRate) * (ctx.profitPct / 100);
  return {
    price: Math.round(price),
    units: a.units,
    cost_ratio: r3(costRatio),
    payout: r3(ctx.payout),
    payout_estimated: ctx.payoutEstimated,
    cancel_rate: r3(ctx.cancelRate),
    return_rate: r3(ctx.returnRate),
    return_back_rate: r3(ctx.returnBackRate),
    return_source: ctx.returnSource ?? "shop",
    return_fee_ratio: Math.round(rf * 10000) / 10000,
    ad_fee_pct: ctx.adFeePct ?? 0,
    margin: r3(margin),
    breakeven: margin > 0 ? round1(fee / margin) : null,
    target: allow > 0 ? round1(fee / allow) : null,
    profit_pct: ctx.profitPct,
    source,
    at: new Date().toISOString(),
  };
}

export interface EconSummary {
  fees: FeeStats;
  cancel_rate: number;
  cancel_before_ship_rate?: number;
  failed_delivery_rate?: number;
  return_rate: number;
  return_back_rate: number;
  return_source: "returns" | "status";
  return_reasons: { reason: string; label: string; ratio: number }[];
  rate_orders: number;
  shop: Econ;
  campaigns: number;
  item_level: number;
  at: string;
}

/**
 * Tính kinh tế cho mọi chiến dịch của shop từ đơn 30 ngày + giá vốn + phí thật, lưu vào ads_campaigns.econ
 * và tóm tắt vào autopilot_settings.econ_summary. Sản phẩm bán ít (< 5 đơn vị) hoặc thiếu giá vốn quá nửa
 * thì dùng số trung bình shop.
 */
export async function computeEconomics(shopId: number) {
  const s = await loadSettings(shopId);
  const costs = await loadCostMap(shopId);
  if (!costs.size) return { skipped: "Chưa có giá vốn (đồng bộ Pancake trước)" };
  const fees = await shopFees(shopId);
  const rates = await cancelReturnRates(shopId);
  const now = Math.floor(Date.now() / 1000);
  const orders = await ordersBetween(shopId, now - 30 * 86400, now);

  type Agg = { revenue: number; units: number; costedRevenue: number; cogs: number; costedUnits: number };
  const empty = (): Agg => ({ revenue: 0, units: 0, costedRevenue: 0, cogs: 0, costedUnits: 0 });
  const byItem = new Map<number, Agg>();
  const shop = empty();
  for (const o of orders) {
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
  const ctx: EconCtx = {
    payout: fees.payout,
    payoutEstimated: fees.estimated,
    cancelRate: rates.cancel,
    returnRate: rates.ret,
    returnBackRate: rates.retBack,
    returnFeeRatio: rates.keptSelling > 0 ? (rates.returnEvents * s.params.return_fee_per_order) / rates.keptSelling : 0,
    adFeePct: s.params.ad_fee_pct,
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
    // Tỉ lệ hoàn riêng của sản phẩm khi đủ doanh số, ngược lại dùng TB shop.
    const ret = ids.reduce((m, id) => {
      const a = rates.items.get(id);
      if (a) {
        m.selling += a.selling;
        m.refund += a.refund;
        m.back += a.back;
      }
      return m;
    }, { selling: 0, refund: 0, back: 0 });
    const itemCtx: EconCtx =
      ret.selling >= MIN_ITEM_RETURN_SELLING
        ? { ...ctx, returnRate: Math.min(1, ret.refund / ret.selling), returnBackRate: Math.min(1, ret.back / ret.selling), returnSource: "item" }
        : ctx;
    const econ = ok ? econFrom(agg, itemCtx, "item") : null;
    if (econ) item++;
    await db()
      .from("ads_campaigns")
      .update({ econ: econ ?? { ...shopEcon, units: agg.units } })
      .eq("shop_id", shopId)
      .eq("campaign_id", c.campaign_id);
  }
  const summary: EconSummary = {
    fees,
    cancel_rate: r3(rates.cancel),
    cancel_before_ship_rate: r3(rates.cancelBeforeShip),
    failed_delivery_rate: r3(rates.failedDelivery),
    return_rate: r3(rates.ret),
    return_back_rate: r3(rates.retBack),
    return_source: rates.source,
    return_reasons: rates.reasons.slice(0, 6).map((x) => ({ reason: x.reason, label: REASON_VI[x.reason] ?? x.reason, ratio: r3(x.ratio) })),
    rate_orders: rates.orders,
    shop: shopEcon,
    campaigns: camps?.length ?? 0,
    item_level: item,
    at: new Date().toISOString(),
  };
  await db().from("autopilot_settings").update({ econ_summary: summary }).eq("shop_id", shopId);
  return {
    campaigns: summary.campaigns,
    item_level: item,
    payout: r3(fees.payout),
    payout_orders: fees.orders,
    cancel_rate: summary.cancel_rate,
    return_rate: summary.return_rate,
    cost_ratio: shopEcon.cost_ratio,
    breakeven: shopEcon.breakeven,
    target: shopEcon.target,
  };
}

/** ROAS luật dùng: ROAS theo lãi nếu bật và tính được, ngược lại ROAS mục tiêu đang đặt. */
export function ruleTarget(c: { roas_target: number | null; econ?: Econ | null }, useProfit: boolean): number | null {
  if (useProfit && c.econ?.target) return c.econ.target;
  return c.roas_target;
}
