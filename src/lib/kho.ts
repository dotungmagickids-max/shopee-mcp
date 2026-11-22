import { timingSafeEqual } from "node:crypto";
import { shops } from "./autopilot/config";
import { normSku, productCode } from "./autopilot/pancake";
import { callShopee, chunk } from "./autopilot/shopee-call";
import { cleanVtpRows, vtpMailGet, vtpMailSave, type VtpMailDoc } from "./kho-store";

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

/**
 * Mọi mã sản phẩm có thể in trên tem (mã vạch + mã phân loại) để trang kho phân biệt "sai sản phẩm" với "mã đơn mới".
 * pairs: [mã vạch, mã phân loại] để trang kho đổi mã vạch vừa quét ra mã phân loại (nhập hàng hoàn).
 */
export async function productCatalog(): Promise<{ codes: string[]; pairs: Array<[string, string]> }> {
  const codes = new Set<string>();
  const pairs = new Map<string, string>();
  await eachVariation((v) => {
    const b = normSku(v?.barcode);
    const d = normSku(v?.display_id);
    if (b) codes.add(b);
    if (d) codes.add(d);
    if (b && d && b !== d) pairs.set(b, d);
  });
  return { codes: [...codes], pairs: [...pairs] };
}

/** Đi qua mọi phân loại sản phẩm trên Pancake (100 dòng mỗi trang, 6 trang một lượt). Chỉ đọc. */
async function eachVariation(fn: (v: any) => void): Promise<void> {
  const add = (body: any) => {
    for (const v of body?.data ?? []) fn(v);
  };
  const first = await getJson("products/variations", { page_size: 100, page_number: 1 });
  add(first);
  const total = Math.min(300, Number(first?.total_pages ?? 1));
  for (let p = 2; p <= total; p += 6) {
    const batch = [];
    for (let i = p; i < p + 6 && i <= total; i++) batch.push(getJson("products/variations", { page_size: 100, page_number: i }));
    for (const b of await Promise.all(batch)) add(b);
  }
}

/**
 * Tồn thực trên Pancake theo mã phân loại, để so với số đếm khi tổng kiểm kho. Chỉ đọc.
 * Dùng actual_remain_quantity (hàng đang nằm trong kho), không dùng remain_quantity (đã trừ đơn chờ hàng).
 */
/** [mã phân loại, tồn thực, tên sản phẩm, mã hàng, số cái đơn đang chờ hàng]. Không có giá. */
export type StockRow = [string, number, string, string, number];
export function stockRow(sku: string, qty: number, v: any): StockRow {
  const wh: any[] = v?.variations_warehouses ?? [];
  const wait = wh.reduce((s, w) => s + Number(w?.waiting_quantity ?? 0), 0);
  return [sku, Number.isFinite(qty) ? qty : 0, String(v?.product?.name ?? "").slice(0, 120), normSku(v?.product?.display_id), Number.isFinite(wait) ? wait : 0];
}
/** Ảnh đại diện của một phân loại: ảnh riêng của phân loại, không có thì ảnh sản phẩm. Chỉ nhận đường dẫn https. */
export function variationImage(v: any): string {
  const u = [...(Array.isArray(v?.images) ? v.images : []), v?.product?.image].find((x) => typeof x === "string" && /^https:\/\//.test(x));
  return u ? String(u).slice(0, 300) : "";
}
export async function pancakeStock(): Promise<{ at: number; stock: StockRow[]; images: Array<[string, string]> }> {
  const m = new Map<string, StockRow>();
  const img = new Map<string, string>();
  await eachVariation((v) => {
    const sku = normSku(v?.display_id);
    if (!sku) return;
    const wh: any[] = v?.variations_warehouses ?? [];
    const qty = wh.length ? wh.reduce((s, w) => s + Number(w?.actual_remain_quantity ?? 0), 0) : Number(v?.remain_quantity ?? 0);
    const row = stockRow(sku, qty, v);
    m.set(sku, row);
    // Mỗi mã hàng một ảnh (ảnh của phân loại đầu tiên có ảnh), để trang kho không phải tải 4.700 đường dẫn.
    const ma = row[3] || sku;
    if (!img.has(ma)) {
      const u = variationImage(v);
      if (u) img.set(ma, u);
    }
  });
  return { at: Date.now(), stock: [...m.values()], images: [...img] };
}

/* ------------------------------------------------------------------------------------------------
 * Đơn cần đóng (đơn xuất) cho kho. Chỉ đọc.
 *   Shopee: lấy thẳng từ Shopee API, mọi đơn READY_TO_SHIP (anh Tùng chốt 20/11/2026: lấy hết đơn chờ;
 *           Pancake đúng với Facebook nhưng không đúng với Shopee) và đơn PROCESSED (đã chuẩn bị hàng,
 *           chờ hãng lấy: kho vẫn phải đóng và in tem).
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
  /** Đơn Pancake đi Viettel Post: "doi" = đơn đổi, khi đẩy phải chọn dịch vụ GGDH; "nghi" = ghi chú có nhắc đổi/trả nhưng chưa rõ. */
  exchange?: "doi" | "nghi";
  /** Ghi chú làm căn cứ cho exchange. */
  exchangeNote?: string;
  /**
   * Đã chuẩn bị xong, chờ hãng tới lấy: kho đóng các đơn này.
   * Shopee: đã bấm "chuẩn bị hàng". Viettel Post: Pancake "Đã gửi hàng" nhưng bưu tá chưa nhận.
   */
  arranged?: boolean;
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
    arranged: o?.order_status === "PROCESSED",
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
 * Đơn đổi hàng (anh Tùng dạy 20/11/2026): khi đẩy sang Viettel Post phải chọn dịch vụ mở rộng "GGDH - Đổi hàng"
 * để bưu tá cầm hàng cũ về. Sale ghi chú theo mẫu "đơn đổi cầm 1 quần về".
 * Đo trên 400 đơn Viettel Post 10–19/11/2026: 37 đơn có GGDH, luật này nhận đúng cả 37, không nhận nhầm đơn nào.
 */
const DOI_SURE = /(cam|mang|lay|thu|nhan|dem|gui)\s+(lai\s+)?((\d+\s+)?(hang|do|bo|ao|quan|vay|sp|san pham|cai|chiec|don)\s+)?(\w+\s+){0,3}ve\b|thu hoi|don doi|doi hang|hang doi|doi (size|mau|mau ma|sang|lay|tra|sp|san pham|\d)/;
const DOI_MAYBE = /\bdoi\b|\btra hang\b|\bhoan\b/;

export function exchangeKind(o: any): { kind: "doi" | "nghi" | ""; note: string } {
  const notes = [o?.note, o?.note_print].map((x) => String(x ?? "").replace(/\s+/g, " ").trim()).filter(Boolean);
  // "đợi" (chờ) bỏ dấu trùng với "đổi": đổi chữ "đợi" thành "cho" trước khi bỏ dấu.
  const flat = (s: string) => s.normalize("NFC").toLowerCase().replace(/đợi/g, "cho").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[đĐ]/g, "d").toLowerCase();
  for (const re of [DOI_SURE, DOI_MAYBE]) {
    const hit = notes.find((n) => re.test(flat(n)));
    if (hit) return { kind: re === DOI_SURE ? "doi" : "nghi", note: hit.slice(0, 100) };
  }
  return { kind: "", note: "" };
}

