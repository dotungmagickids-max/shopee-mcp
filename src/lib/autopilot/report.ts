import { db } from "../supabase";
import { costOf, loadCostMap } from "./pancake";
import { chunk } from "./shopee-call";
import { addDays, vnDayStartUnix } from "./time";

export const INVALID_STATUSES = ["CANCELLED", "IN_CANCEL", "UNPAID"];
const DEFAULT_PAYOUT_RATIO = 0.83;

interface OrderRow {
  order_sn: string;
  create_time: number;
  order_status: string | null;
  total_amount: number | null;
  items: { item_sku?: string | null; model_sku?: string | null; qty?: number }[] | null;
}

export async function ordersBetween(shopId: number, fromUnix: number, toUnix: number): Promise<OrderRow[]> {
  const out: OrderRow[] = [];
  for (let page = 0; page < 50; page++) {
    const { data, error } = await db()
      .from("orders")
      .select("order_sn, create_time, order_status, total_amount, items")
      .eq("shop_id", shopId)
      .gte("create_time", fromUnix)
      .lt("create_time", toUnix)
      .order("create_time")
      .range(page * 1000, page * 1000 + 999);
    if (error) throw new Error(error.message);
    out.push(...((data ?? []) as OrderRow[]));
    if (!data || data.length < 1000) break;
  }
  return out;
}

/** Tỉ lệ tiền về / khách trả của 30 ngày gần nhất (từ escrow thật), mặc định 83%. */
export async function payoutRatio(shopId: number): Promise<number> {
  const { data } = await db()
    .from("order_escrow")
    .select("escrow_amount, buyer_total_amount")
    .eq("shop_id", shopId)
    .gte("updated_at", new Date(Date.now() - 30 * 86400_000).toISOString())
    .limit(2000);
  let paid = 0;
  let escrow = 0;
  for (const r of data ?? []) {
    if (Number(r.buyer_total_amount) > 0 && Number(r.escrow_amount) > 0) {
      paid += Number(r.buyer_total_amount);
      escrow += Number(r.escrow_amount);
    }
  }
  return paid > 1_000_000 ? escrow / paid : DEFAULT_PAYOUT_RATIO;
}

export async function dayReport(shopId: number, date: string) {
  const orders = await ordersBetween(shopId, vnDayStartUnix(date), vnDayStartUnix(addDays(date, 1)));
  const valid = orders.filter((o) => !INVALID_STATUSES.includes(o.order_status ?? ""));
  const cancelled = orders.length - valid.length;

  // Escrow thật nếu có.
  const escrow = new Map<string, { escrow_amount: number; refund_amount: number }>();
  for (const batch of chunk(valid.map((o) => o.order_sn), 200)) {
    const { data } = await db().from("order_escrow").select("order_sn, escrow_amount, refund_amount").in("order_sn", batch);
    for (const r of data ?? []) escrow.set(r.order_sn, { escrow_amount: Number(r.escrow_amount), refund_amount: Number(r.refund_amount) });
  }
  // Đơn COMPLETED nhưng đã hoàn tiền toàn bộ: loại.
  const kept = valid.filter((o) => {
    const e = escrow.get(o.order_sn);
    return !(e && e.refund_amount > 0 && e.escrow_amount <= 0);
  });
  const revenue = kept.reduce((s, o) => s + Number(o.total_amount ?? 0), 0);

  const { data: hours } = await db()
    .from("ads_shop_hourly")
    .select("expense, broad_gmv, broad_order")
    .eq("shop_id", shopId)
    .eq("date", date);
  const adExpense = (hours ?? []).reduce((s, h) => s + Number(h.expense), 0);
  const adGmv = (hours ?? []).reduce((s, h) => s + Number(h.broad_gmv), 0);
  const adOrders = (hours ?? []).reduce((s, h) => s + Number(h.broad_order), 0);
  const { data: gms } = await db().from("ads_gms_daily").select("expense").eq("shop_id", shopId).eq("date", date);
  const gmsExpense = (gms ?? []).reduce((s, g) => s + Number(g.expense), 0);

  // Lãi: tiền về − giá vốn − chi QC.
  const costMap = await loadCostMap(shopId);
  let profit: number | null = null;
  let profitNote = "";
  if (costMap.size) {
    const ratio = await payoutRatio(shopId);
    let payout = 0;
    let cogs = 0;
    let estimated = 0;
    let missing = 0;
    for (const o of kept) {
      const e = escrow.get(o.order_sn);
      if (e) payout += e.escrow_amount;
      else {
        payout += Number(o.total_amount ?? 0) * ratio;
        estimated++;
      }
      for (const it of o.items ?? []) {
        const c = costOf(costMap, it);
        if (c == null) missing++;
        else cogs += c * Number(it.qty ?? 1);
      }
    }
    profit = payout - cogs - adExpense;
    const notes = [];
    if (estimated) notes.push(`${estimated} đơn ước tính tiền về ${Math.round(ratio * 100)}%`);
    if (missing) notes.push(`${missing} dòng hàng thiếu giá vốn`);
    profitNote = notes.length ? `(${notes.join(", ")})` : "";
  }

  const { data: bal } = await db()
    .from("ads_balance_snapshots")
    .select("total_balance")
    .eq("shop_id", shopId)
    .order("created_at", { ascending: false })
    .limit(1);

  return {
    date,
    orders: kept.length,
    cancelled,
    revenue,
    adExpense,
    adGmv,
    gmsExpense,
    roasShopee: adExpense > 0 ? adGmv / adExpense : 0,
    roasReal: adExpense > 0 ? revenue / adExpense : 0,
    adOrders,
    costPerOrder: adOrders ? adExpense / adOrders : 0,
    profit,
    profitNote,
    balance: bal?.[0] ? Number(bal[0].total_balance) : null,
  };
}
