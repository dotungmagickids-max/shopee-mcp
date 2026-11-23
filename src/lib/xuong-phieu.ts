import { ngayHopLe } from "./xuong";

/**
 * Phiếu xưởng gửi đối tác (đặt vải, đặt in thêu, giao may) lưu trên máy chủ, bảng `sx_phieu_gui`
 * (supabase/migrations/0028_sx_phieu_gui.sql). Phần kiểm và làm sạch là hàm thuần để test.
 * Đơn giá trên phiếu đặt vải CÓ lưu (anh chốt 23/11): ai có mã truy cập của xưởng đều mở lại phiếu và thấy giá đã ghi.
 * Đây là giá xưởng mua vải của nhà cung cấp, khác với giá đặt xưởng của công ty (vẫn không trả cho trang /xuong).
 */

export const LOAI_PHIEU = { vai: "DV", in: "IN", may: "GM" } as const;
export type LoaiPhieu = keyof typeof LOAI_PHIEU;

export interface PhieuGui {
  loai: LoaiPhieu;
  so: string;
  ngay: string;
  can: string;
  doiTac: string;
  lienHe: string;
  ma: string;
  lo: string;
  gui: { ten: string; diaChi: string; sdt: string; nguoi: string };
  vai: { ten: string; mau: string; sl: string; dv: string; gia: string; ghi: string }[];
  sizes: string[];
  hang: { mau: string; o: string[] }[];
  viTri: string;
  kieu: string;
  yeuCau: string;
  ghiChu: string;
}

export type KetQuaPhieu = { ok: true; id: number | null; nguoi: string; phieu: PhieuGui } | { ok: false; error: string };

const KY_TU_LA = /[\u0000-\u001f\u007f]/;
const DON_VI = ["kg", "cây", "m"];

class Sai extends Error {}

function chu(v: unknown, ten: string, max: number, nhieuDong = false): string {
  if (v === undefined || v === null) return "";
  if (typeof v !== "string") throw new Sai(`${ten} không hợp lệ`);
  const s = nhieuDong ? v.replace(/\r\n?/g, "\n").trim() : v.replace(/\s+/g, " ").trim();
  if (KY_TU_LA.test(nhieuDong ? s.replace(/\n/g, " ") : s)) throw new Sai(`${ten} không hợp lệ`);
  if (s.length > max) throw new Sai(`${ten} dài quá ${max} ký tự`);
  return s;
}

/** Số lượng gõ tay: chữ số, dấu chấm, dấu phẩy; trống cũng được. */
function soGo(v: unknown, ten: string): string {
  const s = chu(typeof v === "number" ? String(v) : v, ten, 12);
  if (s && !/^[\d.,\s]+$/.test(s)) throw new Sai(`${ten} phải là số`);
  return s;
}

const soDuong = (s: string): number => {
  const n = Number(s.replace(/[.\s]/g, "").replace(",", "."));
  return Number.isFinite(n) && n > 0 ? n : 0;
};

function mang(v: unknown, ten: string, max: number): unknown[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.length > max) throw new Sai(`${ten} không hợp lệ`);
  return v;
}

const doiTuong = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/**
 * Kiểm và làm sạch phiếu từ thân POST `{ action: "phieu_luu", id?, nguoi?, phieu }`.
 * Chỉ giữ các trường biết trước; mọi trường lạ bị bỏ.
 */