/** Đơn đã đẩy sang Viettel Post nhưng bưu tá chưa nhận hàng (chưa có giờ nhận, trạng thái còn ở các bước chờ lấy). */
export function vtpWaitingPickup(o: any): boolean {
  const p = o?.partner;
  if (!p || !/vtp|viettel/i.test(String(p.partner_name ?? "")) || p.picked_up_at) return false;
  return ["", "waiting", "request_received", "processing_picked_up", "picking_up", "delay_pickup"].includes(String(p.partner_status ?? ""));
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
  // Anh Tùng dạy 20/11/2026: đơn Viettel Post ở "Đã gửi hàng" mà chưa chuyển cho hãng là đơn kho phải đóng.
  const pushed = status === 2 && vtpWaitingPickup(o);
  if (!pushed && (tiktok ? ![0, 1, 8].includes(status) : ![0, 1].includes(status))) return null;
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
  let ex = tiktok ? { kind: "" as "" | "doi" | "nghi", note: "" } : exchangeKind(o);
  // Đơn đã đẩy: dịch vụ đổi hàng chị Hiền đã chọn (GGDH) là câu trả lời chắc chắn, hơn mọi suy đoán từ ghi chú.
  if (pushed && /GGDH/i.test(String(o?.partner?.service_partner?.ORDER_SERVICE_ADD ?? ""))) ex = { kind: "doi", note: ex.note || "Đã chọn dịch vụ GGDH - Đổi hàng" };
  let reason = tiktok || pushed ? "" : blockReason(o);
  if (!reason && !tiktok && !pushed && stock) {
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
    group: tiktok && !pushed ? "TikTok" : carrierGroup(carrier || "Viettel Post"),
    urgent: false,
    shipBy: null,
    created: toMs(o?.inserted_at),
    eligible: !reason,
    reason,
    items,
    ...(ex.kind ? { exchange: ex.kind, exchangeNote: ex.note } : {}),
    ...(pushed ? { arranged: true } : {}),
  };
}

const WAITING = ["READY_TO_SHIP", "PROCESSED"];

