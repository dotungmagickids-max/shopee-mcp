import { checkKhoKey, lookupOrder, ordersToPack, productCodes, returnsExpected, shopeeArrange, shopeeLabels, vtpMailPush } from "@/lib/kho";
import { cached, dayGet, dayWrite, markSet, marksGet, validDay, validKey, videoList, videoUpsert } from "@/lib/kho-store";

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
 *   GET /api/kho/don?hoan=1                              → { at, returns[], errors[], stale } kiện hoàn đang chờ về kho
 *   GET /api/kho/don?ngay=YYYY-MM-DD                     → { codes[], notes{}, resetAt, updatedAt } danh sách đơn cần đóng / soát đơn của ngày (lưu trên Supabase)
 *   GET /api/kho/don?video=<số ngày>                     → { rows[] } sổ video (không có nội dung video)
 *   GET /api/kho/don?hoanmarks=1                         → { marks{} } tình trạng kiện hoàn
 *   Thêm &moi=1 vào ?danhmuc=1 hoặc ?hoan=1 để bỏ qua bản đã lưu (danh mục lưu 6 giờ, hàng hoàn 10 phút).
 *   GET /api/kho/don?danhmuc=1                           → { codes[] } mọi mã vạch + mã phân loại
 */
export async function GET(request: Request) {
  const auth = checkKhoKey(request);
  if (auth === "unset") return json({ error: "Chưa đặt KHO_API_KEY" }, 503);
  if (auth === "bad") return json({ error: "unauthorized" }, 401);
  const sp = new URL(request.url).searchParams;
  try {
    // Hai lời gọi chậm dùng bản đã lưu (danh mục 6 giờ, hàng hoàn 10 phút); thêm &moi=1 để lấy mới ngay.
    const moi = !!sp.get("moi");
    if (sp.get("danhmuc")) return json({ codes: await cached("danhmuc", 6 * 3600_000, productCodes, (v) => v.length > 0, moi) });
    if (sp.get("xuat")) return json(await ordersToPack());
    if (sp.get("hoan")) return json(await cached("hoan", 10 * 60_000, returnsExpected, (v) => !v.errors.length, moi));
    const ngay = sp.get("ngay");
    if (ngay != null) return validDay(ngay) ? json(await dayGet(ngay)) : json({ error: "ngay phải có dạng YYYY-MM-DD" }, 400);
    if (sp.get("video")) return json(await videoList(Number(sp.get("video")) || 30));
    if (sp.get("hoanmarks")) return json(await marksGet());
    const ma = (sp.get("ma") ?? "").replace(/\s+/g, "").toUpperCase();
    if (!/^[A-Z0-9_-]{4,40}$/.test(ma)) return json({ error: "Mã không hợp lệ" }, 400);
    return json(await lookupOrder(ma));
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : String(err) }, 502);
  }
}

/**
 * Header bắt buộc: x-mk-key. Thân JSON.
 * Dữ liệu vận hành của kho (Supabase):
 *   action "ngay"     { ngay, add?: mã[], set?: mã[] (thay toàn bộ), notes?: { mã: { lyDo, xuLy } }, clearNotes?, nguon? } → danh sách ngày sau khi sửa
 *   action "video"    { may, rows: [{ fileName, code, orderId, sysId, mode, startedAt, durationSec, size, check, source, type, del? }] } → { saved, skipped }
 *   action "hoanmark" { khoa, du_lieu: { state?, note? } } → { ok }
 *   action "hoanvtp"  { ngay (ngày báo cáo), rows: [{ ma, status, reason }] } → { saved, matched, notFound[] }
 *                     đơn khâu hoàn theo mail báo cáo vận hành Viettel Post; không gửi tên, SĐT, địa chỉ khách
 * Tem vận đơn Shopee: { action, shop, orders: string[] (tối đa 50) }
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
  // Dữ liệu vận hành của kho trên Supabase (không đụng Shopee / Pancake).
  try {
    if (body?.action === "ngay") {
      if (!validDay(body?.ngay)) return json({ error: "ngay phải có dạng YYYY-MM-DD" }, 400);
      return json(await dayWrite(body.ngay, body));
    }
    if (body?.action === "video") return json(await videoUpsert(body?.rows, body?.may));
    if (body?.action === "hoanvtp") {
      if (!validDay(body?.ngay)) return json({ error: "ngay phải có dạng YYYY-MM-DD" }, 400);
      if (!Array.isArray(body?.rows)) return json({ error: "thiếu rows" }, 400);
      return json(await vtpMailPush(body.ngay, body.rows));
    }
    if (body?.action === "hoanmark") {
      if (!validKey(body?.khoa)) return json({ error: "khoa không hợp lệ" }, 400);
      await markSet(body.khoa, body?.du_lieu);
      return json({ ok: true });
    }
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : String(err) }, 502);
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
