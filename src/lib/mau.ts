import { timingSafeEqual } from "node:crypto";

/**
 * Mẫu và media (trang /mau), đợt 1: chọn mẫu và làm media cơ bản.
 * Hàm thuần (trừ `vaiCuaKhoa` đọc biến môi trường), không gọi database: route `/api/mau` và test dùng chung.
 * Ảnh, video nằm ở kho lưu trữ bên ngoài; hồ sơ chỉ giữ đường dẫn thư mục và một ảnh đại diện nhỏ.
 */

// ---------- Vai và mã truy cập ----------

/** quan_ly: chọn, bỏ, duyệt media, thấy giá nhập. lam: thêm và sửa hồ sơ. xem: chỉ xem mẫu đã có media. */
export type Vai = "quan_ly" | "lam" | "xem";

const KHOA: [string, Vai][] = [
  ["MAU_QUAN_LY_KEY", "quan_ly"],
  ["MAU_LAM_KEY", "lam"],
  ["MAU_XEM_KEY", "xem"],
];

/**
 * Đọc header `x-mk-key` ra vai. Ba mã phải khác nhau và khác mã của kho, của xưởng;
 * mã nào trùng mã khác thì coi như chưa đặt (không ai đoán nhầm vai được).
 */
export function vaiCuaKhoa(request: Request): Vai | "unset" | "bad" {
  const giaTri = (ten: string) => process.env[ten]?.trim() ?? "";
  const khac = [giaTri("KHO_API_KEY"), giaTri("XUONG_API_KEY")].filter(Boolean);
  const dat = KHOA.map(([ten, vai]) => ({ vai, ma: giaTri(ten) })).filter((k) => k.ma);
  const hopLe = dat.filter((k) => !khac.includes(k.ma) && dat.filter((x) => x.ma === k.ma).length === 1);
  if (!hopLe.length) return "unset";
  const a = Buffer.from(request.headers.get("x-mk-key") ?? "");
  for (const k of hopLe) {
    const b = Buffer.from(k.ma);
    if (a.length === b.length && timingSafeEqual(a, b)) return k.vai;
  }
  return "bad";
}

// ---------- Hồ sơ ----------

export const TRANG_THAI = ["dang_xem", "chon_lam", "co_media", "bo"] as const;
export type TrangThai = (typeof TRANG_THAI)[number];
export const NHAN_TRANG_THAI: Record<TrangThai, string> = { dang_xem: "Đang xem", chon_lam: "Chọn làm", co_media: "Đã có media", bo: "Bỏ" };

export const SUA_TT = ["chua_giao", "dang_lam", "cho_duyet", "da_duyet"] as const;
export const NGUON_LOAI = ["taobao", "suu_tam", "xuong", "tu_thiet_ke", "ma_cu"] as const;
export const GIOI = ["", "trai", "gai", "unisex"] as const;
/** Loại sản phẩm của mẫu; rỗng = chưa chọn. */
export const LOAI = ["", "Áo", "Quần", "Bộ", "Váy", "Khác"] as const;

/** Một dòng `mau_ho_so` như database trả về. */
export interface HoSoRow {
  id: number;
  ma: string;
  ma_chinh_thuc: string | null;
  ten: string;
  thuong_hieu: string;
  gioi: string;
  loai: string;
  mua: string;
  nguon_loai: string;
  nguon_link: string;
  nguon_shop: string;
  thong_tin_nguon: string;
  phan_tich: string;
  ly_do: string;
  chat_lieu: string;
  mau_sac: string;
  bang_size: string;
  co_mau_that: boolean;
  ngay_mau_ve: string | null;
  gia_ban: string;
  gia_nhap: string;
  link_goc: string;
  link_anh: string;
  link_video: string;
  link_shopee: string;
  so_anh: number;
  so_video: number;
  sua_tt: string;
  sua_nguoi: string;
  sua_yeu_cau: string;
  sua_xong: string | null;
  mo_ta: string;
  luu_y: string;
  trang_thai: string;
  ly_do_bo: string;
  nguoi_tao: string;
  tao_luc: string;
  cap_nhat_luc: string;
}

/** Hồ sơ gửi ra trang: thêm dấu ảnh đại diện; `gia_nhap` chỉ có với vai quản lý. */
export type HoSoXem = Omit<HoSoRow, "gia_nhap"> & { gia_nhap?: string; anh: string | null };

