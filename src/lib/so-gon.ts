/**
 * Số gọn cho các lịch báo cáo sáng: vài chục dòng chữ, mỗi số kèm mốc giờ và nguồn, thay cho việc lịch tự kéo dữ liệu thô.
 * Chỉ ĐỌC Supabase. Không có tên, SĐT, địa chỉ hay nội dung tin của khách.
 * Nguyên tắc: thiếu hoặc chưa đủ ngày thì ghi "chưa có" / "CHƯA ĐỦ" kèm lý do, không ghi 0.
 *
 * Phần tính là hàm thuần (dongKieuGiao, dongCskh) để test; phần đọc database ở taiSoGon.
 */
import { addDays, vnDate } from "./autopilot/time";
import { allRows, db } from "./supabase";
import { chiThat, gioVN, ngayNgan, tien, tyLe, KENH, type DongBan } from "./quan-tri/tinh";
import type { KetQuaNgay } from "./cskh/tinh";
import type { gopCham } from "./cskh/cham";

const AGENT = "so_gon";
const n = (v: unknown) => Number(v ?? 0) || 0;
const num = (v: unknown): number | null => (v == null || !Number.isFinite(Number(v)) ? null : Number(v));
const maxIso = (xs: (string | null | undefined)[]) => xs.filter(Boolean).sort().pop() ?? null;
const pct1 = (x: number | null) => (x == null ? "chưa có" : `${(x * 100).toFixed(1).replace(".", ",")}%`);
const dauNgayIso = (ngay: string) => new Date(Date.parse(`${ngay}T00:00:00+07:00`)).toISOString();
const luc = (iso: string | null | undefined) => gioVN(iso) ?? "không rõ giờ";

/** Danh sách ngày (đã sắp) thành khoảng gọn: "01/01–09/01, 12/01". */
export function khoangNgay(ds: string[]): string {
  const out: string[] = [];
  for (let i = 0; i < ds.length; i++) {
    let j = i;
    while (j + 1 < ds.length && ds[j + 1] === addDays(ds[j], 1)) j++;
    out.push(j > i ? `${ngayNgan(ds[i])}–${ngayNgan(ds[j])}` : ngayNgan(ds[i]));
    i = j;
  }
  return out.join(", ");
}

// ---------------------------------------------------------------------------
// Kiều Giao: doanh số, chi quảng cáo, số cho mục tiêu
// ---------------------------------------------------------------------------

export interface VaoKieuGiao {
  /** Ngày cần số (thường là hôm qua) và hôm nay, giờ VN. */
  ngay: string;
  homNay: string;
  /** mk_sales nhóm day_channel của `ngay`. */
  banNgay: DongBan[] | null;
  /** mk_sales nhóm channel từ đầu tháng tới `ngay`. */
  banThang: DongBan[] | null;
  /** Lần thu đơn Shopee tốt gần nhất (job collect). */
  shopeeLuc: string | null;
  /** Giờ tạo của đơn Pancake mới nhất đã lên Supabase; lần đồng bộ Pancake gần nhất có lỗi không. */
  pancakeDen: string | null;
  pancakeLoi: boolean;
  /** Chi Shopee Ads (số Shopee báo) theo ngày, từ đầu tháng. */
  spChi: Map<string, number> | null;
  spLuc: string | null;
  /** Chi Meta (chưa nhân hệ số; đã bỏ BOSS TUYỀN lúc thu) theo ngày, tách tài khoản CPAS. */
  fbChi: Map<string, { thuong: number; cpas: number }> | null;
  fbLuc: string | null;
  /** Số cái bán từ một ngày gốc, theo mã (mk_product_profit). */
  ma: { tu: string; dong: { ma: string; sl_ban: number | null; gia_von_loi?: boolean | null }[] } | null;
  loi: Partial<Record<"banNgay" | "banThang" | "sp" | "fb" | "ma", string>>;
}

const TEN_KENH = Object.fromEntries(KENH.map((k) => [k.code, k.ten]));

