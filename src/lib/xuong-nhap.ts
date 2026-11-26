import { loiDongTrung } from "./san-xuat";
import { NGUON_XUONG, ngayHopLe } from "./xuong";

/**
 * Xưởng tự nhập phiếu cắt và phiếu đóng gói (giao hàng) ở trang /xuong. Số vào Sổ hàng xưởng NGAY (anh chốt 23/11),
 * qua đúng các hàm `mk_sx_lot_save`, `mk_sx_arrival_save` đang có, nên luật kiểm và nhật ký vẫn chạy.
 *   Phiếu cắt     → lô cắt với số cắt màu × size.
 *   Phiếu đóng gói → một lần hàng về với số XƯỞNG GIAO; số kho đếm để trống, kho Magickids đếm rồi mới tính là đã về.
 * Hàm thuần, không gọi database: route `/api/xuong` và test dùng chung.
 */

export type LenhNhap =
  | { ok: true; loai: "cat"; fn: "mk_sx_lot_save"; args: Record<string, unknown>; ma: string; lo: string; ghiDe: boolean; congThem: boolean; ngayCat: string; nguoi: string; tong: number }
  | { ok: true; loai: "giao"; fn: "mk_sx_arrival_save"; args: Record<string, unknown>; ma: string; lo: string; tong: number }
  | { ok: true; loai: "giao_sua"; fn: "mk_sx_arrival_save"; args: Record<string, unknown>; id: number; huy: boolean; tong: number }
  | { ok: false; error: string };

const sai = (error: string): LenhNhap => ({ ok: false, error });
const KY_TU_LA = /[\u0000-\u001f\u007f]/;
const chu = (v: unknown): string | null => {
  if (typeof v !== "string") return null;
  const s = v.replace(/\s+/g, " ").trim();
  return KY_TU_LA.test(s) ? null : s;
};
const trong = (v: unknown) => v === undefined || v === null || v === "";

/** Số nguyên dương gõ tay ("1.200", " 35 "); trống hoặc 0 trả 0; sai trả null. */
export function soNguyen(v: unknown): number | null {
  if (trong(v)) return 0;
  const s = typeof v === "number" ? String(v) : typeof v === "string" ? v.replace(/[.\s]/g, "") : "x";
  if (!/^\d{1,7}$/.test(s)) return null;
  return Number(s);
}

/** Giờ Việt Nam dạng HH:MM:SS, dùng làm dấu phân biệt các lần giao trong cùng một ngày. */
const gioVN = (now: number) => new Date(now + 7 * 3600_000).toISOString().slice(11, 19);

/**
 * Đọc thân POST của /api/xuong:
 *   { action: "cat",  ma_hang, lo, ngay_cat?, hen_tra?, dot_dat?, ghi_de? | cong_them?, dong: [{ mau, size, so }], nguoi }
 *   { action: "giao", ma_hang, lo, ngay, so_phieu?, dong: [{ mau, size, so }], nguoi }
 *   { action: "giao_sua", id, ngay, so_phieu?, huy?, dong: [{ mau, size, so }], nguoi }   (sửa phiếu đóng gói kho chưa đếm; huy = đưa mọi dòng về 0)
 * Dòng có số 0 hoặc trống bị bỏ. `ghi_de` = thay số cắt của lô đã có (không đổi ngày hẹn ở đây).
 * `cong_them` = lần cắt tiếp của lô đã có (một lô cắt nhiều lần, anh dặn 25/11): route cộng số mới vào số cũ bằng `congDongCat`.
 */
