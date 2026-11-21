import { allRows, db } from "./supabase";
import type { DoiHen, HangVe, LoCat, PhieuDat } from "./san-xuat";

export interface SoSanXuat {
  los: LoCat[];
  hangVe: HangVe[];
  phieu: PhieuDat[];
}

/** Đọc toàn bộ sổ hàng xưởng (chỉ đọc). Phép tính nằm ở `san-xuat.ts`. */
export async function docSoSanXuat(): Promise<SoSanXuat> {
  const [los, hangVe, phieu] = await Promise.all([
    allRows<LoCat & { doi_hen: (DoiHen & { id: number })[] }>(() =>
      db()
        .from("sx_lo_cat")
        .select(
          "id, ma_hang, lo, phieu_dat_id, ngay_cat, hen_tra, gia, trang_thai, ghi_chu, " +
            "dong:sx_lo_cat_dong(mau, size, so_cat), doi_hen:sx_doi_hen(id, hen_cu, hen_moi, ly_do, nguon, ghi_luc)"
        )
        .order("id")
    ),
    allRows<HangVe>(() =>
      db()
        .from("sx_hang_ve")
        .select(
          "id, lo_id, ngay, so_phieu_xuong, nguoi_ky, so_phieu_pancake, khong_nhap_pancake, ghi_chu, " +
            "dong:sx_hang_ve_dong(mau, size, xuong_giao, kho_dem)"
        )
        .order("id")
    ),
    allRows<PhieuDat>(() =>
      db()
        .from("sx_phieu_dat")
        .select(
          "id, ma_hang, dot, ngay_dat, gia, ngay_du_kien_cat, trang_thai, ghi_chu, dong:sx_phieu_dat_dong(mau, size, so_luong)"
        )
        .order("id")
    ),
  ]);
  for (const l of los) l.doi_hen = [...(l.doi_hen ?? [])].sort((a, b) => a.id - b.id);
  return { los, hangVe, phieu };
}
