import { db } from "../supabase";

/**
 * Phí Shopee thật, tính từ escrow (tiền về) của đơn đã hoàn tất, quy về % giá bán sản phẩm
 * (order_selling_price: giá sau giảm giá của shop, trước voucher) — cùng thước đo với GMV quảng cáo.
 */
export interface FeeStats {
  orders: number;
  selling: number; // tổng giá bán sản phẩm
  payout: number; // tiền về / giá bán
  fees: { key: string; label: string; ratio: number }[]; // từng khoản phí / giá bán
  estimated: boolean; // true = chưa đủ đơn có escrow, dùng tỉ lệ ước tính
}

/** Ước tính khi chưa có escrow: đơn mẫu 11/2026 tiền về ~68% giá bán. */
export const DEFAULT_PAYOUT_RATIO = 0.7;
const MIN_ORDERS = 20;

const n = (v: unknown) => Number(v ?? 0) || 0;

const FEE_FIELDS: { key: string; label: string; get: (r: any) => number }[] = [
  { key: "commission", label: "Phí cố định", get: (r) => n(r.commission_fee) },
  { key: "service", label: "Phí dịch vụ", get: (r) => n(r.service_fee) },
  { key: "transaction", label: "Phí thanh toán", get: (r) => n(r.seller_transaction_fee) },
  { key: "infra", label: "Phí hạ tầng", get: (r) => n(r.ads_escrow_top_up_fee_or_technical_support_fee) },
  { key: "affiliate", label: "Hoa hồng tiếp thị liên kết", get: (r) => n(r.order_ams_commission_fee) },
  { key: "seller_voucher", label: "Voucher shop", get: (r) => n(r.voucher_from_seller) },
  { key: "tax", label: "Thuế khấu trừ", get: (r) => n(r.withholding_tax) + n(r.withholding_vat_tax) + n(r.withholding_pit_tax) + n(r.withholding_cit_tax) },
  {
    key: "shipping",
    label: "Phí ship shop chịu",
    get: (r) => Math.max(0, n(r.actual_shipping_fee) - n(r.shopee_shipping_rebate) - n(r.buyer_paid_shipping_fee) - n(r.shipping_fee_discount_from_3pl)),
  },
  { key: "shipping_protection", label: "Bảo hiểm vận chuyển", get: (r) => n(r.shipping_seller_protection_fee_amount) },
  { key: "return_shipping", label: "Ship hoàn", get: (r) => n(r.reverse_shipping_fee) + n(r.final_return_to_seller_shipping_fee) },
];

export function sellingOf(raw: any): number {
  return n(raw?.order_selling_price) || n(raw?.order_discounted_price);
}

/** Phí thật của shop trong `days` ngày (đơn hoàn tất, không bị hoàn tiền). */
export async function shopFees(shopId: number, days = 45): Promise<FeeStats> {
  const since = new Date(Date.now() - days * 86400_000).toISOString();
  const rows: any[] = [];
  for (let page = 0; page < 20; page++) {
    const { data, error } = await db()
      .from("order_escrow")
      .select("escrow_amount, refund_amount, raw")
      .eq("shop_id", shopId)
      .gte("updated_at", since)
      .range(page * 1000, page * 1000 + 999);
    if (error) throw new Error(error.message);
    rows.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  let selling = 0;
  let payout = 0;
  let orders = 0;
  const sums = new Map<string, number>();
  for (const r of rows) {
    const s = sellingOf(r.raw);
    if (!(s > 0) || n(r.refund_amount) > 0) continue;
    orders++;
    selling += s;
    payout += n(r.escrow_amount);
    for (const f of FEE_FIELDS) sums.set(f.key, (sums.get(f.key) ?? 0) + f.get(r.raw));
  }
  if (orders < MIN_ORDERS || selling <= 0) {
    return { orders, selling, payout: DEFAULT_PAYOUT_RATIO, fees: [], estimated: true };
  }
  const fees = FEE_FIELDS.map((f) => ({ key: f.key, label: f.label, ratio: (sums.get(f.key) ?? 0) / selling })).filter((f) => f.ratio > 0.0005);
  const listed = fees.reduce((s, f) => s + f.ratio, 0);
  const other = 1 - payout / selling - listed;
  if (Math.abs(other) > 0.0005) fees.push({ key: "other", label: other > 0 ? "Khác" : "Khác (Shopee trợ giá)", ratio: other });
  return { orders, selling, payout: payout / selling, fees, estimated: false };
}

export const CANCEL_STATUSES = ["CANCELLED", "IN_CANCEL"];
export const RETURN_STATUSES = ["TO_RETURN"];

/**
 * Tỉ lệ hủy và hoàn của đơn tạo từ 45 tới 10 ngày trước (đủ lâu để đã giao xong):
 *   hủy = đơn hủy (kể cả giao thất bại) / đơn đã đặt (trừ chưa thanh toán)
 *   hoàn = đơn trả hàng (TO_RETURN hoặc hoàn tất nhưng bị hoàn tiền) / đơn không hủy
 */
export async function cancelReturnRates(shopId: number): Promise<{ cancel: number; ret: number; orders: number }> {
  const now = Math.floor(Date.now() / 1000);
  const from = now - 45 * 86400;
  const to = now - 10 * 86400;
  const rows: { order_sn: string; order_status: string | null }[] = [];
  for (let page = 0; page < 30; page++) {
    const { data, error } = await db()
      .from("orders")
      .select("order_sn, order_status")
      .eq("shop_id", shopId)
      .gte("create_time", from)
      .lt("create_time", to)
      .range(page * 1000, page * 1000 + 999);
    if (error) throw new Error(error.message);
    rows.push(...((data ?? []) as any[]));
    if (!data || data.length < 1000) break;
  }
  const placed = rows.filter((o) => o.order_status !== "UNPAID");
  const cancelled = placed.filter((o) => CANCEL_STATUSES.includes(o.order_status ?? ""));
  const kept = placed.filter((o) => !CANCEL_STATUSES.includes(o.order_status ?? ""));
  const refunded = new Set<string>();
  const completed = kept.filter((o) => o.order_status === "COMPLETED").map((o) => o.order_sn);
  for (let i = 0; i < completed.length; i += 200) {
    const { data } = await db()
      .from("order_escrow")
      .select("order_sn, refund_amount")
      .in("order_sn", completed.slice(i, i + 200));
    for (const r of data ?? []) if (n(r.refund_amount) > 0) refunded.add(r.order_sn);
  }
  const returned = kept.filter((o) => RETURN_STATUSES.includes(o.order_status ?? "") || refunded.has(o.order_sn)).length;
  return {
    cancel: placed.length ? cancelled.length / placed.length : 0,
    ret: kept.length ? returned / kept.length : 0,
    orders: placed.length,
  };
}
