/**
 * Sổ hàng xưởng: phép tính tiến độ từ dữ liệu thô (lô cắt, lần hàng về, phiếu đặt).
 * Hàm thuần, không gọi mạng: trang /san-xuat, script nạp số đầu và test dùng chung.
 * Cùng công thức với view `sx_tien_do`, `sx_tien_do_lo` (supabase/migrations/0024_san_xuat.sql):
 *   còn nợ = số cắt − số KHO ĐẾM (không phải số xưởng giao).
 */

export type TrangThaiLo = "dang_ve" | "chua_doi_soat" | "dong";

export interface DoiHen {
  hen_cu: string | null;
  hen_moi: string;
  ly_do: string;
  nguon?: string | null;
  ghi_luc?: string | null;
}

export interface LoCat {
  id: number;
  ma_hang: string;
  lo: string;
  phieu_dat_id?: number | null;
  ngay_cat?: string | null;
  hen_tra: string | null;
  gia?: number | null;
  trang_thai: TrangThaiLo;
  ghi_chu?: string | null;
  dong: { mau: string; size: string; so_cat: number }[];
  doi_hen?: DoiHen[];
}

export interface HangVe {
  id: number;
  lo_id: number;
  ngay: string;
  so_phieu_xuong?: string | null;
  nguoi_ky?: string | null;
  so_phieu_pancake?: string | null;
  khong_nhap_pancake?: boolean;
  ghi_chu?: string | null;
  dong: { mau: string; size: string; xuong_giao: number | null; kho_dem: number | null }[];
}

export interface PhieuDat {
  id: number;
  ma_hang: string;
  dot: string;
  ngay_dat?: string | null;
  gia?: number | null;
  ngay_du_kien_cat?: string | null;
  trang_thai: "cho_cat" | "da_cat" | "huy";
  ghi_chu?: string | null;
  dong: { mau: string; size: string; so_luong: number }[];
}

export interface O {
  mau: string;
  size: string;
  soCat: number;
  xuongGiao: number;
  khoDem: number;
  conNo: number;
}

export interface TienDoLo {
  lo: LoCat;
  soCat: number;
  xuongGiao: number;
  khoDem: number;
  /** Xưởng đã giao nhưng kho chưa đếm: chưa tính là đã về. */
  choKhoDem: number;
  /** số cắt − kho đếm; âm nghĩa là về thừa. */
  conNo: number;
  ngayTre: number;
  henDau: string | null;
  soLanDoiHen: number;
  o: O[];
  lanVe: HangVe[];
}

/** Ngày hôm nay theo giờ Việt Nam, dạng YYYY-MM-DD. */
export function homNayVN(now: Date = new Date()): string {
  return new Date(now.getTime() + 7 * 3600_000).toISOString().slice(0, 10);
}

/** Số ngày từ `tu` đến `den` (YYYY-MM-DD); âm nếu `den` trước `tu`. */
export function soNgay(tu: string, den: string): number {
  return Math.round((Date.parse(`${den}T00:00:00Z`) - Date.parse(`${tu}T00:00:00Z`)) / 86_400_000);
}

/** 2026-11-21 → 21/11 (hoặc 21/11/2026 khi `nam`). */
export function ngayVN(iso: string | null | undefined, nam = false): string {
  if (!iso) return "";
  const [y, m, d] = iso.slice(0, 10).split("-");
  return nam ? `${d}/${m}/${y}` : `${d}/${m}`;
}

export const fmt = (n: number | null | undefined): string => (n == null ? "—" : n.toLocaleString("vi-VN"));

const khoa = (mau: string, size: string) => `${mau.trim().toLowerCase()}|${size.trim()}`;