/** Các dòng số cho lịch Kiều Giao. */
export function dongKieuGiao(v: VaoKieuGiao): string[] {
  const out: string[] = [];
  const ngayHet = dauNgayIso(addDays(v.ngay, 1));
  const shopeeDu = !!v.shopeeLuc && v.shopeeLuc >= ngayHet;
  const pancakeDu = !!v.pancakeDen && v.pancakeDen >= ngayHet;
  const nguonShopee = `Shopee API, thu 15 phút/lần, lần tốt cuối ${luc(v.shopeeLuc)}`;
  const nguonPancake = `Pancake POS đồng bộ về Supabase (máy văn phòng đẩy ~07:00), đơn mới nhất ${luc(v.pancakeDen)}${v.pancakeLoi ? ", lần đồng bộ cuối LỖI" : ""}`;
  const duKenh = (code: string) => (code.startsWith("shopee") ? shopeeDu : pancakeDu);
  const nhanDu = (code: string) =>
    duKenh(code) ? "" : code.startsWith("shopee") ? " · CHƯA ĐỦ NGÀY (chưa thu Shopee qua hết ngày)" : " · CHƯA ĐỦ NGÀY (Pancake chưa đồng bộ qua hết ngày, lấy thẳng Pancake)";

  out.push(`## Doanh số ${ngayNgan(v.ngay)} (doanh số giữ = sau hủy, hoàn)`);
  if (!v.banNgay) out.push(`- chưa có: ${v.loi.banNgay ?? "lỗi đọc mk_sales"}`);
  else {
    for (const k of KENH) {
      const r = v.banNgay.find((x) => x.ky === v.ngay && x.kenh === k.code);
      if (!r) {
        out.push(`- ${k.ten}: ${duKenh(k.code) ? "0 đơn, 0" : "chưa có"}${nhanDu(k.code)}`);
        continue;
      }
      const lai = k.nenTang === "shopee" && num(r.lai_sau_qc) != null ? `, lãi sau QC ${tien(num(r.lai_sau_qc))} (${pct1(tyLe(num(r.lai_sau_qc), num(r.doanh_so_giu)))})` : "";
      out.push(`- ${k.ten}: ${n(r.don_chot)} đơn, ${tien(num(r.doanh_so_giu))}${lai}${nhanDu(k.code)}`);
    }
  }
  out.push(`  nguồn: Shopee = ${nguonShopee}; Facebook, TikTok = ${nguonPancake}`);

  out.push(`## Chi quảng cáo ${ngayNgan(v.ngay)} (chi thật = số nền tảng × hệ số)`);
  const fbNgay = v.fbChi?.get(v.ngay);
  const fbTam = !!v.fbLuc && v.fbLuc < new Date(Date.parse(`${v.homNay}T07:00:00+07:00`)).toISOString() && v.homNay === addDays(v.ngay, 1);
  if (!v.fbChi) out.push(`- Facebook: chưa có (${v.loi.fb ?? "lỗi đọc fb_ad_daily"})`);
  else if (!fbNgay) out.push("- Facebook: chưa có số ngày này");
  else {
    const chi = chiThat(fbNgay.thuong, "facebook");
    const r = v.banNgay?.find((x) => x.ky === v.ngay && x.kenh === "facebook");
    const ds = pancakeDu ? num(r?.doanh_so_giu) ?? 0 : null;
    out.push(
      `- Facebook (bỏ BOSS TUYỀN 3/4/5/6 và CPAS): ${tien(chi)} × 1,111 đã nhân; QC/DT ${ds == null ? "chưa có (doanh thu Pancake chưa đủ ngày)" : pct1(tyLe(chi, ds))}${fbTam ? " · TẠM (số giờ, chốt 07:00)" : ""}`,
    );
    out.push(`- CPAS → Shopee (không tính vào kênh Facebook): ${tien(chiThat(fbNgay.cpas, "facebook"))}`);
  }
  if (!v.spChi) out.push(`- Shopee Ads: chưa có (${v.loi.sp ?? "lỗi đọc ads_shop_hourly"})`);
  else if (!v.spChi.has(v.ngay)) out.push("- Shopee Ads: chưa có số ngày này");
  else out.push(`- Shopee Ads: ${tien(chiThat(v.spChi.get(v.ngay), "shopee"))} (× 1,08 đã nhân)`);
  out.push("- TikTok Ads: chưa có (chưa kết nối nguồn)");
  out.push(`  nguồn: Meta Ads thu mỗi giờ 9h–23h về fb_ad_daily, lần cuối ${luc(v.fbLuc)}; Shopee Ads ads_shop_hourly, lần cuối ${luc(v.spLuc)}`);

  // ----- Tháng -----
  const dauThang = `${v.ngay.slice(0, 7)}-01`;
  out.push(`## Tháng ${v.ngay.slice(5, 7)} (từ ${ngayNgan(dauThang)} tới hết ${ngayNgan(v.ngay)})`);
  let tongDs: number | null = null;
  if (!v.banThang) out.push(`- doanh số tháng: chưa có (${v.loi.banThang ?? "lỗi đọc mk_sales"})`);
  else {
    const parts: string[] = [];
    tongDs = 0;
    for (const k of KENH) {
      const r = v.banThang.find((x) => x.kenh === k.code);
      const ds = num(r?.doanh_so_giu) ?? 0;
      tongDs += ds;
      parts.push(`${k.ten} ${tien(ds)}`);
    }
    out.push(`- doanh số giữ theo kênh: ${parts.join("; ")}${pancakeDu ? "" : " (Facebook, TikTok chưa đủ ngày cuối)"}`);
    out.push(`- MT-07 doanh số giữ mọi kênh: ${tien(tongDs)} (Shopee lấy từ Shopee, không phải Pancake list_analytics_sale)`);
    const mk = v.banThang.find((x) => x.kenh === "shopee_magickids");
    if (mk) out.push(`- MT-04 Shopee Magickids: doanh số giữ ${tien(num(mk.doanh_so_giu))}, lãi sau QC ${tien(num(mk.lai_sau_qc))} (${pct1(tyLe(num(mk.lai_sau_qc), num(mk.doanh_so_giu)))}), ${n(mk.don_tien_ve_uoc_tinh)} đơn tiền về còn ước tính`);
    else out.push("- MT-04 Shopee Magickids: chưa có");
  }
  // MT-03: chi QC thật cả tháng (Facebook gồm cả CPAS, vì vẫn là tiền chi), so doanh số mọi kênh.
  const ngayThang: string[] = [];
  for (let d = dauThang; d <= v.ngay; d = addDays(d, 1)) ngayThang.push(d);
  const spThang = v.spChi ? ngayThang.reduce((s, d) => s + (v.spChi!.get(d) ?? 0), 0) : null;
  const fbThieu = v.fbChi ? ngayThang.filter((d) => !v.fbChi!.has(d)) : [];
  const fbThang = v.fbChi ? ngayThang.reduce((s, d) => s + (v.fbChi!.get(d)?.thuong ?? 0) + (v.fbChi!.get(d)?.cpas ?? 0), 0) : null;
  const spThat = chiThat(spThang, "shopee");
  const fbThat = chiThat(fbThang, "facebook");
  const tongChi = spThat == null && fbThat == null ? null : (spThat ?? 0) + (fbThat ?? 0);
  out.push(
    `- MT-03 chi QC thật tháng: ${tien(tongChi)} (Shopee ${tien(spThat)}, Facebook gồm CPAS ${tien(fbThat)}, TikTok chưa có); /doanh số ${pct1(tyLe(tongChi, tongDs))}` +
      (fbThieu.length ? ` · Facebook THIẾU ${fbThieu.length} ngày: ${khoangNgay(fbThieu)}` : ""),
  );

  // ----- Mã hàng (MT-01, MT-02) -----
  if (v.ma) {
    if (!v.ma.dong.length) out.push(`- số cái bán theo mã: chưa có (${v.loi.ma ?? "không có dòng"})`);
    else {
      const tong = v.ma.dong.reduce((s, r) => s + n(r.sl_ban), 0);
      out.push(
        `- số cái bán từ ${ngayNgan(v.ma.tu)} tới đơn mới nhất: ${v.ma.dong.map((r) => `${r.ma} ${r.sl_ban == null ? "chưa có" : n(r.sl_ban).toLocaleString("vi-VN")}`).join("; ")}; cộng ${tong.toLocaleString("vi-VN")}` +
          ` (mọi kênh, không hủy, trừ hoàn; Facebook tới ${luc(v.pancakeDen)})`,
      );
    }
  }
  out.push("- MT-05, MT-06, MT-08, MT-09: chưa có trên máy chủ (lấy như cũ)");
  out.push(`  nguồn: core.daily_profit qua mk_sales, core.product_profit_month qua mk_product_profit; số lấy lúc trả lệnh này, Shopee tới ${luc(v.shopeeLuc)}`);
  return out;
}

