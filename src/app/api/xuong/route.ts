import { homNayVN } from "@/lib/san-xuat";
import { docSoSanXuat } from "@/lib/san-xuat-data";
import { db } from "@/lib/supabase";
import { checkXuongKey, docLenhGhi, loiGhi, soChoXuong } from "@/lib/xuong";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Trang /xuong nằm cùng máy chủ nên không mở CORS.
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

/** Mã của xưởng (XUONG_API_KEY) tách riêng với mã của kho: xưởng không gọi được API kho. */
function chan(request: Request): Response | null {
  const auth = checkXuongKey(request);
  if (auth === "unset") return json({ error: "Chưa đặt XUONG_API_KEY" }, 503);
  if (auth === "trung") return json({ error: "XUONG_API_KEY phải khác KHO_API_KEY" }, 503);
  if (auth === "bad") return json({ error: "Mã truy cập không đúng" }, 401);
  return null;
}

/**
 * Sổ hàng xưởng cho trang /xuong. Header bắt buộc: x-mk-key: <XUONG_API_KEY>
 *   GET /api/xuong → { at, homNay, tomTat, ghiThongTin, don[], los[] } đã bỏ giá, ghi chú nội bộ và số phiếu Pancake
 */
export async function GET(request: Request) {
  const tuChoi = chan(request);
  if (tuChoi) return tuChoi;
  try {
    return json(soChoXuong(await docSoSanXuat(), homNayVN()));
  } catch (err) {
    console.error("[xuong] đọc sổ lỗi:", err);
    return json({ error: "Máy chủ chưa đọc được sổ hàng xưởng, thử lại sau ít phút" }, 502);
  }
}

/**
 * Xưởng tự cập nhật một lô ĐÃ CÓ. Header bắt buộc: x-mk-key. Thân JSON:
 *   { action: "hen", ma_hang, lo, ngay_hen, ly_do, nguoi }                                      → đổi ngày hẹn trả (lưu lịch sử)
 *   { action: "thongtin", ma_hang, lo, ngay_chot?, xuong?, ngay_vai_ve?, thong_tin_sx?, nguoi } → ghi thông tin sản xuất (cần migration 0026)
 * Trả { ok: true } hoặc { error } tiếng Việt. Không ghi số cắt, số hàng về, không đụng Pancake.
 */
export async function POST(request: Request) {
  const tuChoi = chan(request);
  if (tuChoi) return tuChoi;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Thân yêu cầu không phải JSON" }, 400);
  }
  const lenh = docLenhGhi(body, homNayVN());
  if (!lenh.ok) return json({ error: lenh.error }, 400);
  try {
    const { error } = await db().rpc(lenh.fn, lenh.args);
    if (error) {
      const loi = loiGhi(lenh.fn, error);
      if (loi.status === 502) console.error(`[xuong] ${lenh.fn} lỗi:`, error.message);
      return json({ error: loi.error, chuaBat: loi.chuaBat }, loi.status);
    }
    return json({ ok: true });
  } catch (err) {
    console.error(`[xuong] ${lenh.fn} lỗi:`, err);
    return json({ error: loiGhi("", {}).error }, 502);
  }
}
