/**
 * Web quản trị, trang "Hôm nay": phần tính toán thuần (không đọc database), để test được.
 * Nguyên tắc: thiếu dữ liệu thì trả null kèm lý do, không trả 0. Số 0 chỉ dùng khi nguồn có thật và bằng 0.
 */

/** Chi quảng cáo thật = số nền tảng báo × hệ số (phí, thuế). Khớp core.rules ads_fee.*. */
export const HE_SO_QC = { shopee: 1.08, facebook: 1.111, tiktok: 1.1 } as const;
export type NenTang = keyof typeof HE_SO_QC;

/** Trần chi quảng cáo thật mỗi tháng, mọi kênh. */
export const TRAN_QC_THANG = 200_000_000;

export function chiThat(chiNenTang: number | null | undefined, nenTang: NenTang): number | null {
  if (chiNenTang == null || !Number.isFinite(Number(chiNenTang))) return null;
  return Math.round(Number(chiNenTang) * HE_SO_QC[nenTang]);
}

/** a / b; thiếu một vế hoặc mẫu số không dương thì null. */
export function tyLe(a: number | null | undefined, b: number | null | undefined): number | null {
  if (a == null || b == null || !(b > 0)) return null;
  return a / b;
}

/** Thay đổi so với kỳ trước, vd 0.12 = tăng 12%. */
export function thayDoi(nay: number | null | undefined, truoc: number | null | undefined): number | null {
  const r = tyLe(nay, truoc);
  return r == null ? null : r - 1;
}

export interface PhanChi {
  nenTang: NenTang;
  /** Chi thật đã nhân hệ số; null = chưa có nguồn. */
  chi: number | null;
  /** Vì sao thiếu hoặc chưa đủ (vd "chỉ có số từ 12/11"). */
  thieu?: string | null;
}

export interface SoTran {
  /** Tổng các phần có số; null khi không phần nào có số. */
  tong: number | null;
  tran: number;
  pct: number | null;
  conLai: number | null;
  /** Các phần thiếu hoặc chưa đủ: tổng thật có thể cao hơn. */
  thieu: string[];
  vuot: boolean;
}

export const TEN_NEN_TANG: Record<NenTang, string> = { shopee: "Shopee", facebook: "Facebook", tiktok: "TikTok" };

/** Chi quảng cáo thật trong tháng so với trần. Phần thiếu không tính là 0 mà được nêu tên. */
export function soTran(phan: PhanChi[], tran = TRAN_QC_THANG): SoTran {
  const co = phan.filter((p) => p.chi != null);
  const thieu = phan
    .filter((p) => p.chi == null || p.thieu)
    .map((p) => `${TEN_NEN_TANG[p.nenTang]}: ${p.thieu || "chưa có nguồn"}`);
  if (!co.length) return { tong: null, tran, pct: null, conLai: null, thieu, vuot: false };
  const tong = co.reduce((s, p) => s + (p.chi as number), 0);
  return { tong, tran, pct: tong / tran, conLai: tran - tong, thieu, vuot: tong > tran };
}

// ---------------------------------------------------------------------------
// Doanh số, lãi theo kênh
// ---------------------------------------------------------------------------

export interface Kenh {
  code: string;
  ten: string;
  nenTang: NenTang | null;
  /** shopee = đơn lấy từ Shopee API (15 phút một lần); pancake = đơn Pancake đẩy lên mỗi sáng. */
  nguon: "shopee" | "pancake";
}

export const KENH: Kenh[] = [
  { code: "shopee_magickids", ten: "Shopee Magickids", nenTang: "shopee", nguon: "shopee" },
  { code: "shopee_annie", ten: "Shopee Annie Baby", nenTang: "shopee", nguon: "shopee" },
  { code: "facebook", ten: "Facebook", nenTang: "facebook", nguon: "pancake" },
  { code: "tiktok", ten: "TikTok", nenTang: "tiktok", nguon: "pancake" },
];

/** Một dòng của mk_sales(nhóm day_channel). */
export interface DongBan {
  ky: string;
  kenh: string;
  don_chot: number | null;
  doanh_so_giu: number | null;
  don_tien_ve_uoc_tinh?: number | null;
  lai_truoc_qc: number | null;
  lai_sau_qc: number | null;
}

export interface NguCanhBan {
  /** Ngày (giờ VN) của đơn Pancake mới nhất đã lên Supabase; null = không biết. */
  pancakeDen: string | null;
  /** Ngày mới nhất mà job thu đơn Shopee chạy tốt; null = không biết. */
  shopeeDen: string | null;
  /** Chi Facebook (số Meta, chưa nhân hệ số) theo ngày; ngày không có trong map = chưa có số. */
  fbChi: Map<string, number>;
}

export interface OBan {
  don: number | null;
  doanhSo: number | null;
  lai: number | null;
  /** Vì sao không có đơn / doanh số. */
  thieu: string | null;
  /** Vì sao không có lãi, hoặc lưu ý về số lãi. */
  laiGhiChu: string | null;
  donUocTinh: number;
}