// ---------------------------------------------------------------------------
// CSKH: tỉ lệ chốt, sale, khách tiềm năng (từ trang /cskh)
// ---------------------------------------------------------------------------

export interface VaoCskh {
  ngay: string;
  k: KetQuaNgay | null;
  g: ReturnType<typeof gopCham> | null;
  /** Lần chấm AI cuối cho ngày này. */
  chamLuc: string | null;
  tenPage: Record<string, string>;
  /** Mã hội thoại đầy đủ của các cuộc có tin khách mà chưa chấm (để lịch đọc riêng). */
  chuaCham: { page: string; id: string }[];
  toiDa: number;
  loi?: string;
}

const NHAN_KQ: Record<string, string> = {
  da_chot: "đã chốt", xin_duoc_sdt: "xin được SĐT", khach_im: "khách im", ngoai_size: "ngoài size", het_hang: "hết hàng", dang_trao_doi: "đang trao đổi", da_giai_quyet: "đã giải quyết", khac: "khác",
};
const NHAN_TN: Record<string, string> = { nong: "nóng", am: "ấm", lanh: "lạnh", khong: "không" };
const giay = (s: number | null | undefined) => (s == null ? "–" : s < 120 ? `${Math.round(s)}s` : `${Math.round(s / 60)}p`);
const diem = (x: number | null | undefined) => (x == null ? "–" : x.toFixed(1).replace(".", ","));
export const linkPancake = (page: string, id: string) => `https://pancake.vn/${encodeURIComponent(page)}?c_id=${encodeURIComponent(id)}`;
const cat = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

