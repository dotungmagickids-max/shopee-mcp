import { timingSafeEqual } from "node:crypto";
import { soChoKho, type KhoLo } from "./kho-san-xuat";
import { conChoVe, soNgay, tinhLo, type LoCat, type MaTran, type PhieuDat, type TienDoLo, type TomTat } from "./san-xuat";
import type { SoSanXuat } from "./san-xuat-data";

/**
 * Trang cho xưởng (/xuong): chủ xưởng và quản lý sản xuất xem các đơn đã nhận, tiến độ trả hàng, còn nợ bao nhiêu,
 * và tự cập nhật ngày hẹn trả, thông tin sản xuất của lô.
 * Hàm thuần (trừ `checkXuongKey` đọc biến môi trường), không gọi database: route `/api/xuong` và test dùng chung.
 * Người ngoài công ty xem trang này nên: KHÔNG có giá, KHÔNG có ghi chú nội bộ, KHÔNG có số phiếu Pancake.
 */

/**
 * Kiểm tra header `x-mk-key` với XUONG_API_KEY. Mã của xưởng phải KHÁC mã của kho (KHO_API_KEY),
 * để người của xưởng không gọi được API kho; đặt trùng thì coi như chưa đặt đúng.
 */
export function checkXuongKey(request: Request): "ok" | "unset" | "trung" | "bad" {
  const secret = process.env.XUONG_API_KEY?.trim();
  if (!secret) return "unset";
  if (secret === process.env.KHO_API_KEY?.trim()) return "trung";
  const a = Buffer.from(request.headers.get("x-mk-key") ?? "");
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b) ? "ok" : "bad";
}

// ---------- Bản đọc cho xưởng ----------

export interface XuongLanVe {
  ngay: string;
  /** Số xưởng giao (dòng nào thiếu số xưởng thì lấy số kho đếm). */
  giao: number;
  khoDem: number;
  /** Xưởng đã giao nhưng kho chưa đếm xong. */
  choDem: boolean;
}

export type XuongLo = Omit<KhoLo, "ghiChu" | "lanVe"> & {
  /** Phiếu đặt mà lô nối tới; null khi lô không nối với phiếu nào. */
  phieuId: number | null;
  daGiao: number;
  lanVe: XuongLanVe[];
};

export type TrangThaiDon = "cho_cat" | "da_cat" | "dang_tra" | "xong";

export interface XuongDon {
  /** id phiếu đặt; null khi là lô cắt không nối với phiếu đặt nào. */
  id: number | null;
  ma: string;
  /** Số phiếu / đợt của phiếu đặt; với lô không có phiếu là tên lô. */
  soPhieu: string;
  ngayDat: string | null;
  duKienCat: string | null;
  /** Tổng số đặt; null khi không có phiếu đặt. */
  tongDat: number | null;
  daCat: number;
  daGiao: number;
  khoDem: number;
  /** Đã đặt nhưng chưa cắt. */
  choCat: number;
  /** Đã cắt nhưng kho chưa đếm được (chỉ tính lô đang về). */
  conNo: number;
  trangThai: TrangThaiDon;
  nhan: string;
  /** Có lô mới có số theo sổ xưởng, kho chưa đếm: số còn nợ chưa chắc. */
  chuaDoiSoat: boolean;
  /** Số ĐẶT màu × size; null khi phiếu chưa chia size. */
  maTran: MaTran | null;
  /** Số đặt theo màu, dùng khi chưa chia size. */
  theoMau: { mau: string; so: number }[];
  /** Tên các lô cắt của phiếu. */
  los: string[];
}

export interface XuongSo {
  at: number;
  homNay: string;
  tomTat: TomTat & { phieuChoCat: number };
  /** false = database chưa có phần ghi thông tin sản xuất (migration 0026). */
  ghiThongTin: boolean;
  don: XuongDon[];
  los: XuongLo[];
}

const soSize = (s: string) => (/^\d+(\.\d+)?$/.test(s) ? Number(s) : Number.POSITIVE_INFINITY);

/** Ma trận số đặt màu × size của một phiếu; null khi có dòng chưa chia size. */
function maTranDat(dong: PhieuDat["dong"]): MaTran | null {
  if (!dong.length || dong.some((d) => d.size.trim() === "")) return null;
  const sizes = [...new Set(dong.map((d) => d.size.trim()))].sort((a, b) => soSize(a) - soSize(b) || a.localeCompare(b, "vi"));
  const mau = [...new Set(dong.map((d) => d.mau.trim()))];
  const hang = mau.map((m) => {
    const o = sizes.map((s) => {
      const ds = dong.filter((d) => d.mau.trim() === m && d.size.trim() === s);
      return ds.length ? ds.reduce((a, d) => a + d.so_luong, 0) : null;
    });
    return { mau: m, o, tong: o.reduce<number>((a, x) => a + (x ?? 0), 0) };
  });
  const tong = sizes.map((_, i) => hang.reduce((a, h) => a + (h.o[i] ?? 0), 0));
  return { sizes, hang, tong, tongCong: tong.reduce((a, b) => a + b, 0) };
}