/** Tiến độ một lô từ số cắt và mọi lần hàng về của lô đó. */
export function tinhLo(lo: LoCat, hangVe: HangVe[], homNay: string): TienDoLo {
  const map = new Map<string, O>();
  const get = (mau: string, size: string) => {
    const k = khoa(mau, size);
    let x = map.get(k);
    if (!x) map.set(k, (x = { mau: mau.trim(), size: size.trim(), soCat: 0, xuongGiao: 0, khoDem: 0, conNo: 0 }));
    return x;
  };
  for (const d of lo.dong) get(d.mau, d.size).soCat += d.so_cat;
  const lanVe = hangVe.filter((h) => h.lo_id === lo.id).sort((a, b) => a.ngay.localeCompare(b.ngay) || a.id - b.id);
  let choKhoDem = 0;
  for (const h of lanVe) {
    for (const d of h.dong) {
      const x = get(d.mau, d.size);
      x.xuongGiao += d.xuong_giao ?? 0;
      x.khoDem += d.kho_dem ?? 0;
      if (d.kho_dem == null) choKhoDem += d.xuong_giao ?? 0;
    }
  }
  const o = [...map.values()];
  for (const x of o) x.conNo = x.soCat - x.khoDem;
  const sum = (f: (x: O) => number) => o.reduce((a, x) => a + f(x), 0);
  const soCat = sum((x) => x.soCat);
  const khoDem = sum((x) => x.khoDem);
  const conNo = soCat - khoDem;
  const ngayTre =
    lo.trang_thai === "dang_ve" && lo.hen_tra && conNo > 0 ? Math.max(0, soNgay(lo.hen_tra, homNay)) : 0;
  const doiHen = lo.doi_hen ?? [];
  return {
    lo,
    soCat,
    xuongGiao: sum((x) => x.xuongGiao),
    khoDem,
    choKhoDem,
    conNo,
    ngayTre,
    henDau: doiHen.length ? doiHen[0].hen_cu : lo.hen_tra,
    soLanDoiHen: doiHen.length,
    o,
    lanVe,
  };
}

export type Nhan = { k: "late" | "warn" | "ok" | "idle"; t: string };

/** Nhãn trạng thái của lô (giống bản mẫu). */
export function nhanLo(t: TienDoLo, homNay: string): Nhan {
  if (t.lo.trang_thai === "chua_doi_soat") return { k: "idle", t: "Chưa đối soát" };
  if (t.conNo <= 0) return { k: "ok", t: "Đủ lô" };
  if (t.lo.trang_thai === "dong") return { k: "idle", t: `Đóng lô · thiếu ${fmt(t.conNo)}` };
  if (t.lo.hen_tra) {
    const d = soNgay(t.lo.hen_tra, homNay);
    if (d > 0) return { k: "late", t: `Trễ ${d} ngày` };
    if (d === 0) return { k: "warn", t: t.khoDem > 0 ? "Hẹn hôm nay · về một phần" : "Hẹn hôm nay" };
    return { k: "idle", t: `Còn ${-d} ngày` };
  }
  return { k: "warn", t: t.khoDem > 0 ? "Về một phần · chưa hẹn" : "Chưa hẹn ngày" };
}

/** Lô còn tính nợ: đang về và số cắt lớn hơn số kho đếm. */
export const conChoVe = (t: TienDoLo): boolean => t.lo.trang_thai === "dang_ve" && t.conNo > 0;

const soSize = (s: string) => (/^\d+(\.\d+)?$/.test(s) ? Number(s) : Number.POSITIVE_INFINITY);
const xepSize = (a: string, b: string) => soSize(a) - soSize(b) || a.localeCompare(b, "vi");

export interface MaTran {
  sizes: string[];
  hang: { mau: string; o: (number | null)[]; tong: number }[];
  tong: number[];
  tongCong: number;
}

/**
 * Ma trận còn nợ màu × size. Trả null khi chưa chia size được (số cắt hoặc số về ghi không có size):
 * khi đó dùng `conNoTheoMau`.
 */
export function maTran(t: TienDoLo): MaTran | null {
  if (!t.o.length || t.o.some((x) => x.size === "")) return null;
  const sizes = [...new Set(t.o.map((x) => x.size))].sort(xepSize);
  const mau = [...new Set(t.o.map((x) => x.mau))];
  const hang = mau.map((m) => {
    const o = sizes.map((s) => t.o.find((x) => khoa(x.mau, x.size) === khoa(m, s))?.conNo ?? null);
    return { mau: m, o, tong: o.reduce<number>((a, x) => a + (x ?? 0), 0) };
  });
  const tong = sizes.map((_, i) => hang.reduce((a, h) => a + (h.o[i] ?? 0), 0));
  return { sizes, hang, tong, tongCong: tong.reduce((a, b) => a + b, 0) };
}

