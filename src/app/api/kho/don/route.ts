import { checkKhoKey, lookupOrder, ordersToPack, productCodes, shopeeArrange, shopeeLabels } from "@/lib/kho";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Trang quay đóng hàng của kho mở từ file trên máy (origin "null") nên phải cho phép mọi origin; bảo vệ bằng x-mk-key.
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "x-mk-key, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Max-Age": "86400",
};
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { ...CORS, "Cache-Control": "no-store" } });

export function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS });
}

/**
 * Tra đơn cho bàn đóng hàng (chỉ đọc Pancake POS). Header bắt buộc: x-mk-key: <KHO_API_KEY>
 *   GET /api/kho/don?ma=<mã đơn | mã vận đơn | mã PKE>  → { found, order, items[] }
 *   GET /api/kho/don?xuat=1                              → { at, orders[], errors[] } đơn cần đóng: Shopee (API), TikTok + Facebook (Pancake)
 *   GET /api/kho/don?danhmuc=1                           → { codes[] } mọi mã vạch + mã phân loại
 */
export async function GET(request: Request) {
  const auth = checkKhoKey(request);
  if (auth === "unset") return json({ error: "Chưa đặt KHO_API_KEY" }, 503);
  if (auth === "bad") return json({ error: "unauthorized" }, 401);
  const sp = new URL(request.url).searchParams;
  try {
    if (sp.get("danhmuc")) return json({ codes: await productCodes() });
    if (sp.get("xuat")) return json(await ordersToPack());
    const ma = (sp.get("ma") ?? "").replace(/\s+/g, "").toUpperCase();
    if (!/^[A-Z0-9_-]{4,40}$/.test(ma)) return json({ error: "Mã không hợp lệ" }, 400);
    return json(await lookupOrder(ma));
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : String(err) }, 502);
  }
}

/**
 * Tem vận đơn Shopee. Header bắt buộc: x-mk-key. Thân JSON: { action, shop, orders: string[] (tối đa 50) }
 *   action "tem"     → { files: [{ type, carrier, orders[], pdf (base64) }], failed: [{ id, reason }] }. Không đổi trạng thái đơn.
 *   action "chuanbi" → { done[], failed[] }. Bấm "chuẩn bị hàng" trên Shopee (lệnh ghi thật); chỉ chạy khi máy chủ đặt KHO_CHUAN_BI=1.
 *                      Thêm cach: "pickup" (mặc định, hãng tới lấy) | "dropoff" (tự mang ra bưu cục).
 */
export async function POST(request: Request) {
  const auth = checkKhoKey(request);
  if (auth === "unset") return json({ error: "Chưa đặt KHO_API_KEY" }, 503);
  if (auth === "bad") return json({ error: "unauthorized" }, 401);
  let body: any;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Thân yêu cầu không phải JSON" }, 400);
  }
  const shop = String(body?.shop ?? "");
  const orders = [...new Set((Array.isArray(body?.orders) ? body.orders : []).map((x: unknown) => String(x).trim().toUpperCase()))] as string[];
  if (!shop || !orders.length || orders.length > 50 || orders.some((x) => !/^[A-Z0-9]{10,20}$/.test(x))) return json({ error: "Cần shop và 1 đến 50 mã đơn Shopee hợp lệ" }, 400);
  try {
    if (body?.action === "tem") return json(await shopeeLabels(shop, orders));
    if (body?.action === "chuanbi") return json(await shopeeArrange(shop, orders, body?.cach === "dropoff" ? "dropoff" : "pickup"));
    return json({ error: "action phải là tem hoặc chuanbi" }, 400);
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : String(err) }, 502);
  }
}
