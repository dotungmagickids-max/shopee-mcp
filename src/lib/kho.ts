import { timingSafeEqual } from "node:crypto";
import { normSku } from "./autopilot/pancake";

/**
 * Tra đơn cho bàn đóng hàng (công cụ quay video đóng hàng của kho). Chỉ đọc Pancake POS.
 * Kho quét lẫn mã đơn sàn, mã vận đơn (SPX, J&T) và mã Viettel Post (PKE…); Pancake tìm được cả ba.
 */

const BASE = "https://pos.pages.fm/api/v1";

export function checkKhoKey(request: Request): "ok" | "unset" | "bad" {
  const secret = process.env.KHO_API_KEY?.trim();
  if (!secret) return "unset";
  const a = Buffer.from(request.headers.get("x-mk-key") ?? "");
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b) ? "ok" : "bad";
}

const STATUS_VI: Record<string, string> = {
  new: "Mới",
  submitted: "Đã xác nhận",
  packing: "Đang đóng hàng",
  waiting: "Chờ hàng",
  shipped: "Đã gửi",
  delivered: "Đã nhận",
  returning: "Đang hoàn",
  returned: "Đã hoàn",
  canceled: "Đã hủy",
  removed: "Đã xóa",
};

export interface KhoItem {
  name: string;
  detail: string;
  quantity: number;
  barcode: string;
  display_id: string;
  image: string;
}

export interface KhoOrder {
  found: true;
  order: { id: string; system_id: number | null; source: string; status_name: string; cancelled: boolean; tracking: string };
  items: KhoItem[];
}

function toItem(info: any, quantity: number): KhoItem {
  const fields: any[] = Array.isArray(info?.fields) ? info.fields : [];
  return {
    name: String(info?.name ?? ""),
    detail: fields.length ? fields.map((f) => String(f?.value ?? "")).filter(Boolean).join(" · ") : String(info?.detail ?? ""),
    quantity: Math.max(1, Math.round(Number(quantity) || 1)),
    barcode: String(info?.barcode ?? ""),
    display_id: String(info?.display_id ?? ""),
    image: String((Array.isArray(info?.images) && info.images[0]) || ""),
  };
}

/** Mọi mã có thể in trên tem của một đơn Pancake: mã đơn sàn, mã vận đơn, mã Viettel Post. */
function orderCodes(o: any): string[] {
  return [o?.id, o?.system_id, o?.partner?.extend_code, o?.partner?.order_number_vtp].map((x) => normSku(x == null ? "" : String(x))).filter(Boolean);
}

/** Chọn đúng đơn khớp nguyên mã (Pancake tìm gần đúng nên có thể trả về đơn khác) và rút gọn cho trang kho. */
export function shapeOrder(orders: any[], code: string): KhoOrder | { found: false } {
  const want = normSku(code);
  const o = (orders ?? []).find((x) => orderCodes(x).includes(want));
  if (!o) return { found: false };
  const items: KhoItem[] = [];
  for (const it of o.items ?? []) {
    const parts: any[] = Array.isArray(it?.components) ? it.components : [];
    const q = Number(it?.quantity) || 1;
    if (parts.length && parts.every((c) => c?.variation_info)) {
      // Combo: kho quét từng món trong combo.
      for (const c of parts) items.push(toItem(c.variation_info, (Number(c?.quantity) || 1) * q));
    } else items.push(toItem(it?.variation_info, q));
  }
  // Gộp các dòng trùng mã (cùng phân loại xuất hiện hai lần trong đơn).
  const merged = new Map<string, KhoItem>();
  for (const it of items) {
    const k = normSku(it.display_id) || normSku(it.barcode) || `${it.name}|${it.detail}`;
    const cur = merged.get(k);
    if (cur) cur.quantity += it.quantity;
    else merged.set(k, { ...it });
  }
  const st = String(o.status_name ?? "");
  return {
    found: true,
    order: {
      id: String(o.id ?? ""),
      system_id: o.system_id == null ? null : Number(o.system_id),
      source: String(o.order_sources_name ?? ""),
      status_name: STATUS_VI[st] ?? st,
      cancelled: st === "canceled" || st === "removed" || Number(o.status) === 6 || Number(o.status) === 7,
      tracking: String(o.partner?.extend_code ?? ""),
    },
    items: [...merged.values()],
  };
}

function pancake(): { key: string; shopId: string } {
  const key = process.env.PANCAKE_API_KEY?.trim();
  if (!key) throw new Error("Chưa đặt PANCAKE_API_KEY");
  return { key, shopId: process.env.PANCAKE_SHOP_ID?.trim() || "608127" };
}

async function getJson(path: string, params: Record<string, string | number>): Promise<any> {
  const { key, shopId } = pancake();
  const qs = new URLSearchParams({ api_key: key });
  for (const [k, v] of Object.entries(params)) qs.set(k, String(v));
  const res = await fetch(`${BASE}/shops/${shopId}/${path}?${qs}`, { headers: { Accept: "application/json" } });
  // Không đưa URL (có api_key) vào thông báo lỗi.
  if (!res.ok) throw new Error(`Pancake POS HTTP ${res.status}`);
  const body: any = await res.json();
  if (body?.success === false) throw new Error(`Pancake POS: ${String(body?.message ?? "lỗi").slice(0, 200)}`);
  return body;
}

export async function lookupOrder(code: string): Promise<KhoOrder | { found: false }> {
  const body = await getJson("orders", { search: code, page_size: 10, page_number: 1 });
  return shapeOrder(body?.data ?? [], code);
}

/** Mọi mã sản phẩm có thể in trên tem (mã vạch + mã phân loại) để trang kho phân biệt "sai sản phẩm" với "mã đơn mới". */
export async function productCodes(): Promise<string[]> {
  const codes = new Set<string>();
  const add = (body: any) => {
    for (const v of body?.data ?? []) for (const c of [v?.barcode, v?.display_id]) if (normSku(c)) codes.add(normSku(c));
  };
  const first = await getJson("products/variations", { page_size: 100, page_number: 1 });
  add(first);
  const total = Math.min(300, Number(first?.total_pages ?? 1));
  for (let p = 2; p <= total; p += 6) {
    const batch = [];
    for (let i = p; i < p + 6 && i <= total; i++) batch.push(getJson("products/variations", { page_size: 100, page_number: i }));
    for (const b of await Promise.all(batch)) add(b);
  }
  return [...codes];
}