/** Cột mà vai `xem` (sale lấy tư liệu) được đọc: không có phân tích nội bộ, giá nhập, việc chỉnh ảnh. */
const COT_CHO_XEM = [
  "id", "ma", "ma_chinh_thuc", "ten", "thuong_hieu", "gioi", "loai", "mua", "chat_lieu", "mau_sac", "bang_size",
  "gia_ban", "link_anh", "link_video", "link_shopee", "so_anh", "so_video", "mo_ta", "luu_y", "trang_thai", "cap_nhat_luc",
] as const;

/**
 * Danh sách hồ sơ theo vai. `anh` = thời điểm cập nhật ảnh đại diện theo id hồ sơ (dùng làm dấu phiên bản).
 * - quan_ly: tất cả.
 * - lam: tất cả, trừ giá nhập.
 * - xem: chỉ mẫu đã có media, chỉ các cột tư liệu.
 */
export function hoSoTheoVai(rows: HoSoRow[], anh: Map<number, string>, vai: Vai): HoSoXem[] | Record<string, unknown>[] {
  const dau = (id: number) => anh.get(id) ?? null;
  if (vai === "xem") {
    return rows
      .filter((r) => r.trang_thai === "co_media")
      .map((r) => ({ ...Object.fromEntries(COT_CHO_XEM.map((c) => [c, r[c]])), anh: dau(r.id) }));
  }
  return rows.map((r) => {
    const { gia_nhap, ...con } = r;
    return vai === "quan_ly" ? { ...con, gia_nhap, anh: dau(r.id) } : { ...con, anh: dau(r.id) };
  });
}

// ---------- Kiểm tra lệnh ghi ----------

const KY_TU_LA = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const trong = (v: unknown) => v === undefined || v === null || v === "";

/** Ngày YYYY-MM-DD có thật trên lịch. */
export function ngayHopLe(v: unknown): v is string {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const t = Date.parse(`${v}T00:00:00Z`);
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === v;
}