export function docLenhNhap(body: unknown, homNay: string, now: number = Date.now()): LenhNhap {
  if (!body || typeof body !== "object" || Array.isArray(body)) return sai("Thân yêu cầu phải là một đối tượng JSON");
  const b = body as Record<string, unknown>;
  if (b.action !== "cat" && b.action !== "giao" && b.action !== "giao_sua") return sai('action phải là "cat", "giao" hoặc "giao_sua"');
  const nguoi = chu(b.nguoi);
  if (nguoi == null || nguoi.length < 2 || nguoi.length > 40) return sai("Cần tên người nhập (2 đến 40 ký tự)");
  const laSua = b.action === "giao_sua";
  const huy = laSua && b.huy === true;
  const id = Number(b.id);
  if (laSua && (!Number.isSafeInteger(id) || id <= 0)) return sai("Mã phiếu đóng gói không hợp lệ");
  // Sửa phiếu không đổi mã hàng, lô: phiếu vẫn thuộc lô cũ.
  const ma = laSua ? "" : (chu(b.ma_hang)?.toUpperCase() ?? "");
  if (!laSua && !/^[A-Z0-9][A-Z0-9._-]{2,29}$/.test(ma)) return sai("Mã hàng không hợp lệ");
  const lo = laSua ? "" : chu(b.lo);
  if (!laSua && (lo == null || lo.length < 1 || lo.length > 30)) return sai("Tên lô không hợp lệ");

  if (!Array.isArray(b.dong) || b.dong.length > 300) return sai("Bảng màu × size không hợp lệ");
  const dong: { mau: string; size: string; so: number }[] = [];
  for (const x of b.dong) {
    const d = (x && typeof x === "object" ? x : {}) as Record<string, unknown>;
    const mau = chu(d.mau ?? "");
    const size = chu(typeof d.size === "number" ? String(d.size) : (d.size ?? ""));
    if (mau == null || mau.length > 40) return sai("Tên màu không hợp lệ");
    if (size == null || size.length > 10) return sai("Size không hợp lệ");
    const so = soNguyen(d.so);
    if (so == null || so > 100_000) return sai(`Số lượng màu "${mau}" size "${size}" phải là số nguyên từ 0 đến 100.000`);
    // Hủy phiếu: giữ các dòng với số 0 (database cần ít nhất một dòng).
    if (so > 0 || huy) dong.push({ mau, size, so: huy ? 0 : so });
  }
  if (!dong.length) return sai("Chưa có số lượng nào");
  const trung = loiDongTrung(dong);
  if (trung) return sai(trung);
  const tong = dong.reduce((a, d) => a + d.so, 0);
  const agent = `Xưởng: ${nguoi}`;

  const ngay = (v: unknown, ten: string, batBuoc: boolean): string | null | LenhNhap => {
    if (trong(v)) return batBuoc ? sai(`Chưa ghi ${ten}`) : null;
    if (!ngayHopLe(v)) return sai(`${ten} phải có dạng YYYY-MM-DD`);
    if (v < "2020-01-01") return sai(`${ten} quá xa trong quá khứ`);
    return v;
  };

  if (b.action === "cat") {
    const ghiDe = b.ghi_de === true;
    const congThem = b.cong_them === true;
    if (ghiDe && congThem) return sai("Chỉ chọn một: thay số cắt hoặc cộng thêm lần cắt");
    const ngayCat = ngay(b.ngay_cat, "ngày cắt", true);
    if (ngayCat && typeof ngayCat === "object") return ngayCat;
    if ((ngayCat as string) > homNay) return sai("Ngày cắt không được ở tương lai");
    const hen = ngay(b.hen_tra, "ngày hẹn trả", false);
    if (hen && typeof hen === "object") return hen;
    if (hen && hen < (ngayCat as string)) return sai("Ngày hẹn trả không được trước ngày cắt");
    // "" là đợt rỗng của phiếu đặt chỉ có một đợt (trang chọn theo phiếu gửi đúng đợt của phiếu); thiếu hẳn thì không nối phiếu.
    const dot = b.dot_dat === undefined || b.dot_dat === null ? null : chu(b.dot_dat);
    if (dot != null && dot.length > 30) return sai("Đợt của phiếu đặt không hợp lệ");
    return {
      ok: true, loai: "cat", fn: "mk_sx_lot_save", ma, lo: lo as string, ghiDe, congThem, ngayCat: ngayCat as string, nguoi, tong,
      args: {
        p_agent: agent, p_ma_hang: ma, p_lo: lo, p_nguon: `${NGUON_XUONG}, phiếu cắt: ${nguoi}`,
        p_lines: dong.map((d) => ({ mau: d.mau, size: d.size, so_cat: d.so })),
        p_ngay_cat: ngayCat,
        // Lô đã có thì ngày hẹn chỉ đổi qua mục "Đổi ngày hẹn trả" để giữ lịch sử.
        p_hen_tra: ghiDe || congThem ? null : hen,
        p_dot_dat: dot,
      },
    };
  }

  const ngayGiao = ngay(b.ngay, "ngày giao", true);
  if (ngayGiao && typeof ngayGiao === "object") return ngayGiao;
  if ((ngayGiao as string) > homNay) return sai("Ngày giao không được ở tương lai");
  const soPhieu = trong(b.so_phieu) ? "" : chu(b.so_phieu);
  if (soPhieu == null || soPhieu.length > 60) return sai("Số phiếu của xưởng không hợp lệ");
  if (laSua) {
    return {
      ok: true, loai: "giao_sua", fn: "mk_sx_arrival_save", id, huy, tong,
      args: {
        p_agent: agent,
        p_nguon: `${NGUON_XUONG}, phiếu đóng gói: ${nguoi} · ${huy ? "hủy" : "sửa"} lúc ${gioVN(now)}`,
        p_id: id, p_ngay: ngayGiao,
        p_lines: dong.map((d) => ({ mau: d.mau, size: d.size, xuong_giao: d.so })),
        p_so_phieu_xuong: soPhieu || null,
        p_ghi_chu: huy ? "Xưởng hủy phiếu nhập nhầm" : null,
      },
    };
  }
  return {
    ok: true, loai: "giao", fn: "mk_sx_arrival_save", ma, lo: lo as string, tong,
    args: {
      p_agent: agent,
      // Nguồn phải khác nhau giữa các lần giao cùng lô cùng ngày (database từ chối lần trùng lô, ngày, nguồn).
      p_nguon: `${NGUON_XUONG}, phiếu đóng gói: ${nguoi} · ${soPhieu ? `phiếu ${soPhieu}` : `nhập lúc ${gioVN(now)}`}`,
      p_ma_hang: ma, p_lo: lo, p_ngay: ngayGiao,
      p_lines: dong.map((d) => ({ mau: d.mau, size: d.size, xuong_giao: d.so })),
      p_so_phieu_xuong: soPhieu || null,
    },
  };
}

