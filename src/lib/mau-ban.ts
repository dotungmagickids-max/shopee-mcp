import type { Vai } from "./mau";

/**
 * Màn "Mã đang bán" của trang /mau: các mã đã bán, xếp theo số bán trong năm, để tham khảo khi chọn mẫu mới.
 * Chỉ đọc. Hàm thuần, không gọi database: route `/api/mau?ban=<năm>` và test dùng chung.
 * Trai/gái, loại, mùa lấy theo danh mục sản phẩm trên Pancake POS (đã đồng bộ về bảng pancake_variations).
 * Ảnh: cột image_url được điền MỘT lần từ Pancake rồi thôi (đồng bộ đêm không ghi cột này); ảnh về sau do người dùng tự đăng lên từng mã.
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
  doanh_so: number | null;
  lai_truoc_qc: number | null;
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
  /** Dấu phiên bản của ảnh tự đăng cho mã này (ưu tiên hơn `anh`); lấy ảnh qua `/api/mau?anhma=<mã>`. */
  anhRieng?: string;
  /** Số cái bán được trong năm đang xem (đã trừ hủy, hoàn). */
  slBan: number;
  /** Mã đang bị ẩn khỏi tab (ví dụ hàng xả) và lý do; chỉ vai quản lý nhận được các mã này. */
  an?: true;
  lyDoAn?: string;
  /** Chỉ vai quản lý có hai số dưới. */
  doanhSo?: number | null;
  lai?: number | null;
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
 * Bỏ mã không đúng dạng mã hàng, và mã vừa hết tồn vừa không bán được cái nào trong năm.
 */
export function gomMaBan(rows: BienTheRow[], lai: LaiRow[], vai: Vai): MaBan[] {
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
    if (ton === 0 && slBan === 0) continue;
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
    if (vai === "quan_ly") {
      m.doanhSo = l?.doanh_so == null ? null : Math.round(Number(l.doanh_so));
      m.lai = l?.lai_truoc_qc == null ? null : Math.round(Number(l.lai_truoc_qc));
    }
    out.push(m);
  }
  return out.sort((a, b) => b.slBan - a.slBan || b.banNgay - a.banNgay || a.ma.localeCompare(b.ma));
}

/**
 * Bỏ các mã đã ẩn (hàng xả…) khỏi danh sách. Vai quản lý vẫn nhận các mã đó, có đánh dấu `an`, để hiện lại được.
 */
export function apMaAn(ds: MaBan[], an: Map<string, string>, vai: Vai): MaBan[] {
  if (!an.size) return ds;
  if (vai !== "quan_ly") return ds.filter((m) => !an.has(m.ma));
  return ds.map((m) => (an.has(m.ma) ? { ...m, an: true as const, lyDoAn: an.get(m.ma) ?? "" } : m));
}

/** Gắn dấu ảnh tự đăng vào từng mã. */
export function apAnhRieng(ds: MaBan[], anh: Map<string, string>): MaBan[] {
  return anh.size ? ds.map((m) => (anh.has(m.ma) ? { ...m, anhRieng: anh.get(m.ma)! } : m)) : ds;
}

/** Năm xem số bán: từ 2023 tới năm hiện tại (giờ Việt Nam); sai thì lấy năm hiện tại. */
export function namXem(v: string | null, homNay: string): number {
  const nay = Number(homNay.slice(0, 4));
  const n = v && /^\d{4}$/.test(v) ? Number(v) : nay;
  return n >= 2023 && n <= nay ? n : nay;
}
