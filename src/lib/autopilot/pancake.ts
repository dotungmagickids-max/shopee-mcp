import { db } from "../supabase";
import { chunk } from "./shopee-call";

const BASE = "https://pos.pages.fm/api/v1";
const PAGE_SIZE = 100;

/** Chuẩn hóa mã để khớp SKU Shopee với mã biến thể Pancake: viết hoa, bỏ khoảng trắng. */
export function normSku(s: string | null | undefined): string {
  return String(s ?? "").replace(/\s+/g, "").toUpperCase();
}

/** Mã sản phẩm từ mã biến thể: phần chữ + số đầu, vd QD26001BE160 → QD26001. */
export function productCode(s: string | null | undefined): string | null {
  const m = /^[A-Z]+\d+/.exec(normSku(s));
  return m ? m[0] : null;
}

export interface ProductStats {
  stock: number; // tồn có thể bán, mọi biến thể, mọi kho
  sellingAvg: number; // bán/ngày theo Pancake (mọi kênh)
  categories: Set<string>;
  created: number | null; // ms
  cost: number | null; // giá vốn TB các biến thể
}

/** Thống kê theo mã sản phẩm từ bảng Pancake. */
export async function loadProductStats(): Promise<Map<string, ProductStats>> {
  const out = new Map<string, ProductStats & { costSum: number; costN: number }>();
  for (let page = 0; page < 50; page++) {
    const { data, error } = await db()
      .from("pancake_variations")
      .select("sku, product_code, stock, selling_avg, categories, product_created, cost")
      .range(page * 1000, page * 1000 + 999);
    if (error) throw new Error(error.message);
    for (const r of data ?? []) {
      const code = r.product_code || productCode(r.sku);
      if (!code) continue;
      const a = out.get(code) ?? { stock: 0, sellingAvg: 0, categories: new Set<string>(), created: null, cost: null, costSum: 0, costN: 0 };
      a.stock += Math.max(0, Number(r.stock ?? 0));
      a.sellingAvg += Number(r.selling_avg ?? 0);
      for (const c of r.categories ?? []) a.categories.add(c);
      const t = r.product_created ? Date.parse(r.product_created) : NaN;
      if (Number.isFinite(t)) a.created = a.created == null ? t : Math.min(a.created, t);
      if (Number(r.cost) > 0) {
        a.costSum += Number(r.cost);
        a.costN++;
      }
      out.set(code, a);
    }
    if (!data || data.length < 1000) break;
  }
  for (const a of out.values()) a.cost = a.costN ? a.costSum / a.costN : null;
  return out;
}

const num = (v: unknown) => (v == null || v === "" ? null : Number(v));

/**
 * Đồng bộ giá vốn + tồn kho mọi biến thể từ Pancake POS (chỉ đọc).
 * Cần PANCAKE_API_KEY; PANCAKE_SHOP_ID mặc định 608127 (magickids).
 */
export async function syncPancakeVariations(): Promise<{ variations: number; pages: number } | { skipped: string }> {
  const key = process.env.PANCAKE_API_KEY?.trim();
  if (!key) return { skipped: "Chưa đặt PANCAKE_API_KEY" };
  const shopId = process.env.PANCAKE_SHOP_ID?.trim() || "608127";
  const bySku = new Map<string, Record<string, unknown>>();
  let pages = 0;
  for (let page = 1; page <= 300; page++) {
    const url = `${BASE}/shops/${shopId}/products/variations?api_key=${encodeURIComponent(key)}&page_size=${PAGE_SIZE}&page_number=${page}`;
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    // Không đưa URL (có api_key) vào thông báo lỗi.
    if (!res.ok) throw new Error(`Pancake POS HTTP ${res.status} (trang ${page})`);
    const body: any = await res.json();
    if (body?.success === false) throw new Error(`Pancake POS: ${String(body?.message ?? "lỗi").slice(0, 200)}`);
    pages++;
    const now = new Date().toISOString();
    for (const v of body?.data ?? []) {
      const sku = normSku(v.display_id);
      if (!sku) continue;
      const wh: any[] = v.variations_warehouses ?? [];
      const stock = wh.length ? wh.reduce((s, w) => s + Number(w.remain_quantity ?? 0), 0) : Number(v.remain_quantity ?? 0);
      const sellingAvg = wh.reduce((s, w) => s + Number(w.selling_avg ?? 0), 0);
      const avg = num(v.average_imported_price);
      const last = num(v.last_imported_price);
      bySku.set(sku, {
        sku,
        product_name: v.product?.name ?? null,
        product_code: normSku(v.product?.display_id) || productCode(sku),
        categories: (v.product?.categories ?? []).map((c: any) => String(c?.name ?? "")).filter(Boolean),
        product_created: v.product?.inserted_at ? `${String(v.product.inserted_at).replace(/Z$/, "")}Z` : null,
        // Giá nhập gần nhất: giá bình quân của Pancake hay bị kéo lệch (nhập/kiểm kê giá 0), vd QD26001 bình quân 8.857đ
        // trong khi giá nhập 62.000đ. Chỉ dùng bình quân khi chưa có giá nhập gần nhất.
        cost: last && last > 0 ? last : avg && avg > 0 ? avg : null,
        last_cost: last,
        retail_price: num(v.retail_price),
        stock: Math.round(stock),
        selling_avg: sellingAvg,
        updated_at: now,
      });
    }
    const total = Number(body?.total_pages ?? 0);
    if (!body?.data?.length || (total && page >= total)) break;
  }
  for (const batch of chunk([...bySku.values()], 500)) {
    const { error } = await db().from("pancake_variations").upsert(batch);
    if (error) throw new Error(`pancake_variations: ${error.message}`);
  }
  return { variations: bySku.size, pages };
}

/**
 * Bảng giá vốn theo SKU (đã chuẩn hóa). sku_costs của shop (nhập tay) ưu tiên hơn Pancake.
 */
export async function loadCostMap(shopId: number): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  for (let page = 0; page < 50; page++) {
    const { data, error } = await db()
      .from("pancake_variations")
      .select("sku, cost")
      .range(page * 1000, page * 1000 + 999);
    if (error) throw new Error(error.message);
    for (const r of data ?? []) if (r.cost != null && Number(r.cost) > 0) map.set(normSku(r.sku), Number(r.cost));
    if (!data || data.length < 1000) break;
  }
  const { data: manual } = await db().from("sku_costs").select("sku, cost").eq("shop_id", shopId);
  for (const r of manual ?? []) if (Number(r.cost) > 0) map.set(normSku(r.sku), Number(r.cost));
  return map;
}

export function costOf(map: Map<string, number>, it: { model_sku?: string | null; item_sku?: string | null }): number | null {
  return map.get(normSku(it.model_sku)) ?? map.get(normSku(it.item_sku)) ?? null;
}