function datTheoMau(dong: PhieuDat["dong"]): { mau: string; so: number }[] {
  const m = new Map<string, number>();
  for (const d of dong) m.set(d.mau.trim() || "Chưa rõ màu", (m.get(d.mau.trim() || "Chưa rõ màu") ?? 0) + d.so_luong);
  return [...m].map(([mau, so]) => ({ mau, so }));
}

/** Số xưởng giao của một lô: dòng nào không ghi số xưởng thì lấy số kho đếm. */
function daGiaoCua(t: TienDoLo): number {
  return t.lanVe.reduce((a, h) => a + h.dong.reduce((b, d) => b + (d.xuong_giao ?? d.kho_dem ?? 0), 0), 0);
}

const NHAN_DON: Record<TrangThaiDon, string> = { cho_cat: "Chờ cắt", da_cat: "Đã cắt", dang_tra: "Đang trả", xong: "Xong" };
const THU_TU: TrangThaiDon[] = ["dang_tra", "da_cat", "cho_cat", "xong"];

function gomDon(p: PhieuDat | null, lo1: LoCat | null, ts: TienDoLo[]): XuongDon {
  const tongDat = p ? p.dong.reduce((a, d) => a + d.so_luong, 0) : null;
  const daCat = ts.reduce((a, t) => a + t.soCat, 0);
  const daGiao = ts.reduce((a, t) => a + daGiaoCua(t), 0);
  const khoDem = ts.reduce((a, t) => a + t.khoDem, 0);
  const choCat = p && p.trang_thai === "cho_cat" ? Math.max(0, (tongDat ?? 0) - daCat) : 0;
  const conNo = ts.filter(conChoVe).reduce((a, t) => a + t.conNo, 0);
  const chuaDoiSoat = ts.some((t) => t.lo.trang_thai === "chua_doi_soat");
  let trangThai: TrangThaiDon;
  if (!ts.length) trangThai = p?.trang_thai === "cho_cat" ? "cho_cat" : "da_cat";
  else if (choCat === 0 && !chuaDoiSoat && ts.every((t) => t.conNo <= 0 || t.lo.trang_thai === "dong")) trangThai = "xong";
  else trangThai = daGiao > 0 || khoDem > 0 ? "dang_tra" : "da_cat";
  return {
    id: p?.id ?? null,
    ma: p?.ma_hang ?? lo1?.ma_hang ?? "",
    soPhieu: p ? p.dot : (lo1?.lo ?? ""),
    ngayDat: p?.ngay_dat ?? null,
    duKienCat: p?.ngay_du_kien_cat ?? null,
    tongDat,
    daCat,
    daGiao,
    khoDem,
    choCat,
    conNo,
    trangThai,
    nhan: NHAN_DON[trangThai] + (trangThai !== "cho_cat" && trangThai !== "xong" && choCat > 0 ? " · cắt một phần" : ""),
    chuaDoiSoat,
    maTran: p ? maTranDat(p.dong) : null,
    theoMau: p && !maTranDat(p.dong) ? datTheoMau(p.dong) : [],
    los: ts.map((t) => t.lo.lo),
  };
}

/**
 * Sổ hàng xưởng cho trang /xuong. Dựng trên `soChoKho` (đã bỏ giá, ghi chú đã qua `boTien`), rồi bỏ thêm
 * ghi chú nội bộ và số phiếu Pancake, và thêm danh sách đơn đã nhận (mọi phiếu đặt chưa hủy + lô không có phiếu).
 */
