import { homNayVN } from "@/lib/san-xuat";
import { docSoSanXuat } from "@/lib/san-xuat-data";
import { db } from "@/lib/supabase";
import { pancakeStock } from "@/lib/kho";
import { cached } from "@/lib/kho-store";
import { checkXuongKey, docLenhGhi, docMaAnh, locAnh, loiGhi, soChoXuong } from "@/lib/xuong";
import { docAnhPhieu, docAnhVao } from "@/lib/xuong-doc-anh";
import { docLenhNhap, loiNhap } from "@/lib/xuong-nhap";
import { CHUA_BAT_PHIEU, chuaCoBang, docPhieu, soTiep, trungSo, type PhieuDaLuu, type PhieuGui } from "@/lib/xuong-phieu";

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
 *   GET /api/xuong?anh=MA1,MA2 → { anh: { MA1: "https://…" } } ảnh đại diện theo mã hàng (đọc Pancake, lưu tạm 6 giờ); mã chưa có ảnh thì không có trong kết quả
 *   GET /api/xuong?phieu=1 → { phieu: [{ id, so, nguoi, suaLuc, phieu }] } phiếu gửi đối tác đã lưu (có đơn giá vải nếu xưởng đã ghi); { chuaBat: true } khi chưa có bảng
 */
export async function GET(request: Request) {
  const tuChoi = chan(request);
  if (tuChoi) return tuChoi;
  const sp = new URL(request.url).searchParams;
  if (sp.get("phieu")) return docDanhSachPhieu();
  if (sp.get("anh")) return docAnh(docMaAnh(sp.get("anh")));
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
 *   { action: "cat", ma_hang, lo, ngay_cat, hen_tra?, dot_dat?, ghi_de?, dong: [{ mau, size, so }], nguoi }     → phiếu cắt: số cắt vào sổ ngay
 *   { action: "giao", ma_hang, lo, ngay, so_phieu?, dong: [{ mau, size, so }], nguoi }                        → phiếu đóng gói: số xưởng giao, chờ kho đếm
 *   { action: "doc_anh", loai: "cat" | "giao" | "vai", anh: "data:image/…;base64,…" }                         → AI đọc ảnh phiếu ra bảng để soát, KHÔNG ghi gì
 *   { action: "phieu_luu", id?, nguoi?, phieu }                                                → lưu phiếu gửi đối tác, trả { ok, id, so }
 *   { action: "phieu_xoa", id, nguoi? }                                                        → xóa mềm phiếu
 * Trả { ok: true } hoặc { error } tiếng Việt. Không ghi số kho đếm, không đụng Pancake.
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
  const action = (body as { action?: unknown } | null)?.action;
  if (action === "phieu_luu") return luuPhieu(body);
  if (action === "phieu_xoa") return xoaPhieu(body);
  if (action === "cat" || action === "giao") return nhapPhieu(body);
  if (action === "doc_anh") return docAnh1(body);
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

// ---------- Phiếu gửi đối tác (bảng sx_phieu_gui) ----------

const BANG = "sx_phieu_gui";
const loiPhieu = (viec: string, error: { code?: string | null; message?: string | null }): Response => {
  if (chuaCoBang(error)) return json({ error: CHUA_BAT_PHIEU, chuaBat: true }, 501);
  console.error(`[xuong] ${viec} lỗi:`, error.message);
  return json({ error: "Máy chủ chưa lưu được phiếu, thử lại sau ít phút" }, 502);
};

async function docDanhSachPhieu(): Promise<Response> {
  try {
    const { data, error } = await db()
      .from(BANG)
      .select("id, so, nguoi_ghi, sua_luc, noi_dung")
      .is("xoa_luc", null)
      .order("ngay", { ascending: false })
      .order("id", { ascending: false })
      .limit(200);
    if (error) return chuaCoBang(error) ? json({ phieu: [], chuaBat: true }) : loiPhieu("đọc phiếu", error);
    const phieu: PhieuDaLuu[] = (data ?? []).map((r) => ({
      id: r.id as number,
      so: r.so as string,
      nguoi: r.nguoi_ghi as string,
      suaLuc: r.sua_luc as string,
      phieu: { ...(r.noi_dung as PhieuGui), so: r.so as string },
    }));
    return json({ phieu });
  } catch (err) {
    console.error("[xuong] đọc phiếu lỗi:", err);
    return json({ error: "Máy chủ chưa đọc được phiếu, thử lại sau ít phút" }, 502);
  }
}

async function luuPhieu(body: unknown): Promise<Response> {
  const r = docPhieu(body);
  if (!r.ok) return json({ error: r.error }, 400);
  const dong = (p: PhieuGui) => ({ so: p.so, loai: p.loai, ngay: p.ngay, doi_tac: p.doiTac, ma_hang: p.ma, lo: p.lo, noi_dung: p, nguoi_ghi: r.nguoi });
  try {
    if (r.id != null) {
      const { data, error } = await db()
        .from(BANG)
        .update({ ...dong(r.phieu), sua_luc: new Date().toISOString() })
        .eq("id", r.id)
        .is("xoa_luc", null)
        .select("id, so");
      if (error) return trungSo(error) ? json({ error: `Số phiếu ${r.phieu.so} đã có phiếu khác dùng` }, 400) : loiPhieu("sửa phiếu", error);
      if (!data?.length) return json({ error: "Không còn phiếu này trên máy chủ (đã bị xóa)" }, 404);
      return json({ ok: true, id: data[0].id, so: data[0].so });
    }
    // Phiếu mới: số do máy tự đánh mà trùng (hai máy cùng làm) thì máy chủ đánh số kế tiếp, thử vài lần.
    let phieu = r.phieu;
    for (let lan = 0; lan < 4; lan++) {
      const { data, error } = await db().from(BANG).insert(dong(phieu)).select("id, so");
      if (!error) return json({ ok: true, id: data?.[0]?.id, so: data?.[0]?.so ?? phieu.so });
      if (!trungSo(error)) return loiPhieu("lưu phiếu", error);
      const goc = phieu.so.replace(/\d+$/, "");
      const co = await db().from(BANG).select("so").is("xoa_luc", null).like("so", `${goc}%`).limit(1000);
      if (co.error) return loiPhieu("đọc số phiếu", co.error);
      const moi = soTiep(phieu.so, (co.data ?? []).map((x) => x.so as string));
      if (!moi) return json({ error: `Số phiếu ${phieu.so} đã có phiếu khác dùng. Đổi số phiếu rồi lưu lại` }, 400);
      phieu = { ...phieu, so: moi };
    }
    return json({ error: "Chưa đánh được số phiếu, thử lại" }, 502);
  } catch (err) {
    console.error("[xuong] lưu phiếu lỗi:", err);
    return json({ error: "Máy chủ chưa lưu được phiếu, thử lại sau ít phút" }, 502);
  }
}

async function xoaPhieu(body: unknown): Promise<Response> {
  const id = Number((body as { id?: unknown } | null)?.id);
  if (!Number.isSafeInteger(id) || id <= 0) return json({ error: "Mã phiếu không hợp lệ" }, 400);
  try {
    const { error } = await db().from(BANG).update({ xoa_luc: new Date().toISOString() }).eq("id", id).is("xoa_luc", null);
    if (error) return loiPhieu("xóa phiếu", error);
    return json({ ok: true });
  } catch (err) {
    console.error("[xuong] xóa phiếu lỗi:", err);
    return json({ error: "Máy chủ chưa xóa được phiếu, thử lại sau ít phút" }, 502);
  }
}

// ---------- Ảnh đại diện sản phẩm (chỉ đọc Pancake) ----------

async function docAnh(ma: string[]): Promise<Response> {
  if (!ma.length) return json({ anh: {} });
  try {
    // Một lượt đọc danh mục Pancake cho mọi mã, lưu tạm 6 giờ; chỉ trả ảnh của các mã được hỏi.
    const tatCa = await cached("xuong-anh", 6 * 3600_000, async () => (await pancakeStock()).images, (v) => v.length > 0);
    return json({ anh: locAnh(tatCa, ma) });
  } catch (err) {
    console.error("[xuong] đọc ảnh lỗi:", err instanceof Error ? err.message : err);
    return json({ anh: {}, loi: true });
  }
}

// ---------- Xưởng nhập phiếu cắt, phiếu đóng gói (vào sổ ngay) ----------

async function nhapPhieu(body: unknown): Promise<Response> {
  const lenh = docLenhNhap(body, homNayVN());
  if (!lenh.ok) return json({ error: lenh.error }, 400);
  try {
    if (lenh.loai === "cat") {
      // Lô đã có số cắt thì phải bấm ghi đè rõ ràng, tránh nhập nhầm tên lô làm mất số cũ.
      const co = await db().from("sx_lo_cat").select("id").eq("ma_hang", lenh.ma).eq("lo", lenh.lo).maybeSingle();
      if (co.error) {
        console.error("[xuong] kiểm lô lỗi:", co.error.message);
        return json({ error: loiNhap({}).error }, 502);
      }
      if (co.data && !lenh.ghiDe) return json({ error: `Lô ${lenh.ma} ${lenh.lo} đã có số cắt`, daCo: true }, 409);
      if (!co.data && lenh.ghiDe) return json({ error: `Chưa có lô ${lenh.ma} ${lenh.lo} để ghi đè` }, 400);
    }
    const { error } = await db().rpc(lenh.fn, lenh.args);
    if (error) {
      const loi = loiNhap(error);
      if (loi.status === 502) console.error(`[xuong] ${lenh.fn} lỗi:`, error.message);
      return json({ error: loi.error }, loi.status);
    }
    return json({ ok: true, tong: lenh.tong });
  } catch (err) {
    console.error(`[xuong] ${lenh.fn} lỗi:`, err);
    return json({ error: loiNhap({}).error }, 502);
  }
}

// ---------- Đọc ảnh phiếu ra bảng (không ghi database) ----------

async function docAnh1(body: unknown): Promise<Response> {
  const anh = docAnhVao(body);
  if (!anh.ok) return json({ error: anh.error }, 400);
  try {
    const r = await docAnhPhieu(anh, homNayVN());
    if (!r.ok) return json({ error: r.error, chuaBat: r.status === 501 ? true : undefined }, r.status);
    return json(r.loai === "vai" ? { ok: true, loai: r.loai, vai: r.vai } : { ok: true, loai: r.loai, bang: r.bang });
  } catch (err) {
    console.error("[xuong] đọc ảnh lỗi:", err instanceof Error ? err.message : err);
    return json({ error: "Máy đọc ảnh đang lỗi, thử lại sau hoặc nhập tay" }, 502);
  }
}
