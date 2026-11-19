import { timingSafeEqual } from "node:crypto";
import { shops } from "./autopilot/config";
import { normSku, productCode } from "./autopilot/pancake";
import { callShopee, chunk } from "./autopilot/shopee-call";

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

async function getJson(path: string, params: Record<string, string | number | Array<string | number>>): Promise<any> {
  const { key, shopId } = pancake();
  const qs = new URLSearchParams({ api_key: key });
  for (const [k, v] of Object.entries(params)) {
    if (Array.isArray(v)) for (const x of v) qs.append(k, String(x));
    else qs.set(k, String(v));
  }
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

/* ------------------------------------------------------------------------------------------------
 * Đơn cần đóng (đơn xuất) cho kho. Chỉ đọc.
 *   Shopee: lấy thẳng từ Shopee API, mọi đơn READY_TO_SHIP (anh Tùng chốt 20/11/2026: lấy hết đơn chờ;
 *           Pancake đúng với Facebook nhưng không đúng với Shopee).
 *   TikTok, Facebook: lấy từ Pancake. Facebook lọc theo luật: đơn Mới / Đã xác nhận, không vướng ghi chú
 *           giao sau / chưa chốt / đợi chốt, đủ tồn thực.
 * Không trả tên, SĐT, địa chỉ khách.
 * ---------------------------------------------------------------------------------------------- */

export interface XuatItem {
  sku: string;
  product: string;
  name: string;
  detail: string;
  quantity: number;
  image: string;
}
export interface XuatOrder {
  id: string;
  channel: "Shopee" | "TikTok" | "Facebook";
  shop: string;
  carrier: string;
  group: string;
  urgent: boolean;
  shipBy: number | null;
  created: number | null;
  eligible: boolean;
  reason: string;
  items: XuatItem[];
}

export function carrierGroup(name: string | null | undefined): string {
  const raw = String(name ?? "").trim();
  const s = raw.toLowerCase();
  if (/instant|hỏa tốc|hoả tốc|hoa toc|siêu tốc|ahamove|grab|be ?delivery|trong ngày|4 giờ|2 giờ/.test(s)) return "Hỏa tốc";
  if (/spx|shopee xpress|shopee express/.test(s)) return "SPX";
  if (/ghn|giao hàng nhanh/.test(s)) return "GHN";
  if (/viettel|vtp/.test(s)) return "Viettel Post";
  if (/j&t|j ?t express/.test(s)) return "J&T";
  if (/ghtk|tiết kiệm/.test(s)) return "GHTK";
  return raw || "Chưa rõ";
}

function toMs(v: unknown): number | null {
  if (v == null || v === "" || v === 0) return null;
  if (v instanceof Date) return v.getTime();
  if (typeof v === "number") return v < 1e12 ? v * 1000 : v;
  const s = String(v);
  if (/^\d+$/.test(s)) return Number(s) < 1e12 ? Number(s) * 1000 : Number(s);
  // Pancake trả giờ UTC không có "Z".
  const t = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : `${s}Z`);
  return Number.isFinite(t) ? t : null;
}

/** Cuối ngày hôm nay theo giờ Việt Nam (UTC+7), tính bằng ms. */
export function endOfTodayVN(now: number): number {
  const off = 7 * 3600_000;
  return Math.floor((now + off) / 86400_000) * 86400_000 + 86400_000 - off - 1;
}