const num = (v: unknown): number | null => (v == null || !Number.isFinite(Number(v)) ? null : Number(v));

/** Số của một kênh trong một ngày. Không có dòng nào: chỉ coi là 0 khi nguồn đã đồng bộ tới ngày đó. */
export function oBan(rows: DongBan[], kenh: Kenh, ngay: string, ctx: NguCanhBan): OBan {
  const r = rows.find((x) => x.ky === ngay && x.kenh === kenh.code);
  if (!r) {
    const den = kenh.nguon === "shopee" ? ctx.shopeeDen : ctx.pancakeDen;
    if (den != null && den >= ngay) return { don: 0, doanhSo: 0, lai: 0, thieu: null, laiGhiChu: null, donUocTinh: 0 };
    const thieu =
      kenh.nguon === "shopee"
        ? "chưa thu được đơn Shopee ngày này"
        : den
          ? `đơn Pancake mới đồng bộ đến ${ngayNgan(den)}`
          : "chưa có đơn Pancake ngày này (đồng bộ mỗi sáng)";
    return { don: null, doanhSo: null, lai: null, thieu, laiGhiChu: thieu, donUocTinh: 0 };
  }
  const o: OBan = { don: num(r.don_chot), doanhSo: num(r.doanh_so_giu), lai: null, thieu: null, laiGhiChu: null, donUocTinh: num(r.don_tien_ve_uoc_tinh) ?? 0 };
  if (kenh.nenTang === "shopee") {
    o.lai = num(r.lai_sau_qc);
    if (o.lai == null) o.laiGhiChu = "chưa đủ phí hoặc chi quảng cáo";
    else if (o.donUocTinh > 0) o.laiGhiChu = `${o.donUocTinh} đơn chưa quyết toán, tiền về ước tính`;
  } else if (kenh.nenTang === "facebook") {
    const truoc = num(r.lai_truoc_qc);
    const chi = chiThat(ctx.fbChi.get(ngay), "facebook");
    if (truoc == null) o.laiGhiChu = "chưa đủ phí";
    else if (chi == null) o.laiGhiChu = "chưa có chi quảng cáo Facebook ngày này";
    else {
      o.lai = truoc - chi;
      o.laiGhiChu = "chưa trừ phí ship";
    }
  } else {
    o.laiGhiChu = "chưa có phí sàn TikTok";
  }
  return o;
}

export interface TongBan {
  don: number | null;
  doanhSo: number | null;
  lai: number | null;
  /** Kênh chưa có đơn/doanh số nên chưa cộng. */
  thieuKenh: string[];
  /** Kênh chưa có lãi nên chưa cộng. */
  thieuLai: string[];
}

export function tongBan(o: { kenh: Kenh; o: OBan }[]): TongBan {
  const coSo = o.filter((x) => x.o.doanhSo != null);
  const coLai = o.filter((x) => x.o.lai != null);
  return {
    don: coSo.length ? coSo.reduce((s, x) => s + (x.o.don ?? 0), 0) : null,
    doanhSo: coSo.length ? coSo.reduce((s, x) => s + (x.o.doanhSo as number), 0) : null,
    lai: coLai.length ? coLai.reduce((s, x) => s + (x.o.lai as number), 0) : null,
    thieuKenh: o.filter((x) => x.o.doanhSo == null).map((x) => x.kenh.ten),
    // Kênh có doanh số 0 và lãi 0 không tính là thiếu; kênh có doanh số mà không có lãi thì nêu tên.
    thieuLai: o.filter((x) => x.o.lai == null).map((x) => x.kenh.ten),
  };
}

// ---------------------------------------------------------------------------
// Tồn kho
// ---------------------------------------------------------------------------

export interface MaTon {
  code: string;
  name?: string | null;
  ton: number;
  banNgay: number;
  conNgay: number;
}

/** Mã còn hàng, đang bán, và còn dưới `nguong` ngày bán (tồn / bán mỗi ngày). */
export function tonSapHet(rows: { code: string; name?: string | null; ton: unknown; ban_moi_ngay: unknown }[], nguong = 7): MaTon[] {
  const out: MaTon[] = [];
  for (const r of rows) {
    const ton = num(r.ton);
    const ban = num(r.ban_moi_ngay);
    if (ton == null || ban == null || ton <= 0 || ban <= 0) continue;
    const conNgay = ton / ban;
    if (conNgay < nguong) out.push({ code: r.code, name: r.name, ton, banNgay: ban, conNgay });
  }
  return out.sort((a, b) => a.conNgay - b.conNgay || b.banNgay - a.banNgay);
}

export interface MaAm {
  code: string;
  bienThe: number;
  tongAm: number;
}