export function dongCskh(v: VaoCskh): string[] {
  const out: string[] = [];
  const ten = (p: string) => v.tenPage[p] ?? p;
  if (!v.k) {
    out.push(`## CSKH ${ngayNgan(v.ngay)}: chưa có (${v.loi ?? "chưa có bản tính ngày này trên /cskh"})`);
    return out;
  }
  const k = v.k;
  const t = k.tong;
  out.push(`## CSKH ${ngayNgan(v.ngay)} (trang /cskh, tính lúc ${luc(new Date(k.tinhLuc).toISOString())}${k.tamTinh ? ", TẠM TÍNH: chưa đủ 48 giờ nên số chốt còn tăng" : ""})`);
  out.push(`- định nghĩa chốt: cuộc có đơn POS (không hủy) tạo trong ${k.cauHinh.chotGio} giờ từ tin đầu trong ngày, khớp hội thoại hoặc SĐT`);
  out.push(`- tổng: ${t.cuoc} cuộc, ${t.khachMoi} khách mới, chốt mới ${t.chotMoi} (${pct1(tyLe(t.chotMoi, t.khachMoi))}), chốt khách cũ ${t.chotCu}, tin sót ${t.sot} (còn treo ${t.sotConTreo}), có SĐT ${t.coSdt}`);
  for (const p of k.pages) out.push(`- ${ten(p.page)}: ${p.khachMoi} khách mới, chốt ${p.chotMoi} (${pct1(tyLe(p.chotMoi, p.khachMoi))}), ${p.cuoc} cuộc, sót ${p.sot}`);

  out.push("## Người trực (trả lời đầu trong giờ: trung vị / 90%)");
  const diemNguoi = new Map((v.g?.diem ?? []).map((d) => [d.ten, d]));
  for (const x of k.nguoiTruc) {
    const d = diemNguoi.get(x.ten);
    out.push(
      `- ${x.ten}: ${x.cuoc} cuộc, ${giay(x.trungViGiay)} / ${giay(x.moc90Giay)}, chốt ${x.chot}/${x.khachMoi} khách mới, trả lời trễ ${x.traLoiTre}, tin mẫu ${x.chiDanMau}` +
        (d ? ` · điểm AI (${d.cuoc} cuộc) size ${diem(d.size)}, mua kèm ${diem(d.muaKem)}, chốt ${diem(d.chot)}, thái độ ${diem(d.thaiDo)}` : ""),
    );
  }

  if (!v.g) {
    out.push("## Chấm AI: chưa có (chưa đặt model hoặc chưa chấm ngày này)");
  } else {
    const g = v.g;
    out.push(`## Chấm AI: ${g.daCham}/${g.canCham} cuộc có tin khách, model ${g.model}, lần chấm cuối ${luc(v.chamLuc)}`);
    const tatCa = g.diem.find((d) => d.ten === "Tất cả");
    if (tatCa) out.push(`- điểm chung (thang 0–10): size ${diem(tatCa.size)}, mua kèm ${diem(tatCa.muaKem)}, chốt ${diem(tatCa.chot)}, thái độ ${diem(tatCa.thaiDo)}`);
    out.push(`- kết quả: ${g.ketQua.map((x) => `${NHAN_KQ[x.ketQua] ?? x.ketQua} ${x.cuoc}`).join(", ")}`);
    out.push(`- tiềm năng: ${g.tiemNang.map((x) => `${NHAN_TN[x.capDo]} ${x.cuoc}`).join(", ")}`);
    if (g.sanPham.length) out.push(`- mã được hỏi nhiều: ${g.sanPham.slice(0, 8).map((s) => `${s.ten} ${s.cuoc}`).join(", ")}`);
    if (g.xau.length) {
      out.push(`- phản hồi xấu (${g.xau.length}):`);
      for (const x of g.xau.slice(0, 5)) out.push(`  - ${ten(x.page)} …${x.duoi}: ${cat(x.moTaXau || x.nhanXet, 100)}`);
    }
    // Khách cần sale chăm: chăm lại trước (sale đã trả lời, khách im), rồi các khách nóng, ấm còn lại.
    const da = new Set<string>();
    const can = [...g.chamLai, ...g.khach.filter((x) => x.capDo === "nong" || x.capDo === "am")].filter((x) => {
      const key = `${x.page}|${x.id}`;
      if (da.has(key)) return false;
      da.add(key);
      return true;
    });
    out.push(`## Khách cần sale chăm: ${can.length} (nóng, ấm, chưa có đơn)${can.length > v.toiDa ? `, hiện ${v.toiDa} khách đầu` : ""}`);
    for (const x of can.slice(0, v.toiDa))
      out.push(`- [${NHAN_TN[x.capDo]}${x.diemTiemNang != null ? ` ${x.diemTiemNang}` : ""}] ${ten(x.page)} · ${x.sanPham.slice(0, 3).join(", ") || "–"} · ${cat(x.lyDo || x.viec, 90)} · ${linkPancake(x.page, x.id)}`);
  }

  if (v.chuaCham.length) {
    out.push(`## Chưa chấm: ${v.chuaCham.length} cuộc có tin khách (thường là chat sau lượt chấm 21h35); lịch tự đọc nếu cần:`);
    for (const x of v.chuaCham.slice(0, v.toiDa)) out.push(`- ${ten(x.page)} ${linkPancake(x.page, x.id)}`);
    if (v.chuaCham.length > v.toiDa) out.push(`- … và ${v.chuaCham.length - v.toiDa} cuộc nữa`);
  }
  out.push("  nguồn: cskh_ngay (đồng bộ chat Pancake 30 phút/lần 8h–23h30, chốt 00:30), cskh_cham (AI chấm 11h35, 17h35, 21h35)");
  return out;
}

