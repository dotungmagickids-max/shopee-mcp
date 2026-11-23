import type { Vai } from "./mau";

/**
 * Tab "Mã bán tốt" của trang /mau: danh sách mã tham khảo để làm content, do người dùng tự quản (bảng mau_ma_ban).
 * KHÔNG đồng bộ tự động. Số liệu chỉ được chụp từ dữ liệu bán hàng khi người dùng thêm một mã, nạp lần đầu,
 * hoặc quản lý bấm cập nhật số bán. Phân tích kinh doanh (tồn, lãi, tốc độ bán) không thuộc tab này.
 * Hàm thuần, không gọi database: route `/api/mau` và test dùng chung.
 */

export interface BienTheRow {
  product_code: string | null;
  product_name: string | null;
  categories: string[] | null;
  stock: number | null;
  selling_avg: number | null;
  retail_price: number | null;
  image_url?: string | null;
  updated_at?: string | null;
}

/** Một dòng của hàm database mk_product_profit (số bán và lãi trước quảng cáo theo mã). */
export interface LaiRow {
  ma: string;
  sl_ban: number | null;
}

export interface MaBan {
  ma: string;
  ten: string;
  gioi: "" | "trai" | "gai" | "unisex";
  loai: "Áo" | "Quần" | "Bộ" | "Váy" | "Khác";
  mua: "" | "Xuân hè" | "Thu đông";
  /** Năm ra mã, đọc từ hai số đầu của mã (QD26001 → 2026). */
  nam: number | null;
  ton: number;
  banNgay: number;
  /** Tồn đủ bán mấy ngày theo tốc độ hiện tại; null khi đang không bán. */
  duBan: number | null;
  giaBan: number | null;
  anh: string | null;
  /** Số cái bán được trong năm đang xem (đã trừ hủy, hoàn). */
  slBan: number;
}

const MA_HANG = /^([A-Z]{1,4})(\d{2})\d{3}$/;
const thuong = (dm: string[]) => dm.map((c) => c.toLowerCase().trim());

export function gioiTuDanhMuc(dm: string[]): MaBan["gioi"] {
  const d = thuong(dm);
  const trai = d.some((c) => c.includes("bé trai"));
  const gai = d.some((c) => c.includes("bé gái")) || d.some((c) => /(^|\s)(chân )?váy/.test(c));
  return trai && gai ? "unisex" : trai ? "trai" : gai ? "gai" : "";
}

const LOAI_THEO_DAU: Record<string, MaBan["loai"]> = { BD: "Bộ", QD: "Quần", QN: "Quần", AO: "Áo", ADT: "Áo", AD: "Áo", AK: "Áo", VA: "Váy" };

/** Loại theo danh mục; danh mục không nói rõ thì đoán theo chữ đầu của mã. */
export function loaiTuDanhMuc(dm: string[], ma: string): MaBan["loai"] {
  const d = thuong(dm);
  const co = (re: RegExp) => d.some((c) => re.test(c));
  if (co(/(^|\s)bộ(\s|$)/)) return "Bộ";
  if (co(/váy|đầm/)) return "Váy";
  if (co(/(^|\s)quần(\s|$)/)) return "Quần";
  if (co(/(^|\s)áo(\s|$)/)) return "Áo";
  return LOAI_THEO_DAU[MA_HANG.exec(ma)?.[1] ?? ""] ?? "Khác";
}

export function muaTuDanhMuc(dm: string[]): MaBan["mua"] {
  const d = thuong(dm);
  if (d.some((c) => c.includes("thu đông"))) return "Thu đông";
  if (d.some((c) => c.includes("xuân hè"))) return "Xuân hè";
  return "";
}