export function conNoTheoMau(t: TienDoLo): { mau: string; soCat: number; khoDem: number; conNo: number }[] {
  const m = new Map<string, { mau: string; soCat: number; khoDem: number; conNo: number }>();
  for (const x of t.o) {
    const k = x.mau.toLowerCase();
    const r = m.get(k) ?? { mau: x.mau || "Chưa rõ màu", soCat: 0, khoDem: 0, conNo: 0 };
    r.soCat += x.soCat;
    r.khoDem += x.khoDem;
    r.conNo = r.soCat - r.khoDem;
    m.set(k, r);
  }
  return [...m.values()];
}

/** "Đỏ 160 · Xanh than 70": số cắt theo màu. */
export function mauCat(lo: LoCat): string {
  const m = new Map<string, number>();
  for (const d of lo.dong) m.set(d.mau || "Chưa rõ màu", (m.get(d.mau || "Chưa rõ màu") ?? 0) + d.so_cat);
  return [...m].map(([k, v]) => `${k} ${fmt(v)}`).join(" · ");
}

/** Số của một lần hàng về: kho đếm (nếu đã đếm đủ), xưởng giao, và có dòng nào chờ kho đếm không. */
export function tongLanVe(h: HangVe): { khoDem: number; xuongGiao: number; choKhoDem: number } {
  let khoDem = 0;
  let xuongGiao = 0;
  let choKhoDem = 0;
  for (const d of h.dong) {
    khoDem += d.kho_dem ?? 0;
    xuongGiao += d.xuong_giao ?? 0;
    if (d.kho_dem == null) choKhoDem += d.xuong_giao ?? 0;
  }
  return { khoDem, xuongGiao, choKhoDem };
}

/** "Đỏ 130: 1, 140: 8 · Trắng 150: 14" (ưu tiên số kho đếm, chưa đếm thì số xưởng giao). */
export function moTaLanVe(h: HangVe): string {
  const m = new Map<string, string[]>();
  const dong = [...h.dong].sort((a, b) => xepSize(a.size, b.size));
  for (const d of dong) {
    const n = d.kho_dem ?? d.xuong_giao ?? 0;
    const k = d.mau || "Chưa rõ màu";
    m.set(k, [...(m.get(k) ?? []), d.size ? `${d.size}: ${fmt(n)}` : fmt(n)]);
  }
  return [...m].map(([k, v]) => `${k} ${v.join(", ")}`).join(" · ");
}

export function nhanPancake(h: HangVe): string {
  if (h.so_phieu_pancake) return `Pancake #${h.so_phieu_pancake}`;
  if (h.khong_nhap_pancake) return "Không nhập Pancake";
  return "Chưa nhập Pancake";
}

export interface NgayVe {
  ngay: string;
  khoDem: number;
  choKhoDem: number;
  lan: { h: HangVe; lo: LoCat | undefined; khoDem: number; xuongGiao: number; choKhoDem: number }[];
}

/** Nhật ký hàng về, gom theo ngày, mới nhất trước. */
export function nhatKy(hangVe: HangVe[], los: LoCat[]): NgayVe[] {
  const byId = new Map(los.map((l) => [l.id, l]));
  const m = new Map<string, NgayVe>();
  for (const h of [...hangVe].sort((a, b) => b.ngay.localeCompare(a.ngay) || a.id - b.id)) {
    const t = tongLanVe(h);
    const d = m.get(h.ngay) ?? { ngay: h.ngay, khoDem: 0, choKhoDem: 0, lan: [] };
    d.khoDem += t.khoDem;
    d.choKhoDem += t.choKhoDem;
    d.lan.push({ h, lo: byId.get(h.lo_id), ...t });
    m.set(h.ngay, d);
  }
  return [...m.values()];
}

export interface PhieuCho {
  p: PhieuDat;
  soDat: number;
  daCat: number;
  conCho: number;
}