/** Đường dẫn https, không khoảng trắng, không ký tự mở thẻ. Chặn javascript:, data: và các kiểu khác. */
export function linkHopLe(v: string): boolean {
  if (v.length > 600 || /[\s<>"'`]/.test(v)) return false;
  try {
    const u = new URL(v);
    return u.protocol === "https:" && !!u.hostname && !u.username && !u.password;
  } catch {
    return false;
  }
}

type Kieu = { k: "chu"; max: number; dong?: boolean } | { k: "link" } | { k: "chon"; ds: readonly string[] } | { k: "so" } | { k: "ngay" } | { k: "bool" };

/** Trường của hồ sơ mà trang được gửi lên, kèm tên tiếng Việt để báo lỗi. */
const TRUONG: Record<string, { ten: string; kieu: Kieu; chiQuanLy?: true }> = {
  ten: { ten: "Tên gợi ý", kieu: { k: "chu", max: 150 } },
  thuong_hieu: { ten: "Thương hiệu", kieu: { k: "chu", max: 40 } },
  gioi: { ten: "Bé trai / bé gái", kieu: { k: "chon", ds: GIOI } },
  loai: { ten: "Loại", kieu: { k: "chon", ds: LOAI } },
  mua: { ten: "Mùa", kieu: { k: "chu", max: 60 } },
  nguon_loai: { ten: "Loại nguồn", kieu: { k: "chon", ds: NGUON_LOAI } },
  nguon_link: { ten: "Link nguồn", kieu: { k: "link" } },
  nguon_shop: { ten: "Shop nguồn", kieu: { k: "chu", max: 100 } },
  thong_tin_nguon: { ten: "Thông tin sản phẩm nguồn", kieu: { k: "chu", max: 8000, dong: true } },
  phan_tich: { ten: "Phân tích sản phẩm", kieu: { k: "chu", max: 8000, dong: true } },
  ly_do: { ten: "Lý do chọn", kieu: { k: "chu", max: 500, dong: true } },
  chat_lieu: { ten: "Chất liệu", kieu: { k: "chu", max: 300, dong: true } },
  mau_sac: { ten: "Màu", kieu: { k: "chu", max: 200 } },
  bang_size: { ten: "Bảng size", kieu: { k: "chu", max: 2000, dong: true } },
  co_mau_that: { ten: "Đã có mẫu thật", kieu: { k: "bool" } },
  ngay_mau_ve: { ten: "Ngày mẫu về", kieu: { k: "ngay" } },
  gia_ban: { ten: "Giá bán dự kiến", kieu: { k: "chu", max: 200, dong: true } },
  gia_nhap: { ten: "Giá nhập, giá sản xuất", kieu: { k: "chu", max: 200, dong: true }, chiQuanLy: true },
  link_goc: { ten: "Thư mục ảnh gốc", kieu: { k: "link" } },
  link_anh: { ten: "Thư mục ảnh đã chỉnh", kieu: { k: "link" } },
  link_video: { ten: "Thư mục video", kieu: { k: "link" } },
  link_shopee: { ten: "Thư mục Shopee", kieu: { k: "link" } },
  so_anh: { ten: "Số ảnh đã chỉnh", kieu: { k: "so" } },
  so_video: { ten: "Số video", kieu: { k: "so" } },
  sua_tt: { ten: "Việc chỉnh ảnh", kieu: { k: "chon", ds: SUA_TT } },
  sua_nguoi: { ten: "Người chỉnh", kieu: { k: "chu", max: 40 } },
  sua_yeu_cau: { ten: "Yêu cầu chỉnh", kieu: { k: "chu", max: 1000, dong: true } },
  sua_xong: { ten: "Ngày chỉnh xong", kieu: { k: "ngay" } },
  mo_ta: { ten: "Mô tả cơ bản", kieu: { k: "chu", max: 4000, dong: true } },
  luu_y: { ten: "Lưu ý", kieu: { k: "chu", max: 1000, dong: true } },
};

function chu(v: unknown, dong: boolean): string | null {
  if (typeof v !== "string") return null;
  const s = dong ? v.replace(/\r\n?/g, "\n").trim() : v.replace(/\s+/g, " ").trim();
  return KY_TU_LA.test(dong ? s.replace(/\n/g, " ") : s) ? null : s;
}

function docTruong(ten: string, kieu: Kieu, v: unknown): { ok: true; v: string | number | boolean | null } | { ok: false; error: string } {
  const loi = (e: string) => ({ ok: false as const, error: `${ten}: ${e}` });
  switch (kieu.k) {
    case "bool":
      return typeof v === "boolean" ? { ok: true, v } : loi("phải là có hoặc không");
    case "so": {
      if (trong(v)) return { ok: true, v: 0 };
      const n = typeof v === "number" ? v : typeof v === "string" && /^\d{1,5}$/.test(v.trim()) ? Number(v.trim()) : NaN;
      return Number.isInteger(n) && n >= 0 && n <= 99999 ? { ok: true, v: n } : loi("phải là số nguyên từ 0 đến 99999");
    }
    case "ngay":
      if (trong(v)) return { ok: true, v: null };
      return ngayHopLe(v) && v >= "2020-01-01" && v <= "2099-12-31" ? { ok: true, v } : loi("phải có dạng YYYY-MM-DD");
    case "chon":
      return typeof v === "string" && kieu.ds.includes(v) ? { ok: true, v } : loi("giá trị không hợp lệ");
    case "link": {
      if (trong(v)) return { ok: true, v: "" };
      const s = typeof v === "string" ? v.trim() : "";
      return s && linkHopLe(s) ? { ok: true, v: s } : loi("phải là đường dẫn https, không quá 600 ký tự");
    }
    case "chu": {
      if (trong(v)) return { ok: true, v: "" };
      const s = chu(v, !!kieu.dong);
      if (s == null) return loi("không hợp lệ");
      return s.length <= kieu.max ? { ok: true, v: s } : loi(`dài quá ${kieu.max} ký tự`);
    }
  }
}

const MA_MAU = /^[A-Z0-9][A-Z0-9._-]{2,29}$/;
const sai = (error: string) => ({ ok: false as const, error });

function docNguoi(v: unknown): string | null {
  const s = chu(v, false);
  return s != null && s.length >= 2 && s.length <= 40 ? s : null;
}

function docId(v: unknown): number | null {
  return typeof v === "number" && Number.isSafeInteger(v) && v > 0 ? v : null;
}

export type LenhMau =
  | { ok: true; viec: "tao"; nguoi: string; ma: string; cot: Record<string, string | number | boolean | null> }
  | { ok: true; viec: "sua"; nguoi: string; id: number; cot: Record<string, string | number | boolean | null> }
  | { ok: true; viec: "trang_thai"; nguoi: string; id: number; den: TrangThai; ghiChu: string }
  | { ok: true; viec: "anh"; nguoi: string; id: number; kieu: string; duLieu: string }
  | { ok: false; error: string; status?: number };

/** Ảnh đại diện đã thu nhỏ ở trình duyệt: tối đa 300.000 ký tự base64 (khoảng 220 KB). */
export const ANH_TOI_DA = 300_000;

/**
 * Đọc thân POST của /api/mau. Kiểm tra chặt ở đây theo vai; route chỉ việc ghi.
 *   { action: "tao", ma, nguoi, ...trường }            → thêm hồ sơ (quan_ly, lam)
 *   { action: "sua", id, nguoi, ...trường cần đổi }    → sửa hồ sơ (quan_ly, lam)
 *   { action: "trang_thai", id, den, ghi_chu, nguoi }  → đổi trạng thái (chỉ quan_ly)
 *   { action: "anh", id, du_lieu: "data:image/…;base64,…", nguoi } → ảnh đại diện (quan_ly, lam)
 */
export function docLenhMau(body: unknown, vai: Vai): LenhMau {
  if (vai === "xem") return { ...sai("Mã truy cập này chỉ được xem"), status: 403 };
  if (!body || typeof body !== "object" || Array.isArray(body)) return sai("Thân yêu cầu phải là một đối tượng JSON");
  const b = body as Record<string, unknown>;
  const nguoi = docNguoi(b.nguoi);
  if (nguoi == null) return sai("Cần tên người ghi (2 đến 40 ký tự)");

  if (b.action === "tao" || b.action === "sua") {
    const cot: Record<string, string | number | boolean | null> = {};
    for (const [khoa, t] of Object.entries(TRUONG)) {
      if (!(khoa in b)) continue;
      if (t.chiQuanLy && vai !== "quan_ly") return { ...sai(`${t.ten}: chỉ quản lý được ghi`), status: 403 };
      const r = docTruong(t.ten, t.kieu, b[khoa]);
      if (!r.ok) return sai(r.error);
      cot[khoa] = r.v;
    }
    if (cot.sua_tt === "da_duyet" && vai !== "quan_ly") return { ...sai("Chỉ quản lý được đánh dấu ảnh đã duyệt"), status: 403 };
    if (b.action === "tao") {
      const ma = chu(b.ma, false)?.toUpperCase() ?? "";
      if (!MA_MAU.test(ma)) return sai("Mã mẫu gồm 3 đến 30 chữ in hoa, số, dấu chấm hoặc gạch (ví dụ SP27005)");
      if ((cot.nguon_loai ?? "taobao") === "taobao" && !cot.nguon_link) return sai("Mẫu lấy từ Taobao cần có link nguồn");
      return { ok: true, viec: "tao", nguoi, ma, cot };
    }
    const id = docId(b.id);
    if (id == null) return sai("Thiếu id hồ sơ");
    if (!Object.keys(cot).length) return sai("Chưa có thông tin nào để ghi");
    return { ok: true, viec: "sua", nguoi, id, cot };
  }

  if (b.action === "trang_thai") {
    if (vai !== "quan_ly") return { ...sai("Chỉ quản lý được chọn, bỏ hoặc duyệt mẫu"), status: 403 };
    const id = docId(b.id);
    if (id == null) return sai("Thiếu id hồ sơ");
    if (typeof b.den !== "string" || !(TRANG_THAI as readonly string[]).includes(b.den)) return sai("Trạng thái mới không hợp lệ");
    const ghiChu = trong(b.ghi_chu) ? "" : chu(b.ghi_chu, true);
    if (ghiChu == null || ghiChu.length > 500) return sai("Ghi chú không hợp lệ hoặc dài quá 500 ký tự");
    return { ok: true, viec: "trang_thai", nguoi, id, den: b.den as TrangThai, ghiChu };
  }

  if (b.action === "anh") {
    const id = docId(b.id);
    if (id == null) return sai("Thiếu id hồ sơ");
    const m = typeof b.du_lieu === "string" ? /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(b.du_lieu) : null;
    if (!m) return sai("Ảnh đại diện phải là JPG, PNG hoặc WEBP");
    if (m[2].length > ANH_TOI_DA) return sai("Ảnh đại diện quá nặng, chọn ảnh nhỏ hơn");
    if (!dungLoaiAnh(m[1], Buffer.from(m[2].slice(0, 24), "base64"))) return sai("Tệp không phải ảnh JPG, PNG hoặc WEBP");
    return { ok: true, viec: "anh", nguoi, id, kieu: m[1], duLieu: m[2] };
  }
  return sai('action phải là "tao", "sua", "trang_thai" hoặc "anh"');
}

/** So mấy byte đầu của tệp với kiểu ảnh khai báo, để không lưu nhầm thứ khác dưới tên ảnh. */
export function dungLoaiAnh(kieu: string, dau: Buffer): boolean {
  if (kieu === "image/jpeg") return dau.length >= 3 && dau[0] === 0xff && dau[1] === 0xd8 && dau[2] === 0xff;
  if (kieu === "image/png") return dau.length >= 8 && dau.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (kieu === "image/webp") return dau.length >= 12 && dau.subarray(0, 4).toString("latin1") === "RIFF" && dau.subarray(8, 12).toString("latin1") === "WEBP";
  return false;
}

// ---------- Luật chuyển trạng thái ----------

/** Các bước đi được ở đợt 1. Bước nào cũng do quản lý bấm. */
const DUOC_CHUYEN: Record<TrangThai, TrangThai[]> = {
  dang_xem: ["chon_lam", "bo"],
  chon_lam: ["co_media", "dang_xem", "bo"],
  co_media: ["chon_lam", "bo"],
  bo: ["dang_xem"],
};

/** Những thứ còn thiếu để một mẫu được coi là "Đã có media"; rỗng là đủ. */
export function thieuDeCoMedia(r: Pick<HoSoRow, "link_goc" | "link_anh" | "link_video" | "link_shopee" | "mo_ta">, coAnh: boolean): string[] {
  const thieu: string[] = [];
  if (!r.link_anh && !r.link_goc && !r.link_video && !r.link_shopee) thieu.push("link thư mục ảnh hoặc video");
  if (!coAnh) thieu.push("ảnh đại diện");
  if (!r.mo_ta.trim()) thieu.push("mô tả cơ bản");
  return thieu;
}

/** Kiểm tra một lần đổi trạng thái. Trả câu lỗi tiếng Việt, hoặc null nếu được. */
export function loiChuyen(r: HoSoRow, den: TrangThai, ghiChu: string, coAnh: boolean): string | null {
  const tu = r.trang_thai as TrangThai;
  if (!(TRANG_THAI as readonly string[]).includes(tu)) return "Mẫu đang ở trạng thái của đợt sau, trang này chưa đổi được";
  if (tu === den) return `Mẫu đang ở trạng thái "${NHAN_TRANG_THAI[den]}" rồi`;
  if (!DUOC_CHUYEN[tu].includes(den)) return `Không chuyển thẳng từ "${NHAN_TRANG_THAI[tu]}" sang "${NHAN_TRANG_THAI[den]}" được`;
  if (den === "bo" && ghiChu.length < 3) return "Bỏ mẫu cần ghi lý do (ít nhất 3 ký tự)";
  if (tu === "bo" && ghiChu.length < 3) return "Mở lại mẫu đã bỏ cần ghi lý do (ít nhất 3 ký tự)";
  if (den === "co_media") {
    const thieu = thieuDeCoMedia(r, coAnh);
    if (thieu.length) return `Chưa đủ để coi là đã có media, còn thiếu: ${thieu.join(", ")}`;
  }
  return null;
}

/** Tóm tắt một lần sửa cho nhật ký: tên các trường đã đổi, không chép nội dung (có thể dài hoặc là giá). */
export function tomTatSua(cu: HoSoRow, cot: Record<string, unknown>): string {
  const doi = Object.keys(cot).filter((k) => (cu as unknown as Record<string, unknown>)[k] !== cot[k] && !(cot[k] === "" && (cu as unknown as Record<string, unknown>)[k] == null));
  return doi.map((k) => TRUONG[k]?.ten ?? k).join(", ");
}
