import {
  conChoVe,
  conNoTheoMau,
  fmt,
  maTran,
  mauCat,
  moTaLanVe,
  nhanLo,
  nhanPancake,
  nhatKy,
  phieuChoCat,
  tinhLo,
  tomTat,
  tongLanVe,
  xepLo,
  type MaTran,
  type Nhan,
  type TomTat,
} from "./san-xuat";
import type { SoSanXuat } from "./san-xuat-data";

/**
 * Sổ hàng xưởng cho app quầy kho (/kho): bản CHỈ ĐỌC, đã tính sẵn và ĐÃ BỎ GIÁ.
 * App kho dùng chung một mã truy cập cho cả kho, nên giá đặt xưởng và mọi số tiền trong ghi chú
 * phải bị bỏ ngay ở máy chủ: không có trường `gia`, ghi chú đi qua `boTien`.
 */

const TU_TIEN = /giá|đ\s*\/\s*(cái|bộ|chiếc)|đồng|thành tiền|tiền|công nợ|thanh toán|₫|vnđ|vnd/i;
/** Số có dấu ngăn nghìn từ 10.000 trở lên (61.000, 1.250.000), hoặc 5 đến 7 chữ số liền không phải mã (#24678, PĐH-261117-05). */
const SO_TIEN = /(?<![\d.,#-])\d{2,3}(?:[.,]\d{3})+(?![\d-])|(?<![\d.,#\-/])\d{5,7}(?![\d.,\-/])|\d\s*(?:k|nghìn|ngàn|triệu|tr)\b/i;
/** Phép nhân kiểu "47 × 91.000", "47 x 91". */
const PHEP_NHAN = /\d\s*[×x*]\s*\d/i;

/**
 * Bỏ mọi vế câu có nhắc tới tiền. Cắt theo vế (". ", ";", " · ", xuống dòng, ngoặc đơn) rồi bỏ cả vế:
 * thà mất một vế ghi chú còn hơn để lọt giá. Số lượng (2.400 cái, 1.018) không bị coi là tiền.
 */
export function boTien(s: string | null | undefined): string {
  if (!s) return "";
  const coTien = (x: string) => TU_TIEN.test(x) || SO_TIEN.test(x) || PHEP_NHAN.test(x);
  return s
    .split(/(?<=[.;])\s+|\s+·\s+|\n+/)
    .map((ve) => {
      if (!coTien(ve)) return ve.trim();
      // Vế có tiền nằm trong ngoặc: bỏ ngoặc, giữ phần ngoài nếu phần ngoài sạch.
      const ngoai = ve.replace(/\s*\([^()]*\)/g, (m) => (coTien(m) ? "" : m)).trim();
      return coTien(ngoai) ? "" : ngoai;
    })
    .filter(Boolean)
    .join(" · ");
}

export interface KhoLo {
  id: number;
  ma: string;
  lo: string;
  mau: string;
  soCat: number;
  khoDem: number;
  choKhoDem: number;
  conNo: number;
  ngayTre: number;
  henTra: string | null;
  ngayCat: string | null;
  trangThai: string;
  nhan: Nhan;
  /** Lô đang về và còn nợ. */
  choVe: boolean;
  maTran: MaTran | null;
  /** Còn nợ theo màu, dùng khi chưa chia được theo size. */
  theoMau: { mau: string; conNo: number }[];
  ghiChu: string;
  lanVe: { ngay: string; so: string; pancake: string }[];
  doiHen: { cu: string | null; moi: string; lyDo: string }[];
}

export interface KhoNgayVe {
  ngay: string;
  khoDem: number;
  choKhoDem: number;
  lan: { lo: string; moTa: string; so: number; choDem: boolean; ky: string; pancake: string; ghiChu: string }[];
}

export interface KhoPhieu {
  ma: string;
  dot: string;
  conCho: number;
  soDat: number;
  daCat: number;
  ngayDat: string | null;
  duKienCat: string | null;
  ghiChu: string;
}

export interface KhoSanXuat {
  at: number;
  homNay: string;
  tomTat: TomTat;
  los: KhoLo[];
  ngay: KhoNgayVe[];
  phieu: KhoPhieu[];
}

export function soChoKho(so: SoSanXuat, homNay: string, now: number = Date.now()): KhoSanXuat {
  const tienDo = xepLo(so.los.map((l) => tinhLo(l, so.hangVe, homNay)));
  const cho = phieuChoCat(so.phieu, so.los);
  return {
    at: now,
    homNay,
    tomTat: tomTat(tienDo, so.hangVe, cho, homNay),
    los: tienDo.map((t) => {
      const chuaDoiSoat = t.lo.trang_thai === "chua_doi_soat";
      const mt = chuaDoiSoat ? null : maTran(t);
      return {
        id: t.lo.id,
        ma: t.lo.ma_hang,
        lo: t.lo.lo,
        mau: mauCat(t.lo),
        soCat: t.soCat,
        khoDem: t.khoDem,
        choKhoDem: t.choKhoDem,
        conNo: t.conNo,
        ngayTre: t.ngayTre,
        henTra: t.lo.hen_tra,
        ngayCat: t.lo.ngay_cat ?? null,
        trangThai: t.lo.trang_thai,
        nhan: nhanLo(t, homNay),
        choVe: conChoVe(t),
        maTran: mt,
        theoMau: chuaDoiSoat || mt ? [] : conNoTheoMau(t).map((x) => ({ mau: x.mau, conNo: x.conNo })),
        ghiChu: boTien(t.lo.ghi_chu),
        lanVe: t.lanVe.map((h) => {
          const v = tongLanVe(h);
          return {
            ngay: h.ngay,
            so: v.choKhoDem > 0 && v.khoDem === 0 ? `${fmt(v.xuongGiao)} xưởng giao, chờ kho đếm` : fmt(v.khoDem),
            pancake: h.so_phieu_pancake ? `#${h.so_phieu_pancake}` : "",
          };
        }),
        doiHen: (t.lo.doi_hen ?? []).map((d) => ({ cu: d.hen_cu, moi: d.hen_moi, lyDo: boTien(d.ly_do) })),
      };
    }),
    ngay: nhatKy(so.hangVe, so.los)
      .slice(0, 30)
      .map((d) => ({
        ngay: d.ngay,
        khoDem: d.khoDem,
        choKhoDem: d.choKhoDem,
        lan: d.lan.map((x) => ({
          lo: x.lo ? `${x.lo.ma_hang} ${x.lo.lo}` : `Lô #${x.h.lo_id}`,
          moTa: moTaLanVe(x.h),
          so: x.choKhoDem > 0 && x.khoDem === 0 ? x.xuongGiao : x.khoDem,
          choDem: x.choKhoDem > 0,
          ky: x.h.nguoi_ky ?? "",
          pancake: nhanPancake(x.h),
          ghiChu: boTien(x.h.ghi_chu),
        })),
      })),
    phieu: cho.map(({ p, soDat, daCat, conCho }) => ({
      ma: p.ma_hang,
      dot: p.dot,
      conCho,
      soDat,
      daCat,
      ngayDat: p.ngay_dat ?? null,
      duKienCat: p.ngay_du_kien_cat ?? null,
      ghiChu: boTien(p.ghi_chu),
    })),
  };
}