export function soChoXuong(so: SoSanXuat, homNay: string, now: number = Date.now()): XuongSo {
  const kho = soChoKho(so, homNay, now);
  const tienDo = new Map(so.los.map((l) => [l.id, tinhLo(l, so.hangVe, homNay)]));
  const phieu = so.phieu.filter((p) => p.trang_thai !== "huy");
  const coPhieu = new Set(phieu.map((p) => p.id));
  const los: XuongLo[] = kho.los.map(({ ghiChu: _ghiChu, lanVe: _lanVe, ...x }) => {
    const t = tienDo.get(x.id)!;
    return {
      ...x,
      phieuId: t.lo.phieu_dat_id != null && coPhieu.has(t.lo.phieu_dat_id) ? t.lo.phieu_dat_id : null,
      daGiao: daGiaoCua(t),
      lanVe: t.lanVe.map((h) => ({
        ngay: h.ngay,
        giao: h.dong.reduce((a, d) => a + (d.xuong_giao ?? d.kho_dem ?? 0), 0),
        khoDem: h.dong.reduce((a, d) => a + (d.kho_dem ?? 0), 0),
        choDem: h.dong.some((d) => d.kho_dem == null),
      })),
    };
  });
  const cuaPhieu = (id: number) => [...tienDo.values()].filter((t) => t.lo.phieu_dat_id === id);
  const don = [
    ...phieu.map((p) => gomDon(p, null, cuaPhieu(p.id))),
    ...[...tienDo.values()]
      .filter((t) => t.lo.phieu_dat_id == null || !coPhieu.has(t.lo.phieu_dat_id))
      .map((t) => gomDon(null, t.lo, [t])),
  ].sort(
    (a, b) =>
      THU_TU.indexOf(a.trangThai) - THU_TU.indexOf(b.trangThai) ||
      (a.ngayDat ?? "9999").localeCompare(b.ngayDat ?? "9999") ||
      a.ma.localeCompare(b.ma) ||
      a.soPhieu.localeCompare(b.soPhieu, "vi")
  );
  return {
    at: kho.at,
    homNay,
    tomTat: { ...kho.tomTat, phieuChoCat: kho.phieu.length },
    // Database đã chạy 0026 thì mỗi lô đọc về có khóa `ngay_chot` (kể cả null); chưa chạy thì không có khóa này.
    ghiThongTin: so.los.length === 0 || so.los.some((l) => l.ngay_chot !== undefined),
    don,
    los,
  };
}

// ---------- Kiểm tra lệnh ghi của xưởng ----------

export const CHUA_BAT_THONG_TIN = "Máy chủ chưa bật phần ghi thông tin sản xuất";

export type LenhGhi =
  | { ok: true; fn: "mk_sx_lot_reschedule" | "mk_sx_lot_info"; args: Record<string, string | null> }
  | { ok: false; error: string };

const sai = (error: string): LenhGhi => ({ ok: false, error });
const KY_TU_LA = /[\u0000-\u001f\u007f]/;

/** Chuỗi một dòng đã cắt khoảng trắng; null nếu không phải chuỗi hoặc có ký tự điều khiển. */
function chu(v: unknown, nhieuDong = false): string | null {
  if (typeof v !== "string") return null;
  const s = nhieuDong ? v.replace(/\r\n?/g, "\n").trim() : v.replace(/\s+/g, " ").trim();
  return KY_TU_LA.test(nhieuDong ? s.replace(/\n/g, " ") : s) ? null : s;
}

/** Ngày YYYY-MM-DD có thật trên lịch. */
export function ngayHopLe(v: unknown): v is string {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const t = Date.parse(`${v}T00:00:00Z`);
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === v;
}

const trong = (v: unknown) => v === undefined || v === null || v === "";

/**
 * Đọc thân POST của /api/xuong thành lời gọi hàm database. Kiểm tra chặt ở đây; database kiểm lại lần nữa.
 *   { action: "hen", ma_hang, lo, ngay_hen, ly_do, nguoi }                                   → mk_sx_lot_reschedule
 *   { action: "thongtin", ma_hang, lo, ngay_chot?, xuong?, ngay_vai_ve?, thong_tin_sx?, nguoi } → mk_sx_lot_info
 * Trường tùy chọn để trống ("" hoặc null) nghĩa là giữ nguyên số cũ.
 */