async function shopeeWaiting(now: number, errors: string[]): Promise<XuatOrder[]> {
  const sec = Math.floor(now / 1000);
  const per = await Promise.all(
    shops().map(async (shop) => {
      const out: XuatOrder[] = [];
      try {
        const sns = new Set<string>();
        // Shopee chỉ cho mỗi lần hỏi 15 ngày: hỏi 2 khoảng để không sót đơn đặt trước lâu ngày.
        const asks: Array<[number, number, string]> = [];
        for (const status of WAITING) for (const [from, to] of [[sec - 15 * 86400, sec], [sec - 30 * 86400, sec - 15 * 86400]]) asks.push([from, to, status]);
        await Promise.all(
          asks.map(async ([from, to, status]) => {
            let cursor = "";
            for (let page = 0; page < 20; page++) {
              const res = await callShopee(shop.shopId, "order.get_order_list", { time_range_field: "create_time", time_from: from, time_to: to, page_size: 100, cursor, order_status: status });
              for (const o of res.response?.order_list ?? []) sns.add(String(o.order_sn));
              if (!res.response?.more) break;
              cursor = String(res.response?.next_cursor ?? "");
              if (!cursor) break;
            }
          })
        );
        for (const part of chunk([...sns], 50)) {
          const res = await callShopee(shop.shopId, "order.get_order_detail", { order_sn_list: part.join(","), response_optional_fields: "ship_by_date,item_list,shipping_carrier,checkout_shipping_carrier,package_list,note" });
          for (const o of res.response?.order_list ?? []) if (!o.order_status || WAITING.includes(o.order_status)) out.push(shapeShopeeXuat(o, shop.name, now));
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
    // Đơn "Đã gửi hàng" đi Viettel Post (tìm "PKE" để khỏi kéo cả nghìn đơn sàn); chỉ giữ đơn bưu tá chưa nhận.
    for (let page = 1; page <= 4; page++) {
      const body = await getJson("orders", { search: "PKE", page_size: 100, page_number: page, "filter_status[]": [2] });
      raw.push(...(body?.data ?? []));
      const total = Number(body?.total_pages ?? 0);
      if (!body?.data?.length || (total && page >= total)) break;
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
 * Đơn đã chuẩn bị hàng thì đã hứa với Shopee: được chia tồn trước và không bị chặn.
 */
export function applyShopeeStock(orders: XuatOrder[], stock: Map<string, number>): Map<string, number> {
  const left = new Map(stock);
  const sorted = [...orders].sort((a, b) => Number(!!b.arranged) - Number(!!a.arranged) || (a.shipBy ?? Infinity) - (b.shipBy ?? Infinity) || (a.created ?? 0) - (b.created ?? 0));
  for (const o of sorted) {
    const need = new Map<string, number>();
    for (const it of o.items) need.set(it.sku, (need.get(it.sku) ?? 0) + it.quantity);
    const short: string[] = [];
    for (const [sku, n] of need) {
      const have = left.get(sku);
      if (have != null && have < n) short.push(`${sku} (cần ${n}, còn ${Math.max(0, have)})`);
    }
    if (short.length && !o.arranged) {
      o.eligible = false;
      o.reason = `Chưa có hàng (đặt trước hoặc thiếu): ${short.join(", ")}`;
    } else for (const [sku, n] of need) if (left.has(sku)) left.set(sku, left.get(sku)! - n);
  }
  return left;
}

/**
 * Đơn Viettel Post đã gửi hàng (chờ bưu tá lấy) cũng chỉ vào đợt đóng khi có hàng (anh Tùng chốt 20/11/2026):
 * nhiều đơn đặt trước được đẩy sớm để giữ mã rồi chờ hàng về.
 * Dùng phần tồn còn lại sau khi đã chia cho Shopee (Shopee có hạn giao), đơn tạo trước được chia trước.
 * Mã không tìm thấy tồn trên Pancake thì không chặn.
 */
export function applyPushedStock(orders: XuatOrder[], left: Map<string, number>): void {
  const sorted = orders.filter((o) => o.arranged && o.channel !== "Shopee").sort((a, b) => (a.created ?? 0) - (b.created ?? 0));
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
      o.reason = `Đã gửi hàng nhưng chưa có hàng (đặt trước hoặc thiếu): ${short.join(", ")}`;
    } else for (const [sku, n] of need) if (left.has(sku)) left.set(sku, left.get(sku)! - n);
  }
}

export async function ordersToPack(): Promise<{ at: number; orders: XuatOrder[]; errors: string[]; unknownSkus: string[]; canArrange: boolean }> {
  const now = Date.now();
  const errors: string[] = [];
  const [shopee, cand] = await Promise.all([shopeeWaiting(now, errors), pancakeCandidates(errors)]);
  const skus = new Set<string>();
  for (const o of shopee) for (const it of o.items) if (it.sku) skus.add(it.sku);
  for (const o of cand) if (!/tik\s*tok/i.test(String(o?.order_sources_name ?? "")) || Number(o?.status) === 2) for (const it of shapePancakeXuat(o, null)!.items) if (it.sku) skus.add(it.sku);
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
  }
  const pancake = cand.map((o) => shapePancakeXuat(o, stock)!);
  if (stock) applyPushedStock(pancake, applyShopeeStock(shopee, stock));
  const orders = [...shopee, ...pancake].sort((x, y) => (x.created ?? 0) - (y.created ?? 0));
  return { at: now, orders, errors, unknownSkus: [...unknown].sort(), canArrange: arrangeAllowed() };
}

/* ------------------------------------------------------------------------------------------------
 * Tem vận đơn Shopee cho kho in ngay trong phần mềm.
 *   shopeeLabels : lấy file PDF tem của các đơn ĐÃ chuẩn bị hàng. Không đổi trạng thái đơn
 *                  (create_shipping_document chỉ yêu cầu Shopee dựng file).
 *   shopeeArrange: bấm "chuẩn bị hàng" (ship_order) thay người. LỆNH GHI THẬT lên Shopee, chỉ chạy khi
 *                  máy chủ đặt KHO_CHUAN_BI=1 (anh Tùng: hệ thống ổn định mới cho chuẩn bị hàng).
 * ---------------------------------------------------------------------------------------------- */

export const arrangeAllowed = (): boolean => process.env.KHO_CHUAN_BI?.trim() === "1";

export interface Failed {
  id: string;
  reason: string;
}

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err)).slice(0, 200);

function findShop(name: string) {
  const shop = shops().find((s) => s.name === name || String(s.shopId) === name);
  if (!shop) throw new Error(`Không có shop "${name}"`);
  return shop;
}

/** Chạy fn cho từng phần tử, tối đa n việc cùng lúc. */
async function pool<T>(items: T[], n: number, fn: (x: T) => Promise<void>): Promise<void> {
  for (const part of chunk(items, n)) await Promise.all(part.map(fn));
}

/** Gom đơn theo (loại tem, hãng vận chuyển): Shopee chỉ cho tải chung một file khi cùng hãng. */
export function labelGroups(rows: Array<{ id: string; type: string; carrier: string }>): Array<{ type: string; carrier: string; orders: string[] }> {
  const m = new Map<string, { type: string; carrier: string; orders: string[] }>();
  for (const r of rows) {
    const k = `${r.type}|${r.carrier}`;
    const g = m.get(k) ?? { type: r.type, carrier: r.carrier, orders: [] };
    g.orders.push(r.id);
    m.set(k, g);
  }
  return [...m.values()];
}

export async function shopeeLabels(shopName: string, sns: string[]): Promise<{ files: Array<{ type: string; carrier: string; orders: string[]; pdf: string }>; failed: Failed[] }> {
  const shop = findShop(shopName);
  const failed: Failed[] = [];
  const fail = (id: string, reason: string) => void failed.push({ id, reason });

  // 1. Mã vận đơn: chưa có nghĩa là đơn chưa chuẩn bị hàng.
  const tracking = new Map<string, string>();
  await pool(sns, 8, async (sn) => {
    try {
      const res = await callShopee(shop.shopId, "logistics.get_tracking_number", { order_sn: sn });
      const no = String(res.response?.tracking_number ?? "");
      if (no) tracking.set(sn, no);
      else fail(sn, "Chưa có mã vận đơn (đơn chưa chuẩn bị hàng, hoặc Shopee chưa cấp xong: thử lại sau ít phút)");
    } catch (err) {
      fail(sn, errText(err));
    }
  });
  let live = sns.filter((sn) => tracking.has(sn));
  if (!live.length) return { files: [], failed };

  // 2. Hãng vận chuyển và loại tem Shopee gợi ý cho từng đơn.
  const carrier = new Map<string, string>();
  const type = new Map<string, string>();
  try {
    const [detail, param] = await Promise.all([
      callShopee(shop.shopId, "order.get_order_detail", { order_sn_list: live.join(","), response_optional_fields: "shipping_carrier,checkout_shipping_carrier,package_list" }),
      callShopee(shop.shopId, "logistics.get_shipping_document_parameter", { order_list: live.map((sn) => ({ order_sn: sn })) }),
    ]);
    for (const o of detail.response?.order_list ?? []) carrier.set(String(o.order_sn), String(o.shipping_carrier || o.checkout_shipping_carrier || o.package_list?.[0]?.shipping_carrier || ""));
    for (const r of param.response?.result_list ?? []) {
      const t = String(r.suggest_shipping_document_type || r.selectable_shipping_document_type?.[0] || "");
      if (t) type.set(String(r.order_sn), t);
      else fail(String(r.order_sn), `Shopee chưa cho in tem: ${String(r.fail_message || r.fail_error || "không rõ lý do")}`);
    }
  } catch (err) {
    for (const sn of live) fail(sn, errText(err));
    return { files: [], failed };
  }
  for (const sn of live) if (!type.has(sn) && !failed.some((f) => f.id === sn)) fail(sn, "Shopee không trả loại tem cho đơn này");
  live = live.filter((sn) => type.has(sn));
  if (!live.length) return { files: [], failed };

  // 3. Yêu cầu Shopee dựng file tem, chờ sẵn sàng.
  const drop = (rows: any[], prefix: string) => {
    for (const r of rows ?? []) {
      if (!r?.fail_error && !r?.fail_message) continue;
      const sn = String(r.order_sn);
      if (live.includes(sn)) fail(sn, `${prefix}: ${String(r.fail_message || r.fail_error)}`);
      live = live.filter((x) => x !== sn);
    }
  };
  try {
    const made = await callShopee(shop.shopId, "logistics.create_shipping_document", { order_list: live.map((sn) => ({ order_sn: sn, tracking_number: tracking.get(sn), shipping_document_type: type.get(sn) })) }, { allowWrite: true });
    drop(made.response?.result_list, "Chưa dựng được tem");
  } catch (err) {
    for (const sn of live) fail(sn, errText(err));
    return { files: [], failed };
  }
  let ready: string[] = [];
  for (let attempt = 0; attempt < 10 && live.length; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, 1500));
    try {
      const res = await callShopee(shop.shopId, "logistics.get_shipping_document_result", { order_list: live.map((sn) => ({ order_sn: sn, shipping_document_type: type.get(sn) })) });
      const rows: any[] = res.response?.result_list ?? [];
      drop(rows.filter((r) => r.status === "FAILED"), "Shopee dựng tem lỗi");
      ready = rows.filter((r) => r.status === "READY").map((r) => String(r.order_sn));
      if (ready.length >= live.length) break;
    } catch (err) {
      if (attempt === 9) for (const sn of live) fail(sn, errText(err));
    }
  }
  for (const sn of live) if (!ready.includes(sn) && !failed.some((f) => f.id === sn)) fail(sn, "Shopee chưa dựng xong tem: bấm in lại sau ít phút");
  live = live.filter((sn) => ready.includes(sn));

  // 4. Tải file: mỗi (loại tem, hãng) một file PDF.
  const files: Array<{ type: string; carrier: string; orders: string[]; pdf: string }> = [];
  for (const g of labelGroups(live.map((sn) => ({ id: sn, type: type.get(sn)!, carrier: carrier.get(sn) ?? "" })))) {
    try {
      const buf: unknown = await callShopee(shop.shopId, "logistics.download_shipping_document", { shipping_document_type: g.type, order_list: g.orders.map((sn) => ({ order_sn: sn })) });
      if (!Buffer.isBuffer(buf) || buf.subarray(0, 4).toString("latin1") !== "%PDF") throw new Error("Shopee không trả file PDF");
      files.push({ ...g, pdf: buf.toString("base64") });
    } catch (err) {
      for (const sn of g.orders) fail(sn, `Chưa tải được tem: ${errText(err)}`);
    }
  }
  return { files, failed };
}

