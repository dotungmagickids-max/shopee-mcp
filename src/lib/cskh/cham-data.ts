/**
 * Đợt 2: job cho AI chấm các cuộc chat của một ngày và lưu điểm (bảng cskh_cham, migration 0030).
 * Đọc Pancake chỉ bằng GET; chữ của khách chỉ nằm trong bộ nhớ lúc chấm, không lưu.
 */
import { allRows, db } from "../supabase";
import { cauHinhAi, chamMot, gopCham, soanHoiThoai, type DongCham, type KetQuaCham } from "./cham";
import { congNgay, docNgay, ngayVN } from "./data";
import { docTinCoChu, pageTokens } from "./pancake-chat";
import { dauNgay, tinhNgay, type KetQuaNgay } from "./tinh";

const NGAY = 86_400_000;
const loi = (e: { message: string } | null) => {
  if (e) throw new Error(e.message);
};

const dongLuu = (ngay: string, page: string, id: string, model: string, k: KetQuaCham, tokenVao: number, tokenRa: number) => ({
  ngay,
  page_id: page,
  hoi_thoai_id: id,
  model,
  loai: k.loai,
  ket_qua: k.ketQua,
  diem_size: k.diemSize,
  diem_mua_kem: k.diemMuaKem,
  diem_chot: k.diemChot,
  diem_thai_do: k.diemThaiDo,
  san_pham: k.sanPham,
  tiem_nang: k.tiemNang,
  ly_do_tiem_nang: k.lyDoTiemNang,
  phan_hoi_xau: k.phanHoiXau,
  mo_ta_xau: k.moTaXau,
  do_dong_hang: k.doDongHang,
  viec: k.viec,
  muc_gap: k.mucGap,
  nhan_xet: k.nhanXet,
  token_vao: tokenVao,
  token_ra: tokenRa,
  cham_luc: new Date().toISOString(),
});

export async function docCham(ngay: string, model: string): Promise<DongCham[]> {
  const rows = await allRows<any>(() => db().from("cskh_cham").select("*").eq("ngay", ngay).eq("model", model).order("page_id").order("hoi_thoai_id"));
  return rows.map((r) => ({
    page: r.page_id,
    id: r.hoi_thoai_id,
    loai: r.loai,
    ketQua: r.ket_qua,
    diemSize: r.diem_size,
    diemMuaKem: r.diem_mua_kem,
    diemChot: r.diem_chot,
    diemThaiDo: r.diem_thai_do,
    sanPham: r.san_pham ?? [],
    tiemNang: r.tiem_nang ?? "khong",
    lyDoTiemNang: r.ly_do_tiem_nang ?? "",
    phanHoiXau: !!r.phan_hoi_xau,
    moTaXau: r.mo_ta_xau ?? "",
    doDongHang: !!r.do_dong_hang,
    viec: r.viec ?? "",
    mucGap: r.muc_gap === 1 || r.muc_gap === 3 ? r.muc_gap : 2,
    nhanXet: r.nhan_xet ?? "",
  }));
}

/** Bảng điểm đã gộp của một ngày cho trang; null khi chưa đặt model hoặc bảng chưa có. */
export async function layCham(k: KetQuaNgay): Promise<ReturnType<typeof gopCham> | null> {
  const model = process.env.CSKH_AI_MODEL?.trim();
  if (!model) return null;
  try {
    return gopCham(k, await docCham(k.ngay, model), model);
  } catch {
    return null;
  }
}

/**
 * Chấm các cuộc có khách nhắn trong ngày (mặc định hôm qua). Chạy lại được: cuộc đã chấm bằng model này thì bỏ qua;
 * hết thời gian hoặc chạm trần `toiDa` thì dừng, lượt sau chấm tiếp. `model` để thử một model khác với model mặc định.
 */
export async function chamNgay(ngay = congNgay(ngayVN(), -1), opts: { model?: string; hanMs?: number; toiDa?: number; lai?: boolean } = {}) {
  const c = cauHinhAi(opts.model);
  if (!c) throw new Error("Chưa đặt CSKH_AI_BASE_URL, CSKH_AI_API_KEY, CSKH_AI_MODEL");
  const pages = new Map(pageTokens().map((p) => [p.id, p]));
  if (!pages.size) throw new Error("Chưa đặt PANCAKE_PAGE_TOKENS");
  const batDau = Date.now();
  const hanMs = opts.hanMs ?? 240_000;
  const toiDa = Math.max(1, Math.min(2000, opts.toiDa ?? (Number(process.env.CSKH_AI_MAX_NGAY) || 600)));
  const d0 = dauNgay(ngay);
  const { ds, dons } = await docNgay(ngay);
  const k = tinhNgay(ds, dons, ngay);
  const can = k.cuoc.filter((x) => x.tinKhach > 0 && pages.has(x.page));
  const da = new Set(opts.lai ? [] : (await docCham(ngay, c.model)).map((r) => `${r.page}|${r.id}`));
  const chua = can.filter((x) => !da.has(`${x.page}|${x.id}`));
  const lam = chua.slice(0, toiDa);
  let xong = 0;
  let hong = 0;
  let tokenVao = 0;
  let tokenRa = 0;
  const loiDau: string[] = [];
  for (let i = 0; i < lam.length && Date.now() - batDau < hanMs; i += 4) {
    await Promise.all(
      lam.slice(i, i + 4).map(async (x) => {
        try {
          const tin = await docTinCoChu(pages.get(x.page)!, x.id, d0 - 3 * NGAY);
          const r = await chamMot(soanHoiThoai(tin, d0, d0 + NGAY), c);
          tokenVao += r.tokenVao;
          tokenRa += r.tokenRa;
          if (!r.kq) throw new Error("AI trả lời không đúng dạng");
          loi((await db().from("cskh_cham").upsert(dongLuu(ngay, x.page, x.id, c.model, r.kq, r.tokenVao, r.tokenRa))).error);
          xong += 1;
        } catch (err) {
          hong += 1;
          if (loiDau.length < 3) loiDau.push(err instanceof Error ? err.message.slice(0, 200) : "lỗi");
        }
      }),
    );
  }
  return { ngay, model: c.model, canCham: can.length, daChamTruoc: can.length - chua.length, chamLuotNay: xong, hong, conLai: chua.length - xong, tokenVao, tokenRa, loi: loiDau };
}
