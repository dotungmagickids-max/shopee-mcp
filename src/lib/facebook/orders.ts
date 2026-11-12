/**
 * Đơn Pancake theo mã quảng cáo Facebook (trường ad_id của đơn). Chỉ đọc.
 * Cần PANCAKE_API_KEY; PANCAKE_SHOP_ID mặc định 608127 (magickids).
 */
import { vnDayStartUnix } from "../autopilot/time";

const BASE = "https://pos.pages.fm/api/v1";
const PAGE_SIZE = 200;
const CANCELED = new Set([6, 7]);

export type AdOrders = {
  orders: number;
  revenue: number;
  /** Giá vốn = số lượng × giá nhập gần nhất của biến thể (ghi sẵn trên đơn). */
  cogs: number;
  /** Mã sản phẩm bán nhiều nhất qua quảng cáo này. */
  product_code: string | null;
};

/** Gom đơn theo ad_id: đơn không hủy, doanh thu = total_price (tiền hàng, chưa gồm ship). Hàm thuần để test. */
export function groupByAd(rows: any[]): Map<string, AdOrders> {
  const m = new Map<string, AdOrders & { qty: Map<string, number> }>();
  for (const o of rows) {
    const ad = o?.ad_id ? String(o.ad_id) : "";
    if (!ad || CANCELED.has(Number(o?.status))) continue;
    const s = m.get(ad) ?? { orders: 0, revenue: 0, cogs: 0, product_code: null, qty: new Map<string, number>() };
    s.orders += 1;
    s.revenue += Number(o?.total_price ?? 0) || 0;
    for (const it of o?.items ?? []) {
      const q = Number(it?.quantity ?? 0) || 0;
      const v = it?.variation_info ?? {};
      const cost = Number(v.last_imported_price ?? v.exact_price ?? v.avg_price ?? 0) || 0;
      s.cogs += q * cost;
      const code = String(v.product_display_id ?? "").toUpperCase();
      if (code) s.qty.set(code, (s.qty.get(code) ?? 0) + q);
    }
    m.set(ad, s);
  }
  const out = new Map<string, AdOrders>();
  for (const [ad, s] of m) {
    const top = [...s.qty.entries()].sort((a, b) => b[1] - a[1])[0];
    out.set(ad, { orders: s.orders, revenue: s.revenue, cogs: Math.round(s.cogs), product_code: top ? top[0] : null });
  }
  return out;
}

/** Đơn tạo trong ngày (giờ VN) có gắn quảng cáo, gom theo ad_id. */
export async function ordersByAd(day: string): Promise<Map<string, AdOrders>> {
  const key = process.env.PANCAKE_API_KEY?.trim();
  if (!key) throw new Error("Chưa đặt PANCAKE_API_KEY");
  const shopId = process.env.PANCAKE_SHOP_ID?.trim() || "608127";
  const start = vnDayStartUnix(day);
  const end = start + 86_400 - 1;
  const rows: any[] = [];
  for (let page = 1; page <= 100; page++) {
    const q = new URLSearchParams({
      api_key: key,
      page_size: String(PAGE_SIZE),
      page_number: String(page),
      updateStatus: "inserted_at",
      startDateTime: String(start),
      endDateTime: String(end),
    });
    const res = await fetch(`${BASE}/shops/${shopId}/orders?${q}`, { headers: { Accept: "application/json" } });
    // Không đưa URL (có api_key) vào thông báo lỗi.
    if (!res.ok) throw new Error(`Pancake POS HTTP ${res.status} (đơn, trang ${page})`);
    const body: any = await res.json();
    if (body?.success === false) throw new Error(`Pancake POS: ${String(body?.message ?? "lỗi").slice(0, 200)}`);
    for (const o of body?.data ?? []) {
      if (!o?.ad_id) continue;
      rows.push({
        ad_id: o.ad_id,
        status: o.status,
        total_price: o.total_price,
        items: (o.items ?? []).map((it: any) => ({
          quantity: it?.quantity,
          variation_info: {
            last_imported_price: it?.variation_info?.last_imported_price,
            exact_price: it?.variation_info?.exact_price,
            product_display_id: it?.variation_info?.product_display_id,
          },
        })),
      });
    }
    const total = Number(body?.total_pages ?? 0);
    if (!body?.data?.length || (total && page >= total)) break;
  }
  return groupByAd(rows);
}