/**
 * Chọn tham số ship_order từ get_shipping_parameter. Trả thân lệnh, hoặc chuỗi lý do không làm được.
 * cach: "pickup" = hãng tới kho lấy (chọn địa chỉ lấy hàng mặc định và khung giờ sớm nhất), "dropoff" = kho tự mang ra bưu cục.
 */
export function arrangeBody(sn: string, param: any, cach: "pickup" | "dropoff"): Record<string, unknown> | string {
  const need = param?.info_needed ?? {};
  if (cach === "dropoff") {
    if (!Array.isArray(need.dropoff)) return "Đơn này không cho tự mang ra bưu cục";
    if (need.dropoff.length) return `Tự mang ra bưu cục cần thêm thông tin (${need.dropoff.join(", ")}): chuẩn bị trên Shopee`;
    return { order_sn: sn, dropoff: {} };
  }
  if (!Array.isArray(need.pickup)) return "Đơn này không có hình thức hãng tới lấy";
  const extra = need.pickup.filter((k: string) => k !== "address_id" && k !== "pickup_time_id");
  if (extra.length) return `Hãng tới lấy cần thêm thông tin (${extra.join(", ")}): chuẩn bị trên Shopee`;
  const list: any[] = (param?.pickup?.address_list ?? []).filter((a: any) => (a?.time_slot_list ?? []).length);
  const addr = list.find((a) => (a.address_flag ?? []).includes("pickup_address")) ?? list[0];
  if (!addr) return "Shopee không trả khung giờ lấy hàng nào";
  const slot = [...addr.time_slot_list].sort((a: any, b: any) => Number(a.date ?? 0) - Number(b.date ?? 0))[0];
  return { order_sn: sn, pickup: { address_id: addr.address_id, pickup_time_id: String(slot.pickup_time_id) } };
}