const laAnh = (u: unknown): u is string => typeof u === "string" && /^https:\/\/[^\s<>"'`]{4,500}$/.test(u);

/**
 * Gom biến thể thành từng mã, ghép số bán trong năm, xếp theo số bán giảm dần.
 * Bỏ mã không đúng dạng mã hàng, và (trừ khi `giuHet`) mã vừa hết tồn vừa không bán được cái nào trong năm.
 */
export function gomMaBan(rows: BienTheRow[], lai: LaiRow[], giuHet = false): MaBan[] {
  const theoMa = new Map<string, BienTheRow[]>();
  for (const r of rows) {
    const ma = (r.product_code ?? "").trim().toUpperCase();
    if (!MA_HANG.test(ma)) continue;
    const ds = theoMa.get(ma);
    if (ds) ds.push(r);
    else theoMa.set(ma, [r]);
  }
  const ban = new Map(lai.filter((l) => l && typeof l.ma === "string").map((l) => [l.ma.trim().toUpperCase(), l]));
  const out: MaBan[] = [];
  for (const [ma, ds] of theoMa) {
    const dm = [...new Set(ds.flatMap((r) => r.categories ?? []))];
    const ton = ds.reduce((a, r) => a + Math.max(0, Number(r.stock) || 0), 0);
    const banNgay = Math.round(ds.reduce((a, r) => a + Math.max(0, Number(r.selling_avg) || 0), 0) * 10) / 10;
    const l = ban.get(ma);
    const slBan = Math.max(0, Math.round(Number(l?.sl_ban) || 0));
    if (!giuHet && ton === 0 && slBan === 0) continue;
    const ten = ds.map((r) => (r.product_name ?? "").replace(/\s+/g, " ").trim()).filter((t) => t && t.toUpperCase() !== ma).sort((a, b) => b.length - a.length)[0] ?? "";
    const gia = ds.map((r) => Number(r.retail_price) || 0).filter((g) => g > 0).sort((a, b) => a - b);
    const m: MaBan = {
      ma,
      ten: ten.slice(0, 150),
      gioi: gioiTuDanhMuc(dm),
      loai: loaiTuDanhMuc(dm, ma),
      mua: muaTuDanhMuc(dm),
      nam: 2000 + Number(MA_HANG.exec(ma)![2]),
      ton,
      banNgay,
      duBan: banNgay > 0 ? Math.round(ton / banNgay) : null,
      giaBan: gia.length ? gia[Math.floor(gia.length / 2)] : null,
      anh: ds.map((r) => r.image_url).find(laAnh) ?? null,
      slBan,
    };
    out.push(m);
  }
  return out.sort((a, b) => b.slBan - a.slBan || b.banNgay - a.banNgay || a.ma.localeCompare(b.ma));
}

/** Một dòng bảng mau_ma_ban. */
export interface MaBanRow {
  ma: string;
  ten: string;
  gioi: string;
  loai: string;
  mua: string;
  nam: number | null;
  anh_url: string | null;
  sl_ban: number;
  nam_ban: number | null;
  so_ban_luc: string | null;
  nguon: string;
  an: boolean;
  ly_do_an: string;
  /** hot | deu (bán đều) | '' ; thiếu khi database chưa có cột (migration 0034). */
  nhom?: string | null;
}

/** Mã gửi ra trang. `an`, `lyDoAn` chỉ có ở mã đang ẩn, và chỉ vai quản lý nhận được mã đang ẩn. */
export interface MaBanXem {
  ma: string;
  ten: string;
  gioi: string;
  loai: string;
  mua: string;
  nam: number | null;
  anh: string | null;
  /** Dấu phiên bản của ảnh tự đăng (ưu tiên hơn `anh`); lấy ảnh qua `/api/mau?anhma=<mã>`. */
  anhRieng?: string;
  slBan: number;
  namBan: number | null;
  soBanLuc: string | null;
  nguon: string;
  /** hot | deu | '' */
  nhom: string;
  an?: true;
  lyDoAn?: string;
}

/** Danh sách theo vai, xếp theo số bán giảm dần. Mã đang ẩn (hàng xả…) chỉ vai quản lý thấy. */
export function maBanTheoVai(rows: MaBanRow[], anhRieng: Map<string, string>, vai: Vai): MaBanXem[] {
  return rows
    .filter((r) => !r.an || vai === "quan_ly")
    .map((r) => {
      const x: MaBanXem = { ma: r.ma, ten: r.ten, gioi: r.gioi, loai: r.loai, mua: r.mua, nam: r.nam, anh: laAnh(r.anh_url) ? r.anh_url : null, slBan: r.sl_ban, namBan: r.nam_ban, soBanLuc: r.so_ban_luc, nguon: r.nguon, nhom: r.nhom === "hot" || r.nhom === "deu" ? r.nhom : "" };
      const rieng = anhRieng.get(r.ma);
      if (rieng) x.anhRieng = rieng;
      if (r.an) {
        x.an = true;
        x.lyDoAn = r.ly_do_an;
      }
      return x;
    })
    .sort((a, b) => b.slBan - a.slBan || a.ma.localeCompare(b.ma));
}

/** Dòng để ghi vào mau_ma_ban từ số đã gom (thêm một mã, hoặc nạp lần đầu). */
export function dongTuSo(m: MaBan, namBan: number, nguoi: string, luc: string) {
  return { ma: m.ma, ten: m.ten, gioi: m.gioi, loai: m.loai, mua: m.mua, nam: m.nam, anh_url: m.anh, sl_ban: m.slBan, nam_ban: namBan, so_ban_luc: luc, nguon: "pancake", nguoi, cap_nhat_luc: luc };
}

/** Năm ra mã đọc từ mã hàng (QD26001 → 2026); null nếu mã không đúng dạng. */
export function namTuMa(ma: string): number | null {
  const m = MA_HANG.exec(ma);
  return m ? 2000 + Number(m[2]) : null;
}