// ---------------------------------------------------------------------------
// Đọc database
// ---------------------------------------------------------------------------

async function rpc<T>(fn: string, args?: Record<string, unknown>): Promise<T> {
  const { data, error } = await db().rpc(fn, args);
  if (error) throw new Error(error.message);
  return data as T;
}
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 200);

export type Phan = "kieu_giao" | "cskh" | "tat_ca";

export async function taiKieuGiao(ngay: string, ma: string[], maTu: string, now = new Date()): Promise<VaoKieuGiao> {
  const homNay = vnDate(now);
  const dauThang = `${ngay.slice(0, 7)}-01`;
  const loi: VaoKieuGiao["loi"] = {};
  const thu = async <T>(key: keyof VaoKieuGiao["loi"] | null, fn: () => Promise<T>): Promise<T | null> => {
    try {
      return await fn();
    } catch (e) {
      if (key) loi[key] = msg(e);
      return null;
    }
  };
  const [banNgay, banThang, sp, fb, web, collect, maRows] = await Promise.all([
    thu("banNgay", async () => (await rpc<{ dong: DongBan[] }>("mk_sales", { p_agent: AGENT, p_from: ngay, p_to: ngay, p_group: "day_channel" })).dong ?? []),
    thu("banThang", async () => (await rpc<{ dong: DongBan[] }>("mk_sales", { p_agent: AGENT, p_from: dauThang, p_to: ngay, p_group: "channel" })).dong ?? []),
    thu("sp", () =>
      allRows<{ date: string; expense: number; updated_at: string }>(() =>
        db().from("ads_shop_hourly").select("date, shop_id, hour, expense, updated_at").gte("date", dauThang).lte("date", ngay).order("date").order("shop_id").order("hour"))),
    thu("fb", () =>
      allRows<{ ngay: string; spend: number; cpas: boolean | null; updated_at: string }>(() =>
        db().from("fb_ad_daily").select("ngay, ad_id, spend, cpas, updated_at").gte("ngay", dauThang).lte("ngay", ngay).order("ngay").order("ad_id"))),
    thu(null, () => rpc<{ dong_bo: { job: string; ok: boolean }[]; don_pancake: { den: string | null } }>("mk_web_hom_nay")),
    thu(null, async () => {
      const { data, error } = await db().from("job_runs").select("finished_at").eq("job", "collect").eq("ok", true).order("started_at", { ascending: false }).limit(1);
      if (error) throw new Error(error.message);
      return (data?.[0]?.finished_at as string | undefined) ?? null;
    }),
    ma.length
      ? thu("ma", async () => {
          const rows = await Promise.all(ma.map((m) => rpc<{ ma: string; sl_ban: number | null; gia_von_loi?: boolean }[]>("mk_product_profit", { p_agent: AGENT, p_from: maTu, p_to: ngay, p_code: m, p_limit: 50 })));
          return ma.map((m, i) => rows[i]?.find((r) => r.ma === m) ?? { ma: m, sl_ban: null });
        })
      : Promise.resolve(null),
  ]);
  let spChi: Map<string, number> | null = null;
  if (sp) {
    spChi = new Map();
    for (const r of sp) spChi.set(r.date, (spChi.get(r.date) ?? 0) + n(r.expense));
  }
  let fbChi: VaoKieuGiao["fbChi"] = null;
  if (fb) {
    fbChi = new Map();
    for (const r of fb) {
      const a = fbChi.get(r.ngay) ?? { thuong: 0, cpas: 0 };
      if (r.cpas) a.cpas += n(r.spend);
      else a.thuong += n(r.spend);
      fbChi.set(r.ngay, a);
    }
  }
  return {
    ngay,
    homNay,
    banNgay,
    banThang,
    shopeeLuc: collect ?? null,
    pancakeDen: web?.don_pancake?.den ?? null,
    pancakeLoi: web?.dong_bo?.find((d) => d.job === "pancake_orders")?.ok === false,
    spChi,
    spLuc: sp ? maxIso(sp.map((r) => r.updated_at)) : null,
    fbChi,
    fbLuc: fb ? maxIso(fb.map((r) => r.updated_at)) : null,
    ma: ma.length ? { tu: maTu, dong: maRows ?? [] } : null,
    loi,
  };
}