export async function shopeeArrange(shopName: string, sns: string[], cach: "pickup" | "dropoff"): Promise<{ done: string[]; failed: Failed[] }> {
  if (!arrangeAllowed()) throw new Error("Máy chủ chưa bật chuẩn bị hàng tự động (KHO_CHUAN_BI). Chọn chế độ chỉ in tem, hoặc báo anh Tùng bật.");
  const shop = findShop(shopName);
  const done: string[] = [];
  const failed: Failed[] = [];
  await pool(sns, 4, async (sn) => {
    try {
      const res = await callShopee(shop.shopId, "logistics.get_shipping_parameter", { order_sn: sn });
      const body = arrangeBody(sn, res.response, cach);
      if (typeof body === "string") return void failed.push({ id: sn, reason: body });
      await callShopee(shop.shopId, "logistics.ship_order", body, { allowWrite: true });
      done.push(sn);
    } catch (err) {
      failed.push({ id: sn, reason: errText(err) });
    }
  });
  return { done, failed };
}

/* ------------------------------------------------------------------------------------------------
 * Kiện hoàn đang chờ về kho (chỉ đọc). Kho quay video lúc mở kiện; phần mềm so danh sách này với video
 * hàng hoàn để biết kiện nào CHƯA VỀ.
 *   Shopee  : yêu cầu trả hàng hoàn tiền mà khách phải gửi hàng lại (needs_logistics), 45 ngày gần nhất.
 *   Pancake : đơn Viettel Post đang hoàn (4) hoặc hoàn một phần (15), 60 ngày gần nhất.
 * Chưa có: đơn Shopee giao không thành công đang quay về (Shopee API không có trạng thái riêng để liệt kê).
 * Không trả tên, SĐT, địa chỉ khách.
 * ---------------------------------------------------------------------------------------------- */

