import { db } from "../supabase";
import { cancelReturnRates, shopFees, type FeeStats } from "./fees";
import { classify, daysOfStock, targetForClass, type ClassInput, type ProductClass } from "./classes";
import { costOf, loadCostMap, loadProductStats, normSku, productCode, type ProductStats } from "./pancake";
import { callShopee, chunk } from "./shopee-call";
import { vnDate } from "./time";
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
  // Nhóm hàng (từ 11/2026): target ở trên là ROAS mục tiêu của nhóm
  class?: ProductClass;
  class_source?: "auto" | "manual";
  class_reason?: string;
  auto_class?: ProductClass;
  target_label?: string;
  product_code?: string | null;
  price_source?: "current" | "orders"; // giá bán: giá đang bán (theo cơ cấu phân loại 30 ngày) hay TB đơn 30 ngày
  stock?: number | null;
  days_of_stock?: number | null;
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
/**
 * Giá đang bán của từng phân loại (SKU chuẩn hóa → giá khách trả hiện tại, đã gồm khuyến mãi), 8 sản phẩm/lượt.
 * Lỗi đọc sản phẩm nào thì bỏ qua sản phẩm đó (dùng giá trung bình đơn 30 ngày).
 */
async function currentPrices(shopId: number, itemIds: number[]): Promise<Map<number, Map<string, number>>> {
  const out = new Map<number, Map<string, number>>();
  for (const part of chunk(itemIds, 8)) {
    await Promise.all(
      part.map(async (id) => {
        try {
          const res = await callShopee(shopId, "product.get_model_list", { item_id: id });
          const m = new Map<string, number>();
          for (const x of res.response?.model ?? []) {
            const sku = normSku(x.model_sku);
            const p = Number(x.price_info?.[0]?.current_price ?? 0);
            if (sku && p > 0) m.set(sku, p);
          }
          if (m.size) out.set(id, m);
        } catch {
          /* dùng giá đơn 30 ngày */
        }
      })
    );
  }
  return out;
}

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
  const itemCodes = new Map<number, Set<string>>(); // item Shopee → mã sản phẩm Pancake (từ SKU đã bán)
  // Cơ cấu phân loại đã bán của từng sản phẩm (SKU → số lượng, giá vốn): để tính lại theo giá đang bán.
  const itemLines = new Map<number, Map<string, { qty: number; cost: number | null; revenue: number }>>();
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
      const code = productCode(it.model_sku) ?? productCode(it.item_sku);
      if (code) itemCodes.set(id, (itemCodes.get(id) ?? new Set()).add(code));
      const sku = normSku(it.model_sku) || normSku(it.item_sku);
      if (sku) {
        const lines = itemLines.get(id) ?? new Map();
        const l = lines.get(sku) ?? { qty: 0, cost: c, revenue: 0 };
        l.qty += qty;
        l.revenue += price * qty;
        lines.set(sku, l);
        itemLines.set(id, lines);
      }
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
    .select("campaign_id, item_ids, campaign_status, ad_name, start_time")
    .eq("shop_id", shopId)
    .in("campaign_status", ["ongoing", "paused", "scheduled"]);
  if (error) throw new Error(error.message);
  const stats = await loadProductStats();
  const { data: manual } = await db().from("product_classes").select("item_id, manual_class").eq("shop_id", shopId);
  const manualMap = new Map((manual ?? []).filter((m) => m.manual_class).map((m) => [Number(m.item_id), m.manual_class as ProductClass]));
  const month = Number(vnDate().slice(5, 7));
  // Giá đang bán (anh đổi giá / khuyến mãi là có hiệu lực ngay, không chờ 30 ngày đơn mới).
  const campItems = [...new Set((camps ?? []).flatMap((c) => (c.item_ids ?? []).map(Number)))].filter((id) => itemLines.has(id));
  const current = await currentPrices(shopId, campItems);
  const repriced = new Map<number, Agg>();
  for (const id of campItems) {
    const prices = current.get(id);
    const old = byItem.get(id);
    if (!prices?.size || !old) continue;
    const a = empty();
    let hit = 0;
    for (const [sku, l] of itemLines.get(id)!) {
      const p = prices.get(sku);
      const rev = p ? p * l.qty : l.revenue;
      if (p) hit += l.qty;
      a.revenue += rev;
      a.units += l.qty;
      if (l.cost != null) {
        a.costedRevenue += rev;
        a.cogs += l.cost * l.qty;
        a.costedUnits += l.qty;
      }
    }
    if (hit >= a.units * 0.5) repriced.set(id, a);
  }
  const counts: Record<string, number> = {};
  let item = 0;
  for (const c of camps ?? []) {
    const ids: number[] = (c.item_ids ?? []).map(Number);
    const priceSource = ids.some((id) => repriced.has(id)) ? "current" : "orders";
    const agg = ids.reduce<Agg>((m, id) => {
      const a = repriced.get(id) ?? byItem.get(id);
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
    const base: Econ = econ ?? { ...shopEcon, units: agg.units };

    // Nhóm hàng: mã sản phẩm từ SKU đã bán, không có thì từ tên chiến dịch (vd "... QD26001").
    const codes = new Set<string>();
    for (const id of ids) for (const code of itemCodes.get(id) ?? []) codes.add(code);
    if (!codes.size) {
      const m = /\b([A-Z]{2,4}\d{5,6})\b/.exec(String(c.ad_name ?? "").toUpperCase());
      if (m) codes.add(m[1]);
    }
    const st = [...codes].map((code) => stats.get(code)).filter(Boolean) as ProductStats[];
    const stock = st.length ? st.reduce((x, y) => x + y.stock, 0) : null;
    const pancakeDaily = st.reduce((x, y) => x + y.sellingAvg, 0);
    const created = st.map((y) => y.created).filter((t): t is number => t != null);
    const campaignAgeDays = Number(c.start_time) > 0 ? (Date.now() / 1000 - Number(c.start_time)) / 86400 : null;
    const input: ClassInput = {
      units30: agg.units,
      stock,
      dailySales: pancakeDaily > 0 ? pancakeDaily : agg.units / 30,
      categories: new Set(st.flatMap((y) => [...y.categories])),
      ageDays: created.length ? (Date.now() - Math.min(...created)) / 86400_000 : st.length ? null : campaignAgeDays,
      costRatio: econ ? econ.cost_ratio : null,
      month,
    };
    const auto = classify(input, s.params);
    const manualCls = ids.map((id) => manualMap.get(id)).find(Boolean);
    const cls = manualCls ?? auto.cls;
    const t = targetForClass(base, cls, s.params);
    const dos = daysOfStock(input);
    counts[cls] = (counts[cls] ?? 0) + 1;
    await db()
      .from("ads_campaigns")
      .update({
        econ: {
          ...base,
          target: t.target,
          target_label: t.label,
          class: cls,
          class_source: manualCls ? "manual" : "auto",
          class_reason: manualCls ? "Anh chọn" : auto.reason,
          auto_class: auto.cls,
          product_code: [...codes][0] ?? null,
          price_source: econ ? priceSource : undefined,
          stock,
          days_of_stock: dos == null ? null : dos === Infinity ? 9999 : Math.round(dos),
        },
      })
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
    classes: counts,
    payout: r3(fees.payout),
    payout_orders: fees.orders,
    cancel_rate: summary.cancel_rate,
    return_rate: summary.return_rate,
    cost_ratio: shopEcon.cost_ratio,
    breakeven: shopEcon.breakeven,
    target: shopEcon.target,
  };
}

/**
 * Anh chọn nhóm hàng cho sản phẩm của một chiến dịch (null = trả về tự động). Áp ngay ROAS mục tiêu mới
 * cho mọi chiến dịch của sản phẩm đó (từ số kinh tế đã lưu), không cần chờ job đêm.
 */
export async function setProductClass(shopId: number, campaignId: number, cls: ProductClass | null): Promise<number> {
  const s = await loadSettings(shopId);
  const { data: camp } = await db().from("ads_campaigns").select("item_ids").eq("shop_id", shopId).eq("campaign_id", campaignId).maybeSingle();
  const ids: number[] = (camp?.item_ids ?? []).map(Number);
  if (!ids.length) return 0;
  const now = new Date().toISOString();
  await db()
    .from("product_classes")
    .upsert(ids.map((item_id) => ({ shop_id: shopId, item_id, manual_class: cls, updated_at: now })));
  const { data: camps } = await db()
    .from("ads_campaigns")
    .select("campaign_id, item_ids, econ")
    .eq("shop_id", shopId)
    .in("campaign_status", ["ongoing", "paused", "scheduled"]);
  let n = 0;
  for (const c of camps ?? []) {
    const e = c.econ as Econ | null;
    if (!e || !(c.item_ids ?? []).map(Number).some((id: number) => ids.includes(id))) continue;
    const next = cls ?? e.auto_class ?? "thuong";
    const t = targetForClass(e, next, s.params);
    await db()
      .from("ads_campaigns")
      .update({
        econ: { ...e, class: next, class_source: cls ? "manual" : "auto", class_reason: cls ? "Anh chọn" : e.class_reason, target: t.target, target_label: t.label },
      })
      .eq("shop_id", shopId)
      .eq("campaign_id", c.campaign_id);
    n++;
  }
  return n;
}

/** ROAS luật dùng: ROAS theo lãi nếu bật và tính được, ngược lại ROAS mục tiêu đang đặt. */
export function ruleTarget(c: { roas_target: number | null; econ?: Econ | null }, useProfit: boolean): number | null {
  if (useProfit && c.econ?.target) return c.econ.target;
  return c.roas_target;
}