export async function taiCskh(ngay: string, toiDa: number): Promise<VaoCskh> {
  const { layNgay, tenPage } = await import("./cskh/data");
  const { docCham } = await import("./cskh/cham-data");
  const { cauHinhAi, gopCham } = await import("./cskh/cham");
  const base: VaoCskh = { ngay, k: null, g: null, chamLuc: null, tenPage: tenPage(), chuaCham: [], toiDa };
  try {
    base.k = await layNgay(ngay);
  } catch (e) {
    return { ...base, loi: msg(e) };
  }
  if (!base.k) return base;
  const model = cauHinhAi()?.model;
  if (model) {
    try {
      const rows = await docCham(ngay, model);
      base.g = gopCham(base.k, rows, model);
      const da = new Set(rows.map((r) => `${r.page}|${r.id}`));
      base.chuaCham = base.k.cuoc.filter((c) => c.tinKhach > 0 && !da.has(`${c.page}|${c.id}`)).map((c) => ({ page: c.page, id: c.id }));
      const { data } = await db().from("cskh_cham").select("cham_luc").eq("ngay", ngay).eq("model", model).order("cham_luc", { ascending: false }).limit(1);
      base.chamLuc = (data?.[0]?.cham_luc as string | undefined) ?? null;
    } catch {
      base.g = null;
    }
  }
  return base;
}

/** Văn bản trả cho lệnh mk_so_sang. */
export async function soSang(opts: { phan: Phan; ngay?: string; ma?: string[]; maTu?: string; toiDa?: number }, now = new Date()): Promise<string> {
  const ngay = opts.ngay ?? addDays(vnDate(now), -1);
  const head = [`# Số gọn ${ngayNgan(ngay)}/${ngay.slice(0, 4)} · trả lúc ${gioVN(now)} · chỉ đọc Supabase`];
  const parts = await Promise.all([
    opts.phan !== "cskh" ? taiKieuGiao(ngay, opts.ma ?? [], opts.maTu ?? `${ngay.slice(0, 7)}-01`, now).then(dongKieuGiao) : Promise.resolve([]),
    opts.phan !== "kieu_giao" ? taiCskh(ngay, opts.toiDa ?? 15).then(dongCskh) : Promise.resolve([]),
  ]);
  return [...head, ...parts.flat()].join("\n");
}