export interface HoanRow {
  key: string;
  channel: string;
  shop: string;
  kind: "tra-hang" | "giao-that-bai" | "hoan-mot-phan";
  id: string;
  codes: string[];
  status: string;
  reason: string;
  refund: number | null;
  items: Array<{ sku: string; name: string; detail: string; quantity: number }>;
  since: number | null;
  due: number | null;
}

const RETURN_STATUS_VI: Record<string, string> = {
  REQUESTED: "Khách vừa yêu cầu",
  ACCEPTED: "Đã chấp nhận trả hàng",
  PROCESSING: "Đang xử lý",
  JUDGING: "Shopee đang xét",
  SELLER_DISPUTE: "Shop đang khiếu nại",
  REFUND_PAID: "Đã hoàn tiền",
  COMPLETED: "Hoàn tất",
};
const RETURN_REASON_VI: Record<string, string> = {
  NOT_RECEIPT: "Không nhận được hàng",
  WRONG_ITEM: "Giao sai hàng",
  ITEM_DAMAGED: "Hàng hư hỏng",
  DIFFERENT_DESCRIPTION: "Khác mô tả",
  MUTUAL_AGREE: "Hai bên thỏa thuận",
  CHANGE_MIND: "Đổi ý",
  ITEM_MISSING: "Thiếu hàng",
  EXPECTATION_FAILED: "Không như mong đợi",
  WRONG_SIZE: "Sai size",
  ITEM_WRONGDAMAGED: "Sai hoặc hỏng hàng",
  USED_PRODUCT: "Hàng đã qua sử dụng",
};

/** Yêu cầu trả hàng Shopee → kiện hoàn. null nếu không có kiện nào về kho (chỉ hoàn tiền, hoặc đã hủy/đóng). */
export function shapeShopeeReturn(r: any, shopName: string): HoanRow | null {
  const status = String(r?.status ?? "");
  if (!r?.return_sn || r?.needs_logistics === false || status === "CANCELLED" || status === "CLOSED") return null;
  // Shopee để reassessed_request_reason = "NONE" khi không xét lại: lúc đó dùng lý do khách chọn.
  const again = String(r?.reassessed_request_reason ?? "");
  const reason = again && again !== "NONE" ? again : String(r?.reason ?? "");
  return {
    key: `S:${r.return_sn}`,
    channel: "Shopee",
    shop: shopName,
    kind: "tra-hang",
    id: String(r?.order_sn ?? ""),
    codes: [...new Set([r?.tracking_number, r?.order_sn, r?.return_sn].map((x) => normSku(x == null ? "" : String(x))).filter(Boolean))],
    status: RETURN_STATUS_VI[status] ?? status,
    reason: RETURN_REASON_VI[reason] ?? reason,
    refund: r?.refund_amount == null ? null : Number(r.refund_amount),
    items: (r?.item ?? []).map((i: any) => ({ sku: normSku(i?.variation_sku || i?.item_sku), name: String(i?.name ?? ""), detail: "", quantity: Math.max(1, Number(i?.amount) || 1) })),
    since: toMs(r?.create_time),
    due: toMs(r?.return_seller_due_date) ?? toMs(r?.due_date),
  };
}