/** Bỏ dấu, viết hoa, chỉ giữ chữ và số: "Xanh than,180" → "XANHTHAN180". */
export function plain(v: string | null | undefined): string {
  return String(v ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[đĐ]/g, "D")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

/**
 * Một số sản phẩm trên Shopee không khai mã phân loại (model_sku trống), chỉ có mã sản phẩm.
 * Khi đó ghép mã sản phẩm + màu + size theo cách đặt mã của Pancake: ADT26001 + "Đỏ,150" → ADT26001DO150.
 */
export function guessSku(itemSku: string | null | undefined, modelName: string | null | undefined): string {
  const base = normSku(itemSku);
  return base ? base + plain(modelName) : "";
}

// Tên màu trên Shopee khác tên trong mã Pancake (đã thấy 20/11/2026: Shopee "Xanh dương" = Pancake XANHBIEN).
const COLOR_ALIASES: string[][] = [["XANHDUONG", "XANHBIEN"]];

/** Các cách viết khác của một mã phân loại theo bảng màu tương đương. */
export function altSkus(sku: string): string[] {
  const out: string[] = [];
  for (const group of COLOR_ALIASES) for (const a of group) if (sku.includes(a)) for (const b of group) if (b !== a) out.push(sku.replace(a, b));
  return out;
}

export function shapeShopeeXuat(o: any, shopName: string, now: number): XuatOrder {
  const carrier = String(o?.shipping_carrier || o?.checkout_shipping_carrier || o?.package_list?.[0]?.shipping_carrier || "");
  const shipBy = toMs(o?.ship_by_date);
  const items: XuatItem[] = (o?.item_list ?? []).map((it: any) => {
    const sku = normSku(it?.model_sku) || guessSku(it?.item_sku, it?.model_name);
    return {
      sku,
      product: productCode(it?.item_sku) || productCode(sku) || normSku(it?.item_sku) || sku,
      name: String(it?.item_name ?? ""),
      detail: String(it?.model_name ?? ""),
      quantity: Math.max(1, Number(it?.model_quantity_purchased) || 1),
      image: String(it?.image_info?.image_url ?? ""),
    };
  });
  return {
    id: String(o?.order_sn ?? ""),
    channel: "Shopee",
    shop: shopName,
    carrier,
    group: carrierGroup(carrier),
    urgent: shipBy != null && shipBy <= endOfTodayVN(now),
    shipBy,
    created: toMs(o?.create_time),
    eligible: true,
    reason: "",
    items,
  };
}

const NOTE_BLOCK = /(giao|ship|gửi|gui|đi)\s*sau|khách\s*hẹn|hẹn\s*(ngày|giao|ship|gửi)|chưa\s*chốt|đợi\s*chốt|chờ\s*chốt|đợi\s*khách|chờ\s*khách|giữ\s*đơn|chưa\s*(gửi|đi|ship)|không\s*(gửi|đi|ship)/i;
const TAG_BLOCK = /nợ|chờ hàng|giao sau|chưa chốt|đợi chốt|chờ chốt|hẹn/i;

/** Ghi chú / thẻ khiến đơn chưa đi được. Trả lý do, hoặc "" nếu không vướng. */
export function blockReason(o: any): string {
  const notes = [o?.note, o?.note_print, ...(o?.items ?? []).map((i: any) => i?.note)].map((x) => String(x ?? "")).filter(Boolean);
  for (const n of notes) {
    const m = NOTE_BLOCK.exec(n);
    if (m) return `Ghi chú: "${n.replace(/\s+/g, " ").slice(0, 80)}"`;
  }
  for (const t of o?.tags ?? []) {
    const name = String(typeof t === "string" ? t : (t?.name ?? ""));
    if (name && TAG_BLOCK.test(name)) return `Thẻ: ${name}`;
  }
  return "";
}

/**
 * Đơn Pancake → đơn xuất. Trả null nếu không thuộc diện cần đóng ở đây
 * (đơn Shopee lấy từ Shopee API; Facebook chỉ lấy Mới / Đã xác nhận; TikTok lấy thêm "Đang đóng hàng").
 * stock: tồn thực theo mã phân loại, null = không kiểm được tồn.
 */
export function shapePancakeXuat(o: any, stock: Map<string, number> | null): XuatOrder | null {
  const src = String(o?.order_sources_name ?? "");
  const status = Number(o?.status);
  if (/shopee/i.test(src)) return null;
  const tiktok = /tik\s*tok/i.test(src);
  if (tiktok ? ![0, 1, 8].includes(status) : ![0, 1].includes(status)) return null;
  const items: XuatItem[] = [];
  for (const it of o?.items ?? []) {
    const parts: any[] = Array.isArray(it?.components) ? it.components : [];
    const q = Number(it?.quantity) || 1;
    const list = parts.length && parts.every((c) => c?.variation_info) ? parts.map((c) => [c.variation_info, (Number(c?.quantity) || 1) * q]) : [[it?.variation_info, q]];
    for (const [info, qty] of list as Array<[any, number]>) {
      const k = toItem(info, qty);
      const sku = normSku(k.display_id);
      items.push({ sku, product: normSku(info?.product_display_id) || productCode(sku) || sku, name: k.name, detail: k.detail, quantity: k.quantity, image: k.image });
    }
  }
  const carrier = String(o?.partner?.partner_name ?? "");
  let reason = tiktok ? "" : blockReason(o);
  if (!reason && !tiktok && stock) {
    const need = new Map<string, number>();
    for (const it of items) need.set(it.sku, (need.get(it.sku) ?? 0) + it.quantity);
    const short: string[] = [];
    for (const [sku, n] of need) {
      const have = stock.get(sku);
      if (have != null && have < n) short.push(`${sku} (cần ${n}, tồn thực ${have})`);
    }
    if (short.length) reason = `Thiếu hàng: ${short.join(", ")}. Kiểm lại dấu "?" trên Pancake`;
  }
  return {
    id: String(o?.id ?? ""),
    channel: tiktok ? "TikTok" : "Facebook",
    shop: tiktok ? "TikTok" : src || "Pancake",
    carrier,
    group: tiktok ? "TikTok" : carrierGroup(carrier || "Viettel Post"),
    urgent: false,
    shipBy: null,
    created: toMs(o?.inserted_at),
    eligible: !reason,
    reason,
    items,
  };
}

async function shopeeWaiting(now: number, errors: string[]): Promise<XuatOrder[]> {
  const sec = Math.floor(now / 1000);
  const per = await Promise.all(
    shops().map(async (shop) => {
      const out: XuatOrder[] = [];
      try {
        const sns = new Set<string>();
        // Shopee chỉ cho mỗi lần hỏi 15 ngày: hỏi 2 khoảng để không sót đơn đặt trước lâu ngày.
        for (const [from, to] of [[sec - 15 * 86400, sec], [sec - 30 * 86400, sec - 15 * 86400]]) {
          let cursor = "";
          for (let page = 0; page < 20; page++) {
            const res = await callShopee(shop.shopId, "order.get_order_list", { time_range_field: "create_time", time_from: from, time_to: to, page_size: 100, cursor, order_status: "READY_TO_SHIP" });
            for (const o of res.response?.order_list ?? []) sns.add(String(o.order_sn));
            if (!res.response?.more) break;
            cursor = String(res.response?.next_cursor ?? "");
            if (!cursor) break;
          }
        }
        for (const part of chunk([...sns], 50)) {
          const res = await callShopee(shop.shopId, "order.get_order_detail", { order_sn_list: part.join(","), response_optional_fields: "ship_by_date,item_list,shipping_carrier,checkout_shipping_carrier,package_list,note" });
          for (const o of res.response?.order_list ?? []) if (!o.order_status || o.order_status === "READY_TO_SHIP") out.push(shapeShopeeXuat(o, shop.name, now));
        }
      } catch (err) {
        errors.push(`Shopee ${shop.name}: ${err instanceof Error ? err.message : String(err)}`);
      }
      return out;
    })
  );
  return per.flat();
}

async function actualStock(skus: string[]): Promise<Map<string, number>> {
  const stock = new Map<string, number>();
  for (const batch of chunk(skus, 8)) {
    await Promise.all(
      batch.map(async (sku) => {
        const body = await getJson("products/variations", { search: sku, page_size: 20, page_number: 1 });
        const v = (body?.data ?? []).find((x: any) => normSku(x?.display_id) === sku);
        if (!v) return;
        const wh: any[] = v.variations_warehouses ?? [];
        // Tồn thực (actual), không dùng remain_quantity vì đã trừ đơn chờ hàng khác nên báo thiếu nhầm.
        stock.set(sku, wh.length ? wh.reduce((s, w) => s + Number(w.actual_remain_quantity ?? 0), 0) : Number(v.remain_quantity ?? 0));
      })
    );
  }
  return stock;
}

/** Đơn Pancake thô thuộc diện cần đóng (TikTok, Facebook). */
async function pancakeCandidates(errors: string[]): Promise<any[]> {
  try {
    const raw: any[] = [];
    for (let page = 1; page <= 8; page++) {
      const body = await getJson("orders", { page_size: 100, page_number: page, "filter_status[]": [0, 1, 8] });
      raw.push(...(body?.data ?? []));
      const total = Number(body?.total_pages ?? 0);
      if (!body?.data?.length || (total && page >= total)) break;
      if (page === 8) errors.push("Pancake: quá 800 đơn, danh sách có thể thiếu");
    }
    return raw.filter((o) => shapePancakeXuat(o, null));
  } catch (err) {
    errors.push(`Pancake: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

/**
 * Shopee chỉ chuẩn bị đơn có hàng (anh Tùng dặn 20/11/2026: có sản phẩm đặt trước, chưa có hàng).
 * Chia tồn thực cho đơn có hạn giao sớm trước; đơn không đủ hàng thì đánh dấu chưa đi được.
 * Mã không tìm thấy tồn trên Pancake thì không chặn (không kiểm được).
 */
export function applyShopeeStock(orders: XuatOrder[], stock: Map<string, number>): void {
  const left = new Map(stock);
  const sorted = [...orders].sort((a, b) => (a.shipBy ?? Infinity) - (b.shipBy ?? Infinity) || (a.created ?? 0) - (b.created ?? 0));
  for (const o of sorted) {
    const need = new Map<string, number>();
    for (const it of o.items) need.set(it.sku, (need.get(it.sku) ?? 0) + it.quantity);
    const short: string[] = [];
    for (const [sku, n] of need) {
      const have = left.get(sku);
      if (have != null && have < n) short.push(`${sku} (cần ${n}, còn ${Math.max(0, have)})`);
    }
    if (short.length) {
      o.eligible = false;
      o.reason = `Chưa có hàng (đặt trước hoặc thiếu): ${short.join(", ")}`;
    } else for (const [sku, n] of need) if (left.has(sku)) left.set(sku, left.get(sku)! - n);
  }
}

export async function ordersToPack(): Promise<{ at: number; orders: XuatOrder[]; errors: string[]; unknownSkus: string[] }> {
  const now = Date.now();
  const errors: string[] = [];
  const [shopee, cand] = await Promise.all([shopeeWaiting(now, errors), pancakeCandidates(errors)]);
  const skus = new Set<string>();
  for (const o of shopee) for (const it of o.items) if (it.sku) skus.add(it.sku);
  for (const o of cand) if (!/tik\s*tok/i.test(String(o?.order_sources_name ?? ""))) for (const it of shapePancakeXuat(o, null)!.items) if (it.sku) skus.add(it.sku);
  let stock: Map<string, number> | null = null;
  try {
    stock = await actualStock([...skus]);
  } catch (err) {
    errors.push(`Pancake tồn kho: ${err instanceof Error ? err.message : String(err)} (chưa kiểm được đơn nào thiếu hàng)`);
  }
  const unknown = new Set<string>();
  if (stock) {
    // Mã Shopee chưa thấy trên Pancake: thử cách viết màu tương đương rồi đổi mã của món đó sang mã Pancake.
    const missing = [...new Set(shopee.flatMap((o) => o.items.map((it) => it.sku)).filter((k) => k && !stock!.has(k)))];
    const alts = new Map(missing.map((k) => [k, altSkus(k)] as const));
    try {
      const more = await actualStock([...new Set([...alts.values()].flat())]);
      for (const [k, v] of more) stock.set(k, v);
    } catch {
      /* không thử được mã tương đương thì coi như chưa kiểm được */
    }
    for (const o of shopee)
      for (const it of o.items) {
        if (!it.sku || stock.has(it.sku)) continue;
        const hit = (alts.get(it.sku) ?? []).find((k) => stock!.has(k));
        if (hit) it.sku = hit;
        else unknown.add(it.sku);
      }
    applyShopeeStock(shopee, stock);
  }
  const orders = [...shopee, ...cand.map((o) => shapePancakeXuat(o, stock)!)].sort((x, y) => (x.created ?? 0) - (y.created ?? 0));
  return { at: now, orders, errors, unknownSkus: [...unknown].sort() };
}