type DongCat = { mau: string; size: string; so_cat: number };

/**
 * Lần cắt tiếp của một lô đã có: cộng số mới vào số cũ theo màu × size (màu, size so không phân biệt hoa thường, khoảng trắng).
 * Giữ tên màu như dòng cũ; màu, size mới thì thêm dòng. Trả đủ các dòng để `mk_sx_lot_save` thay toàn bộ.
 */
export function congDongCat(cu: DongCat[], moi: DongCat[]): DongCat[] {
  const khoa = (d: DongCat) => `${d.mau.replace(/\s+/g, " ").trim().toLowerCase()}|${d.size.trim().toLowerCase()}`;
  const kq = cu.map((d) => ({ mau: d.mau, size: d.size, so_cat: d.so_cat }));
  const viTri = new Map(kq.map((d, i) => [khoa(d), i]));
  for (const d of moi) {
    const i = viTri.get(khoa(d));
    if (i === undefined) {
      viTri.set(khoa(d), kq.length);
      kq.push({ ...d });
    } else kq[i].so_cat += d.so_cat;
  }
  return kq;
}

/** Nguồn của lô sau khi cộng một lần cắt: giữ nguồn cũ, nối thêm lần cắt mới (database cắt ở 500 ký tự). */
export function nguonCongThem(cu: string | null, ngayCat: string, tong: number, nguoi: string): string {
  const them = `thêm lần cắt ${ngayCat.slice(8, 10)}/${ngayCat.slice(5, 7)} (${tong} cái): ${nguoi}`;
  return cu ? `${cu} · ${them}` : `${NGUON_XUONG}, ${them}`;
}

/** Đổi lỗi database khi nhập phiếu thành câu cho xưởng. Lỗi luật (P0001) đã là tiếng Việt, chỉ bỏ tên hàm nội bộ. */
export function loiNhap(err: { code?: string | null; message?: string | null }): { status: number; error: string } {
  const m = err.message ?? "";
  if (err.code === "P0001" && m) {
    return {
      status: 400,
      error: m
        .replace(/\.?\s*Ghi lô cắt trước \(mk_sx_lot_save\)[^.]*/, ". Nhập phiếu cắt của lô này trước")
        .replace(/\.?\s*Đổi ngày hẹn phải dùng mk_sx_lot_reschedule[^.]*/, '. Đổi ngày hẹn ở mục "Cập nhật tiến độ"')
        .replace(/\.?\s*Muốn sửa thì truyền id/, ". Phiếu này đã nhập rồi"),
    };
  }
  return { status: 502, error: "Máy chủ chưa ghi được, thử lại sau ít phút" };
}