/** Gom biến thể đang âm tồn (bán vượt số có trong kho) theo mã sản phẩm. */
export function amTon(rows: { sku: string | null; product_code?: string | null; stock: unknown }[]): MaAm[] {
  const m = new Map<string, MaAm>();
  for (const r of rows) {
    const stock = num(r.stock);
    if (stock == null || stock >= 0) continue;
    const code = r.product_code || /^[A-Z]+[0-9]{5}/.exec(String(r.sku ?? "").toUpperCase())?.[0] || String(r.sku ?? "?");
    const a = m.get(code) ?? { code, bienThe: 0, tongAm: 0 };
    a.bienThe++;
    a.tongAm += stock;
    m.set(code, a);
  }
  return [...m.values()].sort((a, b) => a.tongAm - b.tongAm);
}

// ---------------------------------------------------------------------------
// Việc
// ---------------------------------------------------------------------------

export interface ViecNguoi {
  nguoi: string;
  mo: number;
  tre: number;
  gap: number;
}

/** Việc còn mở theo người làm. Trễ = có hạn và hạn trước hôm nay (giờ VN). */
export function gomViec(tasks: { assignee: string; due?: string | null; priority?: number | null }[], homNay: string): ViecNguoi[] {
  const m = new Map<string, ViecNguoi>();
  for (const t of tasks) {
    const nguoi = (t.assignee || "?").trim();
    const a = m.get(nguoi) ?? { nguoi, mo: 0, tre: 0, gap: 0 };
    a.mo++;
    if (t.due && String(t.due).slice(0, 10) < homNay) a.tre++;
    if (Number(t.priority) === 1) a.gap++;
    m.set(nguoi, a);
  }
  return xepViec([...m.values()]);
}

export const xepViec = (v: ViecNguoi[]): ViecNguoi[] => [...v].sort((a, b) => b.tre - a.tre || b.mo - a.mo || a.nguoi.localeCompare(b.nguoi, "vi"));

// ---------------------------------------------------------------------------
// Đóng hàng
// ---------------------------------------------------------------------------

/** Đơn trong danh sách cần đóng đã có video đóng hàng (khớp mã vận đơn, mã đơn hoặc số đơn). */
export function demDaDong(danhSach: string[], video: { ma?: string | null; ma_don?: string | null; so_don?: string | null }[]): { tong: number; daDong: number; ngoaiDanhSach: number } {
  const norm = (s: unknown) => String(s ?? "").toUpperCase().replace(/\s/g, "");
  const ds = new Set(danhSach.map(norm).filter(Boolean));
  const hit = new Set<string>();
  let ngoai = 0;
  const seen = new Set<string>();
  for (const v of video) {
    const keys = [norm(v.ma), norm(v.ma_don), norm(v.so_don)].filter(Boolean);
    const k = keys.find((x) => ds.has(x));
    if (k) hit.add(k);
    else if (keys[0] && !seen.has(keys[0])) {
      seen.add(keys[0]);
      ngoai++;
    }
  }
  return { tong: ds.size, daDong: hit.size, ngoaiDanhSach: ngoai };
}

// ---------------------------------------------------------------------------
// Hiển thị
// ---------------------------------------------------------------------------

const VN_MS = 7 * 3600 * 1000;

/** "HH:MM dd/mm" theo giờ Việt Nam (UTC+7); không có giờ thì null. */
export function gioVN(t: string | number | Date | null | undefined): string | null {
  if (t == null || t === "") return null;
  const ms = t instanceof Date ? t.getTime() : typeof t === "number" ? t : Date.parse(t);
  if (!Number.isFinite(ms)) return null;
  const d = new Date(ms + VN_MS);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())} ${p(d.getUTCDate())}/${p(d.getUTCMonth() + 1)}`;
}

/** "2026-11-21" -> "21/11". */
export function ngayNgan(ngay: string): string {
  const [, m, d] = ngay.split("-");
  return `${d}/${m}`;
}

/** Tiền gọn cho điện thoại: 1,25 tỷ; 36,3tr; 850k; số nhỏ để nguyên. null -> "chưa có". */
export function tien(v: number | null | undefined): string {
  if (v == null) return "chưa có";
  const a = Math.abs(v);
  const s = v < 0 ? "−" : "";
  const f = (x: number, d: number) => x.toFixed(d).replace(".", ",").replace(/,0+$/, "");
  if (a >= 1e9) return `${s}${f(a / 1e9, 2)} tỷ`;
  if (a >= 1e6) return `${s}${f(a / 1e6, 1)}tr`;
  if (a >= 1e3) return `${s}${Math.round(a / 1e3)}k`;
  return `${s}${Math.round(a)}`;
}

/** 0.123 -> "12%"; có dấu khi `dau`. */
export function phanTram(v: number | null | undefined, dau = false): string {
  if (v == null) return "chưa có";
  const p = Math.round(v * 100);
  return `${dau && p > 0 ? "+" : ""}${p}%`.replace("-", "−");
}