/** Đơn Pancake đi Viettel Post đang hoàn về. null nếu là đơn Shopee (lấy từ Shopee) hoặc không ở trạng thái hoàn. */
export function shapePancakeReturn(o: any): HoanRow | null {
  const status = Number(o?.status);
  const src = String(o?.order_sources_name ?? "");
  if (![4, 15].includes(status) || /shopee/i.test(src)) return null;
  const ups: any[] = Array.isArray(o?.partner?.extend_update) ? o.partner.extend_update : [];
  const lastUp = ups.reduce((best: any, u: any) => (!best || String(u?.updated_at ?? "") > String(best?.updated_at ?? "") ? u : best), null);
  const items: HoanRow["items"] = [];
  for (const it of o?.items ?? []) {
    const k = toItem(it?.variation_info, Number(it?.quantity) || 1);
    items.push({ sku: normSku(k.display_id), name: k.name, detail: k.detail, quantity: k.quantity });
  }
  return {
    key: `P:${o?.id}`,
    channel: /tik\s*tok/i.test(src) ? "TikTok" : src || "Pancake",
    shop: "Viettel Post",
    kind: status === 15 ? "hoan-mot-phan" : "giao-that-bai",
    id: String(o?.id ?? ""),
    codes: orderCodes(o),
    status: String(lastUp?.status ?? (status === 15 ? "Hoàn một phần" : "Đang hoàn")),
    reason: status === 15 ? "Hoàn một phần (thường là đơn đổi, hàng cũ về)" : "Giao không thành công",
    refund: null,
    items,
    since: toMs(o?.partner?.first_undeliverable_at) ?? toMs(o?.partner?.updated_at) ?? toMs(o?.inserted_at),
    due: null,
  };
}

async function shopeeReturns(now: number, errors: string[]): Promise<HoanRow[]> {
  const sec = Math.floor(now / 1000);
  const per = await Promise.all(
    shops().map(async (shop) => {
      const out = new Map<string, HoanRow>();
      try {
        // Ba khoảng 15 ngày chạy song song (trước đây chạy nối tiếp, mất gần 1 phút).
        const windows = [[sec - 15 * 86400, sec], [sec - 30 * 86400, sec - 15 * 86400 - 1], [sec - 45 * 86400, sec - 30 * 86400 - 1]];
        await Promise.all(
          windows.map(async ([from, to]) => {
            for (let page = 0; page < 20; page++) {
              const res = await callShopee(shop.shopId, "returns.get_return_list", { page_no: page, page_size: 100, create_time_from: from, create_time_to: to });
              const list: any[] = res.response?.return ?? [];
              for (const r of list) {
                const row = shapeShopeeReturn(r, shop.name);
                if (row) out.set(row.key, row);
              }
              if (!res.response?.more || !list.length) break;
            }
          })
        );
      } catch (err) {
        errors.push(`Shopee ${shop.name}: ${err instanceof Error ? err.message : String(err)}`);
      }
      return [...out.values()];
    })
  );
  return per.flat();
}

async function pancakeReturns(now: number, errors: string[]): Promise<{ rows: HoanRow[]; stale: number }> {
  const rows: HoanRow[] = [];
  let stale = 0;
  try {
    for (let page = 1; page <= 5; page++) {
      // Tìm "PKE" để chỉ lấy đơn Viettel Post (Pancake còn hàng nghìn đơn Shopee treo ở trạng thái đang hoàn).
      const body = await getJson("orders", { search: "PKE", page_size: 100, page_number: page, "filter_status[]": [4, 15] });
      for (const o of body?.data ?? []) {
        const row = shapePancakeReturn(o);
        if (!row) continue;
        if ((toMs(o?.inserted_at) ?? 0) < now - 60 * 86400_000) stale++;
        else rows.push(row);
      }
      const total = Number(body?.total_pages ?? 0);
      if (!body?.data?.length || (total && page >= total)) break;
    }
  } catch (err) {
    errors.push(`Pancake: ${err instanceof Error ? err.message : String(err)}`);
  }
  return { rows, stale };
}

/** Một đơn hoàn Viettel đã lưu từ báo cáo mail → kiện hoàn. */
export function shapeVtpMail(ma: string, d: VtpMailDoc): HoanRow {
  return {
    key: d.id ? `P:${d.id}` : `VTP:${ma}`,
    channel: d.channel || "Viettel Post",
    shop: "Viettel Post",
    kind: d.kind === "hoan-mot-phan" ? "hoan-mot-phan" : "giao-that-bai",
    id: d.id || ma,
    codes: [...new Set([ma, ...(d.codes ?? [])])],
    status: d.status || "Đang hoàn",
    reason: d.reason || "Giao không thành công",
    refund: null,
    items: d.items ?? [],
    since: d.first || null,
    due: null,
  };
}

/** Ghép một dòng báo cáo mail với đơn Pancake (để có sản phẩm) và bản đã lưu (giữ ngày thấy đầu tiên). */
export function vtpMailDoc(row: { ma: string; status: string; reason: string }, ngay: string, old: VtpMailDoc | undefined, orders: any[] | null, now: number): VtpMailDoc {
  const doc: VtpMailDoc = { ...(old ?? {}), status: row.status || old?.status || "", reason: row.reason || old?.reason || "", ngay, first: old?.first || now };
  const o = (orders ?? []).find((x) => orderCodes(x).includes(row.ma));
  if (o) {
    const shaped = shapeOrder([o], row.ma);
    const src = String(o?.order_sources_name ?? "");
    doc.id = String(o.id ?? "");
    doc.channel = /tik\s*tok/i.test(src) ? "TikTok" : src || "Pancake";
    doc.kind = Number(o?.status) === 15 ? "hoan-mot-phan" : "giao-that-bai";
    doc.codes = orderCodes(o);
    doc.items = shaped.found ? shaped.items.map((i) => ({ sku: normSku(i.display_id), name: i.name, detail: i.detail, quantity: i.quantity })) : [];
  }
  return doc;
}