export function docPhieu(body: unknown): KetQuaPhieu {
  try {
    const b = doiTuong(body);
    const p = doiTuong(b.phieu);
    if (!Object.keys(p).length) throw new Sai("Thiếu nội dung phiếu");
    const id = b.id === undefined || b.id === null || b.id === "" ? null : Number(b.id);
    if (id !== null && (!Number.isSafeInteger(id) || id <= 0)) throw new Sai("Mã phiếu không hợp lệ");

    const loai = p.loai as LoaiPhieu;
    if (!Object.hasOwn(LOAI_PHIEU, loai as string)) throw new Sai('Loại phiếu phải là "vai", "in" hoặc "may"');
    const so = chu(p.so, "Số phiếu", 30).toUpperCase();
    if (!/^[\p{L}\p{N}][\p{L}\p{N}._/-]{2,29}$/u.test(so)) throw new Sai("Số phiếu chỉ gồm chữ, số, dấu gạch (3 đến 30 ký tự)");
    if (!ngayHopLe(p.ngay)) throw new Sai("Ngày lập phải có dạng YYYY-MM-DD");
    const can = chu(p.can, "Ngày cần", 10);
    if (can && !ngayHopLe(can)) throw new Sai("Ngày cần phải có dạng YYYY-MM-DD");
    const doiTac = chu(p.doiTac, "Tên đối tác", 80);
    if (!doiTac) throw new Sai("Chưa ghi tên đối tác");

    const g = doiTuong(p.gui);
    const gui = { ten: chu(g.ten, "Tên đơn vị gửi", 80), diaChi: chu(g.diaChi, "Địa chỉ", 160), sdt: chu(g.sdt, "Điện thoại", 30), nguoi: chu(g.nguoi, "Người lập phiếu", 60) };
    if (!gui.ten) throw new Sai("Chưa ghi tên đơn vị gửi phiếu");

    const vai = mang(p.vai, "Danh sách vải", 30)
      .map((x) => {
        const v = doiTuong(x);
        const dv = chu(v.dv, "Đơn vị", 5) || "kg";
        if (!DON_VI.includes(dv)) throw new Sai("Đơn vị vải phải là kg, cây hoặc m");
        return { ten: chu(v.ten, "Loại vải", 80), mau: chu(v.mau, "Màu vải", 40), sl: soGo(v.sl, "Số lượng vải"), dv, gia: soGo(v.gia, "Đơn giá"), ghi: chu(v.ghi, "Ghi chú vải", 120) };
      })
      .filter((v) => v.ten || v.mau || v.sl);
    const sizes = mang(p.sizes, "Danh sách size", 10).map((s) => chu(s, "Size", 8)).filter(Boolean);
    const hang = mang(p.hang, "Bảng màu × size", 30)
      .map((x) => {
        const h = doiTuong(x);
        const o = mang(h.o, "Số lượng theo size", 10).map((n) => soGo(n, "Số lượng"));
        return { mau: chu(h.mau, "Màu", 30), o: sizes.map((_, i) => o[i] ?? "") };
      })
      .filter((h) => h.mau || h.o.some(Boolean));

    if (loai === "vai" ? !vai.some((v) => v.ten && soDuong(v.sl) > 0) : !hang.some((h) => h.o.some((n) => soDuong(n) > 0))) {
      throw new Sai(loai === "vai" ? "Chưa có dòng vải nào đủ loại vải và số lượng" : "Chưa có số lượng nào");
    }
    const phieu: PhieuGui = {
      loai, so, ngay: p.ngay as string, can, doiTac,
      lienHe: chu(p.lienHe, "Người nhận", 80),
      ma: chu(p.ma, "Mã hàng", 30).toUpperCase(),
      lo: chu(p.lo, "Lô", 40),
      gui,
      vai: loai === "vai" ? vai : [],
      sizes: loai === "vai" ? [] : sizes,
      hang: loai === "vai" ? [] : hang,
      viTri: loai === "in" ? chu(p.viTri, "Vị trí in", 160) : "",
      kieu: loai === "in" ? chu(p.kieu, "Kiểu in", 160) : "",
      yeuCau: loai === "vai" ? "" : chu(p.yeuCau, "Yêu cầu", 800, true),
      ghiChu: chu(p.ghiChu, "Ghi chú", 800, true),
    };
    const nguoi = chu(b.nguoi, "Tên người ghi", 40) || gui.nguoi.slice(0, 40) || "xưởng";
    return { ok: true, id, nguoi, phieu };
  } catch (e) {
    if (e instanceof Sai) return { ok: false, error: e.message };
    throw e;
  }
}

const SO_TU_DANH = /^(DV|IN|GM)-(\d{6})-(\d{1,4})$/;

/**
 * Số phiếu kế tiếp khi số máy gửi lên đã có người dùng (hai máy cùng làm phiếu trong ngày).
 * Chỉ tự đổi với số do máy tự đánh (DV-261123-01); số người gõ tay thì trả null để báo trùng.
 */
export function soTiep(so: string, daCo: string[]): string | null {
  const m = so.match(SO_TU_DANH);
  if (!m) return null;
  const goc = `${m[1]}-${m[2]}-`;
  const max = Math.max(0, ...daCo.filter((x) => x.startsWith(goc)).map((x) => Number(x.slice(goc.length)) || 0));
  return goc + String(max + 1).padStart(2, "0");
}

/** Một dòng trong danh sách trả về cho trang /xuong. */
export interface PhieuDaLuu {
  id: number;
  so: string;
  nguoi: string;
  suaLuc: string;
  phieu: PhieuGui;
}

type Loi = { code?: string | null; message?: string | null };
/** Bảng `sx_phieu_gui` chưa có (chưa áp migration 0028). */
export const chuaCoBang = (e: Loi): boolean =>
  e.code === "42P01" || e.code === "PGRST205" || /sx_phieu_gui.*(does not exist|schema cache)|could not find the table/i.test(e.message ?? "");
export const trungSo = (e: Loi): boolean => e.code === "23505";
export const CHUA_BAT_PHIEU = "Máy chủ chưa bật phần lưu phiếu";
