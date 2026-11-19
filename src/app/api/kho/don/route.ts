import { checkKhoKey, lookupOrder, productCodes } from "@/lib/kho";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Trang quay đóng hàng của kho mở từ file trên máy (origin "null") nên phải cho phép mọi origin; bảo vệ bằng x-mk-key.
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "x-mk-key",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Max-Age": "86400",
};
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { ...CORS, "Cache-Control": "no-store" } });

export function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS });
}

/**
 * Tra đơn cho bàn đóng hàng (chỉ đọc Pancake POS). Header bắt buộc: x-mk-key: <KHO_API_KEY>
 *   GET /api/kho/don?ma=<mã đơn | mã vận đơn | mã PKE>  → { found, order, items[] }
 *   GET /api/kho/don?danhmuc=1                           → { codes[] } mọi mã vạch + mã phân loại
 */
export async function GET(request: Request) {
  const auth = checkKhoKey(request);
  if (auth === "unset") return json({ error: "Chưa đặt KHO_API_KEY" }, 503);
  if (auth === "bad") return json({ error: "unauthorized" }, 401);
  const sp = new URL(request.url).searchParams;
  try {
    if (sp.get("danhmuc")) return json({ codes: await productCodes() });
    const ma = (sp.get("ma") ?? "").replace(/\s+/g, "").toUpperCase();
    if (!/^[A-Z0-9_-]{4,40}$/.test(ma)) return json({ error: "Mã không hợp lệ" }, 400);
    return json(await lookupOrder(ma));
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : String(err) }, 502);
  }
}