export function docLenhGhi(body: unknown, homNay: string): LenhGhi {
  if (!body || typeof body !== "object" || Array.isArray(body)) return sai("Thân yêu cầu phải là một đối tượng JSON");
  const b = body as Record<string, unknown>;
  if (b.action !== "hen" && b.action !== "thongtin") return sai('action phải là "hen" hoặc "thongtin"');

  const nguoi = chu(b.nguoi);
  if (nguoi == null || nguoi.length < 2 || nguoi.length > 40) return sai("Cần tên người cập nhật (2 đến 40 ký tự)");
  const ma = chu(b.ma_hang)?.toUpperCase() ?? "";
  if (!/^[A-Z0-9][A-Z0-9._-]{2,29}$/.test(ma)) return sai("Mã hàng không hợp lệ");
  const lo = chu(b.lo);
  if (lo == null || lo.length < 1 || lo.length > 30) return sai("Tên lô không hợp lệ");
  const chung = { p_agent: `Xưởng: ${nguoi}`, p_ma_hang: ma, p_lo: lo, p_nguon: `Trang xưởng (/xuong): ${nguoi}` };

  if (b.action === "hen") {
    if (!ngayHopLe(b.ngay_hen)) return sai("Ngày hẹn trả phải có dạng YYYY-MM-DD");
    if (b.ngay_hen < homNay) return sai("Ngày hẹn trả mới không được ở quá khứ");
    if (soNgay(homNay, b.ngay_hen) > 365) return sai("Ngày hẹn trả mới quá xa (hơn một năm)");
    const lyDo = chu(b.ly_do, true);
    if (lyDo == null || lyDo.length < 3 || lyDo.length > 300) return sai("Cần lý do dời hẹn (3 đến 300 ký tự)");
    return { ok: true, fn: "mk_sx_lot_reschedule", args: { ...chung, p_hen_moi: b.ngay_hen, p_ly_do: lyDo } };
  }

  const ngay = (v: unknown, ten: string): string | null | LenhGhi => {
    if (trong(v)) return null;
    if (!ngayHopLe(v)) return sai(`${ten} phải có dạng YYYY-MM-DD`);
    if (v > homNay) return sai(`${ten} không được ở tương lai`);
    if (v < "2020-01-01") return sai(`${ten} quá xa trong quá khứ`);
    return v;
  };
  const van = (v: unknown, ten: string, max: number, nhieuDong: boolean): string | null | LenhGhi => {
    if (trong(v)) return null;
    const s = chu(v, nhieuDong);
    if (s == null) return sai(`${ten} không hợp lệ`);
    if (s.length > max) return sai(`${ten} dài quá ${max} ký tự`);
    return s || null;
  };
  const ngayChot = ngay(b.ngay_chot, "Ngày chốt");
  if (ngayChot && typeof ngayChot === "object") return ngayChot;
  const vaiVe = ngay(b.ngay_vai_ve, "Ngày vải về");
  if (vaiVe && typeof vaiVe === "object") return vaiVe;
  const xuong = van(b.xuong, "Đơn vị gia công", 100, false);
  if (xuong && typeof xuong === "object") return xuong;
  const thongTin = van(b.thong_tin_sx, "Tiến độ", 500, true);
  if (thongTin && typeof thongTin === "object") return thongTin;
  if (ngayChot == null && vaiVe == null && xuong == null && thongTin == null) return sai("Chưa có thông tin nào để ghi");
  return {
    ok: true,
    fn: "mk_sx_lot_info",
    args: { ...chung, p_ngay_chot: ngayChot, p_xuong: xuong, p_ngay_vai_ve: vaiVe, p_thong_tin_sx: thongTin },
  };
}

/**
 * Đổi lỗi database thành câu trả lời cho xưởng.
 * - Hàm `mk_sx_lot_info` hoặc cột của migration 0026 chưa có → 501, câu rõ ràng thay cho lỗi thô.
 * - Lỗi luật do hàm tự báo (raise exception, mã P0001) đã là tiếng Việt → 400, giữ nguyên câu.
 * - Lỗi khác → 502, không đưa chi tiết kỹ thuật ra ngoài.
 */
export function loiGhi(fn: string, err: { code?: string | null; message?: string | null }): { status: number; error: string; chuaBat?: true } {
  const m = err.message ?? "";
  const thieu =
    err.code !== "P0001" &&
    (err.code === "PGRST202" || err.code === "42883" || err.code === "42703" || /could not find the function|schema cache|does not exist/i.test(m));
  if (fn === "mk_sx_lot_info" && thieu) return { status: 501, error: CHUA_BAT_THONG_TIN, chuaBat: true };
  if (err.code === "P0001" && m) return { status: 400, error: m.replace(/\.?\s*Tạo lô bằng mk_sx_lot_save trước/, "") };
  return { status: 502, error: "Máy chủ chưa ghi được, thử lại sau ít phút" };
}

// ---------- Ảnh đại diện sản phẩm ----------

/** Đọc `?anh=MA1,MA2` thành danh sách mã hàng hợp lệ (tối đa 150 mã); mã lạ bị bỏ. */
export function docMaAnh(v: string | null): string[] {
  const ds = (v ?? "").split(",").map((x) => x.trim().toUpperCase()).filter((x) => /^[A-Z0-9][A-Z0-9._-]{2,29}$/.test(x));
  return [...new Set(ds)].slice(0, 150);
}

/** Chọn ảnh của các mã được hỏi từ danh sách [mã hàng, đường dẫn ảnh]. Chỉ trả đường dẫn https. */
export function locAnh(images: Array<[string, string]>, ma: string[]): Record<string, string> {
  const can = new Set(ma);
  const out: Record<string, string> = {};
  for (const [k, u] of images) {
    const m = String(k).toUpperCase();
    if (can.has(m) && !out[m] && typeof u === "string" && /^https:\/\//.test(u)) out[m] = u;
  }
  return out;
}