/** Phiếu đặt còn chờ cắt: trạng thái cho_cat và số đặt lớn hơn số đã cắt của các lô nối với phiếu. */
export function phieuChoCat(phieu: PhieuDat[], los: LoCat[]): PhieuCho[] {
  return phieu
    .filter((p) => p.trang_thai === "cho_cat")
    .map((p) => {
      const soDat = p.dong.reduce((a, d) => a + d.so_luong, 0);
      const daCat = los
        .filter((l) => l.phieu_dat_id === p.id)
        .reduce((a, l) => a + l.dong.reduce((b, d) => b + d.so_cat, 0), 0);
      return { p, soDat, daCat, conCho: soDat - daCat };
    })
    .filter((x) => x.conCho > 0);
}

export interface TomTat {
  loTre: number;
  conNo: number;
  veHomNay: number;
  phieuHomNay: number;
  choCat: number;
  choKhoDem: number;
}

export function tomTat(tienDo: TienDoLo[], hangVe: HangVe[], cho: PhieuCho[], homNay: string): TomTat {
  const mo = tienDo.filter(conChoVe);
  const nay = hangVe.filter((h) => h.ngay === homNay);
  return {
    loTre: mo.filter((t) => t.ngayTre > 0).length,
    conNo: mo.reduce((a, t) => a + t.conNo, 0),
    veHomNay: nay.reduce((a, h) => a + tongLanVe(h).khoDem, 0),
    phieuHomNay: new Set(nay.map((h) => h.so_phieu_pancake).filter(Boolean)).size,
    choCat: cho.reduce((a, x) => a + x.conCho, 0),
    choKhoDem: tienDo.reduce((a, t) => a + t.choKhoDem, 0),
  };
}

/** Xếp lô: trễ nhiều nhất trước, rồi theo ngày hẹn, lô không hẹn sau cùng. */
export function xepLo(tienDo: TienDoLo[]): TienDoLo[] {
  return [...tienDo].sort(
    (a, b) =>
      b.ngayTre - a.ngayTre ||
      Number(conChoVe(b)) - Number(conChoVe(a)) ||
      (a.lo.hen_tra ?? "9999").localeCompare(b.lo.hen_tra ?? "9999") ||
      a.lo.ma_hang.localeCompare(b.lo.ma_hang) ||
      a.lo.lo.localeCompare(b.lo.lo, "vi")
  );
}

// ---------- Kiểm tra đầu vào của công cụ ghi (chạy trước khi gọi database; database kiểm lại lần nữa) ----------

export interface DongVe {
  mau: string;
  size: string;
  xuong_giao?: number | null;
  kho_dem?: number | null;
}

/** Không trùng màu × size; trả câu lỗi hoặc null. */
export function loiDongTrung(dong: { mau: string; size: string }[]): string | null {
  const seen = new Set<string>();
  for (const d of dong) {
    const k = khoa(d.mau, d.size);
    if (seen.has(k)) return `Trùng dòng màu "${d.mau}" size "${d.size}"`;
    seen.add(k);
  }
  return null;
}

/** Luật của một lần hàng về. Trả câu lỗi hoặc null. */
export function loiHangVe(v: {
  id?: number;
  ma_hang?: string;
  lo?: string;
  ngay?: string;
  lines?: DongVe[];
  nguoi_ky?: string;
  pancake?: string;
  khong_nhap?: boolean;
}, homNay: string = homNayVN()): string | null {
  if (v.id == null && (!v.ma_hang || !v.lo || !v.ngay || !v.lines?.length)) {
    return "Lần hàng về mới cần mã hàng, lô, ngày và các dòng màu × size";
  }
  if (v.ngay && v.ngay > homNay) return `Ngày hàng về ${v.ngay} ở tương lai`;
  if (v.pancake && v.khong_nhap) return 'Chọn một: số phiếu Pancake hoặc "không nhập"';
  if (v.lines) {
    const trung = loiDongTrung(v.lines);
    if (trung) return trung;
    for (const d of v.lines) {
      if (d.xuong_giao == null && d.kho_dem == null) return `Dòng màu "${d.mau}" size "${d.size}" thiếu số lượng`;
    }
    if (v.pancake && v.lines.some((d) => d.kho_dem == null)) {
      return "Kho chưa đếm đủ các dòng: chưa được ghi số phiếu Pancake (kho thực nhận rồi mới nhập Pancake)";
    }
  }
  if (v.pancake && v.id == null && !v.nguoi_ky?.trim()) {
    return "Thiếu người của kho ký nhận: chưa được ghi số phiếu Pancake";
  }
  return null;
}