/**
 * Nhận danh sách đơn khâu hoàn từ mail "Báo cáo vận hành" của Viettel Post (tác vụ đọc mail buổi sáng đẩy lên).
 * Chỉ nhận mã, trạng thái, lý do: không nhận tên, SĐT, địa chỉ khách. Sản phẩm lấy từ Pancake theo mã (chỉ đọc).
 */
export async function vtpMailPush(ngay: string, rowsIn: unknown): Promise<{ saved: number; matched: number; notFound: string[] }> {
  const rows = cleanVtpRows(rowsIn);
  const { docs: old } = await vtpMailGet();
  const now = Date.now();
  const docs: Record<string, VtpMailDoc> = {};
  const notFound: string[] = [];
  await pool(rows, 4, async (row) => {
    let orders: any[] | null = null;
    // Đơn đã có sản phẩm từ lần trước thì không tra lại Pancake.
    if (!old[row.ma]?.id) {
      try {
        orders = (await getJson("orders", { search: row.ma, page_size: 10, page_number: 1 }))?.data ?? [];
      } catch {
        orders = null;
      }
    }
    docs[row.ma] = vtpMailDoc(row, ngay, old[row.ma], orders, now);
    if (!docs[row.ma].id) notFound.push(row.ma);
  });
  await vtpMailSave(ngay, docs);
  return { saved: rows.length, matched: rows.length - notFound.length, notFound };
}

/**
 * Danh sách hoàn Viettel = đơn khâu hoàn theo báo cáo mail + đơn "hoàn một phần" trên Pancake
 * (đơn đổi: giao hàng mới thành công, hàng cũ quay về kho; báo cáo mail không có loại này).
 * Đơn "đang hoàn" của Pancake thì bỏ, vì mail mới là nguồn đúng cho loại đó. Đơn có ở cả hai thì giữ dòng của mail.
 */
export function mergeVtpReturns(mail: HoanRow[], pancake: HoanRow[]): HoanRow[] {
  const seen = new Set(mail.flatMap((r) => [r.key, ...r.codes]));
  return [...mail, ...pancake.filter((r) => r.kind === "hoan-mot-phan" && !seen.has(r.key) && !r.codes.some((c) => seen.has(c)))];
}

/** Số ngày từ ngày báo cáo (YYYY-MM-DD, giờ Việt Nam) đến bây giờ. */
export function reportAgeDays(ngay: string, now: number): number {
  return Math.floor((now + 7 * 3600_000 - Date.parse(`${ngay}T00:00:00Z`)) / 86400_000);
}

export async function returnsExpected(): Promise<{ at: number; returns: HoanRow[]; errors: string[]; stale: number; vtp: { from: "mail" | "pancake"; ngay: string | null } }> {
  const now = Date.now();
  const errors: string[] = [];
  let mail: Awaited<ReturnType<typeof vtpMailGet>> | null = null;
  try {
    mail = await vtpMailGet();
  } catch (err) {
    errors.push(`Danh sách hoàn Viettel từ mail: ${err instanceof Error ? err.message : String(err)}`);
  }
  // Viettel: lấy theo báo cáo mail của Viettel Post. Chưa có báo cáo nào thì tạm lấy từ Pancake và báo rõ.
  if (mail?.last) {
    const [a, p] = await Promise.all([shopeeReturns(now, errors), pancakeReturns(now, errors)]);
    const b = mergeVtpReturns(Object.entries(mail.docs).map(([ma, d]) => shapeVtpMail(ma, d)), p.rows);
    const age = reportAgeDays(mail.last.ngay, now);
    if (age > 2) errors.push(`Danh sách hoàn Viettel đang theo báo cáo mail ngày ${mail.last.ngay} (đã ${age} ngày chưa có báo cáo mới)`);
    return { at: now, returns: [...a, ...b].sort((x, y) => (x.since ?? 0) - (y.since ?? 0)), errors, stale: 0, vtp: { from: "mail", ngay: mail.last.ngay } };
  }
  const [a, b] = await Promise.all([shopeeReturns(now, errors), pancakeReturns(now, errors)]);
  errors.push("Chưa nhận được báo cáo mail Viettel Post: danh sách hoàn Viettel đang tạm lấy từ Pancake");
  const returns = [...a, ...b.rows].sort((x, y) => (x.since ?? 0) - (y.since ?? 0));
  return { at: now, returns, errors, stale: b.stale, vtp: { from: "pancake", ngay: null } };
}
