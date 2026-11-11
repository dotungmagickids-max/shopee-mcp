import { db } from "../supabase";
import { callShopee, chunk } from "./shopee-call";

/** Trạng thái coi là đã/đang hoàn tiền (CANCELLED, CLOSED = yêu cầu bị hủy/đóng, không hoàn). */
export const REFUND_STATUSES = ["ACCEPTED", "REQUESTED", "PROCESSING", "JUDGING", "SELLER_DISPUTE"];

const WINDOW = 15 * 86400; // API cho tối đa 15 ngày mỗi lần

function toUnix(v: unknown): number | null {
  if (v == null || v === "" || v === 0) return null;
  if (v instanceof Date) return Math.floor(v.getTime() / 1000);
  if (typeof v === "string" && !/^\d+$/.test(v)) {
    const t = Date.parse(v);
    return Number.isFinite(t) ? Math.floor(t / 1000) : null;
  }
  return Number(v);
}

/** Đồng bộ yêu cầu trả hàng tạo trong `days` ngày gần nhất (chỉ đọc Shopee). */
export async function syncReturns(shopId: number, days = 45): Promise<{ returns: number }> {
  const now = Math.floor(Date.now() / 1000);
  const rows = new Map<string, Record<string, unknown>>();
  for (let to = now; to > now - days * 86400; to -= WINDOW) {
    const from = Math.max(now - days * 86400, to - WINDOW + 1);
    for (let page = 0; page < 50; page++) {
      const res = await callShopee(shopId, "returns.get_return_list", {
        page_no: page,
        page_size: 100,
        create_time_from: from,
        create_time_to: to,
      });
      const list: any[] = res.response?.return ?? [];
      const synced = new Date().toISOString();
      for (const r of list) {
        if (!r?.return_sn) continue;
        rows.set(String(r.return_sn), {
          return_sn: String(r.return_sn),
          shop_id: shopId,
          order_sn: r.order_sn,
          status: r.status ?? null,
          refund_amount: r.refund_amount ?? null,
          amount_before_discount: r.amount_before_discount ?? null,
          needs_logistics: r.needs_logistics ?? null,
          return_solution: r.return_solution ?? null,
          reason: r.reason ?? null,
          text_reason: r.text_reason ? String(r.text_reason).slice(0, 500) : null,
          items: (r.item ?? []).map((i: any) => ({
            item_id: Number(i.item_id),
            model_sku: i.variation_sku || null,
            qty: Number(i.amount ?? 1),
            refund_amount: Number(i.refund_amount ?? 0),
            price: Number(i.item_price ?? 0),
          })),
          create_time: toUnix(r.create_time),
          update_time: toUnix(r.update_time),
          synced_at: synced,
        });
      }
      if (!res.response?.more || !list.length) break;
    }
  }
  for (const batch of chunk([...rows.values()], 500)) {
    const { error } = await db().from("shopee_returns").upsert(batch);
    if (error) throw new Error(`shopee_returns: ${error.message}`);
  }
  return { returns: rows.size };
}

export interface ReturnRow {
  order_sn: string;
  status: string | null;
  refund_amount: number | null;
  needs_logistics: boolean | null;
  return_solution: number | null;
  reason: string | null;
  items: { item_id: number; qty: number; refund_amount: number; price: number }[] | null;
}

/** Các yêu cầu hoàn tiền (còn hiệu lực) của danh sách đơn. */
export async function refundsForOrders(shopId: number, orderSns: string[]): Promise<ReturnRow[]> {
  const out: ReturnRow[] = [];
  for (const batch of chunk(orderSns, 200)) {
    const { data, error } = await db()
      .from("shopee_returns")
      .select("order_sn, status, refund_amount, needs_logistics, return_solution, reason, items")
      .eq("shop_id", shopId)
      .in("order_sn", batch);
    if (error) throw new Error(error.message);
    for (const r of (data ?? []) as ReturnRow[]) if (REFUND_STATUSES.includes(r.status ?? "")) out.push(r);
  }
  return out;
}

/** Lý do trả hàng (mã Shopee) → tiếng Việt. */
export const REASON_VI: Record<string, string> = {
  NONE: "Không rõ",
  NOT_RECEIPT: "Không nhận được hàng",
  WRONG_ITEM: "Giao sai hàng",
  ITEM_DAMAGED: "Hàng hư hỏng",
  DIFFERENT_DESCRIPTION: "Khác mô tả",
  MUTUAL_AGREE: "Hai bên thỏa thuận",
  OTHER: "Khác",
  CHANGE_MIND: "Đổi ý",
  ITEM_MISSING: "Thiếu hàng",
  EXPECTATION_FAILED: "Không như mong đợi",
  ITEM_FAKE: "Hàng giả",
  PHYSICAL_DMG: "Hư hỏng bên ngoài",
  FUNCTIONAL_DMG: "Hỏng chức năng",
  ITEM_WRONGDAMAGED: "Sai / hỏng hàng",
  WRONG_SIZE: "Sai size",
  EXPIRED_PRODUCT: "Hàng hết hạn / không vừa",
  USED_PRODUCT: "Hàng đã qua sử dụng",
  INCOMPLETE_PRODUCT: "Thiếu phụ kiện",
};
