/**
 * Web quản trị, trang "Hôm nay": đọc số từ Supabase (chỉ đọc, phía máy chủ) rồi ghép thành các khối.
 * Mỗi nguồn đọc riêng: một nguồn lỗi hoặc chưa có thì khối đó ghi rõ lý do, các khối khác vẫn hiện.
 * Không đọc tên, SĐT, địa chỉ khách; không đọc nội dung việc (tiêu đề việc có thể chứa SĐT).
 */
import { allRows, db } from "../supabase";
import { addDays, vnDate } from "../autopilot/time";
import {
  KENH, amTon, chiThat, demDaDong, gioVN, gomViec, ngayNgan, oBan, soTran, thayDoi, tongBan, tonSapHet, tyLe, xepViec,
  type DongBan, type Kenh, type MaAm, type MaTon, type NenTang, type NguCanhBan, type OBan, type PhanChi, type SoTran, type TongBan, type ViecNguoi,
} from "./tinh";

const AGENT = "web_quan_tri";

type Thu<T> = { ok: true; v: T } | { ok: false; loi: string };

async function thu<T>(fn: () => PromiseLike<T> | T): Promise<Thu<T>> {
  try {
    return { ok: true, v: await fn() };
  } catch (err) {
    return { ok: false, loi: (err instanceof Error ? err.message : String(err)).slice(0, 200) };
  }
}

async function rpc<T>(fn: string, args?: Record<string, unknown>): Promise<T> {
  const { data, error } = await db().rpc(fn, args);
  if (error) throw new Error(error.message);
  return data as T;
}

function must<T>(what: string, r: { data: T | null; error: { message: string } | null }): T {
  if (r.error) throw new Error(`${what}: ${r.error.message}`);
  return r.data as T;
}

const n = (v: unknown) => Number(v ?? 0) || 0;
const maxIso = (xs: (string | null | undefined)[]) => xs.filter(Boolean).sort().pop() ?? null;

// ---------------------------------------------------------------------------
// Dạng dữ liệu trả cho trang
// ---------------------------------------------------------------------------

/** Số từ hàm mk_web_hom_nay (migration 0024). */
interface Web {
  viec: ViecNguoi[];
  de_xuat: { phong: string; viec: string; so: number; cu_nhat: string }[];
  dong_bo: { job: string; lan_cuoi: string | null; lan_cuoi_ok: string | null; ok: boolean }[];
  don_pancake: { den: string | null; dong_bo_luc: string | null; mo: { kenh: string; trang_thai: string | null; so: number; cu_nhat: string | null }[] };
}

export interface CotBan {
  nhan: string;
  ngay: string;
  ngaySo: string;
  dong: { kenh: Kenh; o: OBan; truoc: OBan; thayDoi: number | null }[];
  tong: TongBan;
  tongTruoc: TongBan;
  thayDoi: number | null;
}

export interface DongQc {
  nenTang: NenTang;
  chi: number | null;
  doanhSo: number | null;
  tyLe: number | null;
  thieu: string | null;
}

export interface Nguon {
  ten: string;
  chuKy: string;
  lanCuoi: string | null;
  /** tot | tre | loi | chua_co */
  tinhTrang: "tot" | "tre" | "loi" | "chua_co";
  ghiChu?: string;
}

export interface HomNay {
  homNay: string;
  homQua: string;
  luc: string;
  /** Hàm mk_web_hom_nay chưa có trên database (chưa chạy migration 0024). */
  thieuHam: boolean;
  ban: { loi?: string; cot: CotBan[]; soLucShopee: string | null; soLucPancake: string | null; pancakeLoi: boolean };
  qc: { loi?: string; ngay: { nhan: string; ngay: string; dong: DongQc[] }[]; thang: SoTran; thangPhan: PhanChi[]; soLuc: string | null };
  ton: { loi?: string; sapHet: MaTon[] | null; am: MaAm[] | null; soLuc: string | null };
  don: {
    dongHang: { tong: number; daDong: number; ngoaiDanhSach: number } | null;
    dongHangLoi?: string;
    dongHangLuc: string | null;
    shopeeChoGui: number | null;
    shopeeLoi?: string;
    pancakeMo: { nhan: string; so: number; cuNhat: string | null }[] | null;
    pancakeLuc: string | null;
    soLucShopee: string | null;
  };
  viec: { loi?: string; nguoi: ViecNguoi[] | null; itNhat: boolean; deXuat: Web["de_xuat"] | null; deXuatSo: number | null; soLuc: string };
  heThong: { nguon: Nguon[]; loi24h: { job: string; luc: string | null }[] | null };
}

const TRANG_THAI_PANCAKE: Record<string, string> = { new: "Đơn mới", submitted: "Đã xác nhận, chờ đóng", waitting: "Chờ hàng" };
const CHO_GUI_SHOPEE = ["READY_TO_SHIP", "PROCESSED", "RETRY_SHIP"];
const JOBS = ["collect", "daily_orders", "daily_escrow", "daily_costs"] as const;

function tuoiPhut(iso: string | null, now: Date): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? (now.getTime() - ms) / 60000 : null;
}

// ---------------------------------------------------------------------------

export async function taiHomNay(now = new Date()): Promise<HomNay> {
  const homNay = vnDate(now);
  const homQua = addDays(homNay, -1);
  const dauThang = `${homNay.slice(0, 7)}-01`;
  const tuQc = dauThang < homQua ? dauThang : homQua;
  const dauNgayIso = new Date(Date.parse(`${homNay}T00:00:00+07:00`)).toISOString();

  const [web, ban, spAds, fbAds, fbDau, hang, am, tonLuc, khoDon, khoVideo, choGui, jobs, loi24h] = await Promise.all([
    thu(() => rpc<Web>("mk_web_hom_nay")),
    thu(async () => (await rpc<{ dong: DongBan[] }>("mk_sales", { p_agent: AGENT, p_from: addDays(homNay, -8), p_to: homNay, p_group: "day_channel" })).dong ?? []),
    thu(() =>
      allRows<{ date: string; expense: number; updated_at: string }>(() =>
        db().from("ads_shop_hourly").select("date, shop_id, hour, expense, updated_at").gte("date", tuQc).order("date").order("shop_id").order("hour"))),
    thu(() =>
      allRows<{ ngay: string; spend: number; updated_at: string }>(() =>
        db().from("fb_ad_daily").select("ngay, ad_id, spend, updated_at").gte("ngay", tuQc).order("ngay").order("ad_id"))),
    thu(async () => must("fb_ad_daily", await db().from("fb_ad_daily").select("ngay").order("ngay").limit(1))?.[0]?.ngay as string | undefined),
    thu(() => rpc<{ code: string; name: string | null; ton: number; ban_moi_ngay: number }[]>("mk_products", { p_agent: AGENT, p_query: null, p_in_stock_only: true, p_limit: 500 })),
    thu(async () => must("pancake_variations", await db().from("pancake_variations").select("sku, product_code, stock").lt("stock", 0).limit(1000)) as { sku: string; product_code: string | null; stock: number }[]),
    thu(async () => must("pancake_variations", await db().from("pancake_variations").select("updated_at").order("updated_at", { ascending: false }).limit(1))?.[0]?.updated_at as string | undefined),
    thu(async () => must("kho_don", await db().from("kho_don").select("ma, tao_luc").eq("ngay", homNay).limit(5000)) as { ma: string; tao_luc: string }[]),
    thu(async () =>
      must("kho_video", await db().from("kho_video").select("ma, ma_don, so_don, bat_dau").eq("che_do", "DH").eq("da_xoa", false).gte("bat_dau", dauNgayIso).limit(5000)) as { ma: string; ma_don: string | null; so_don: string | null; bat_dau: string }[]),
    thu(async () => {
      const r = await db().from("orders").select("order_sn", { count: "exact", head: true }).in("order_status", CHO_GUI_SHOPEE).gte("create_time", Math.floor(now.getTime() / 1000) - 30 * 86400);
      if (r.error) throw new Error(r.error.message);
      return r.count ?? null;
    }),
    thu(async () => {
      const out: Record<string, { lanCuoi: string | null; lanCuoiOk: string | null; ok: boolean | null }> = {};
      await Promise.all(
        JOBS.map(async (job) => {
          const rows = must("job_runs", await db().from("job_runs").select("started_at, finished_at, ok").eq("job", job).order("started_at", { ascending: false }).limit(6)) as { started_at: string; finished_at: string | null; ok: boolean | null }[];
          out[job] = { lanCuoi: rows[0]?.started_at ?? null, lanCuoiOk: rows.find((r) => r.ok)?.finished_at ?? null, ok: rows[0]?.ok ?? null };
        }));
      return out;
    }),
    thu(async () =>
      must("job_runs", await db().from("job_runs").select("job, started_at").eq("ok", false).gte("started_at", new Date(now.getTime() - 24 * 3600_000).toISOString()).order("started_at", { ascending: false }).limit(10)) as { job: string; started_at: string }[]),
  ]);

  const thieuHam = !web.ok && /mk_web_hom_nay|schema cache|PGRST202/i.test(web.loi);
  const w = web.ok ? web.v : null;

  // ----- Doanh số, lãi -----
  const pancakeRun = w?.dong_bo.find((d) => d.job === "pancake_orders") ?? null;
  const collect = jobs.ok ? jobs.v.collect : null;
  const fbChi = new Map<string, number>();
  if (fbAds.ok) for (const r of fbAds.v) fbChi.set(r.ngay, (fbChi.get(r.ngay) ?? 0) + n(r.spend));
  const ctx: NguCanhBan = {
    pancakeDen: w?.don_pancake.den ? vnDate(new Date(w.don_pancake.den)) : null,
    shopeeDen: collect?.lanCuoiOk ? vnDate(new Date(collect.lanCuoiOk)) : null,
    fbChi,
  };
  const rows = ban.ok ? ban.v : [];
  const cot = (nhan: string, ngay: string): CotBan => {
    const ngaySo = addDays(ngay, -7);
    const dong = KENH.map((kenh) => {
      const o = oBan(rows, kenh, ngay, ctx);
      const truoc = oBan(rows, kenh, ngaySo, ctx);
      return { kenh, o, truoc, thayDoi: thayDoi(o.doanhSo, truoc.doanhSo) };
    });
    const tong = tongBan(dong);
    const tongTruoc = tongBan(dong.map((d) => ({ kenh: d.kenh, o: d.truoc })));
    // Chỉ so tổng khi hai ngày cộng cùng một bộ kênh.
    const cungKenh = tong.thieuKenh.join() === tongTruoc.thieuKenh.join();
    return { nhan, ngay, ngaySo, dong, tong, tongTruoc, thayDoi: cungKenh ? thayDoi(tong.doanhSo, tongTruoc.doanhSo) : null };
  };
  const cotBan = ban.ok ? [cot("Hôm qua", homQua), cot("Hôm nay đến giờ", homNay)] : [];

  // ----- Quảng cáo -----
  const spNgay = new Map<string, number>();
  if (spAds.ok) for (const r of spAds.v) spNgay.set(r.date, (spNgay.get(r.date) ?? 0) + n(r.expense));
  const doanhSoNenTang = (c: CotBan | undefined, nt: NenTang): number | null => {
    const ds = (c?.dong ?? []).filter((d) => d.kenh.nenTang === nt).map((d) => d.o.doanhSo);
    return ds.length && ds.every((x) => x != null) ? ds.reduce((s: number, x) => s + (x as number), 0) : null;
  };
  const qcNgay = [homQua, homNay].map((ngay, i) => {
    const c = cotBan[i];
    const mk = (nenTang: NenTang, chi: number | null, thieu: string | null): DongQc => {
      const doanhSo = doanhSoNenTang(c, nenTang);
      return { nenTang, chi, doanhSo, tyLe: tyLe(chi, doanhSo), thieu };
    };
    return {
      nhan: i === 0 ? "Hôm qua" : "Hôm nay đến giờ",
      ngay,
      dong: [
        mk("shopee", spAds.ok && spNgay.has(ngay) ? chiThat(spNgay.get(ngay), "shopee") : null, !spAds.ok ? "lỗi đọc số" : spNgay.has(ngay) ? null : "chưa thu được số ngày này"),
        mk("facebook", fbAds.ok && fbChi.has(ngay) ? chiThat(fbChi.get(ngay), "facebook") : null, !fbAds.ok ? "lỗi đọc số" : fbChi.has(ngay) ? null : "chưa có số ngày này"),
        mk("tiktok", null, "chưa có nguồn chi quảng cáo TikTok"),
      ],
    };
  });
  const trongThang = (m: Map<string, number>) => [...m].filter(([d]) => d >= dauThang).reduce((s, [, v]) => s + v, 0);
  const spDau = [...spNgay.keys()].filter((d) => d >= dauThang).sort()[0];
  const fbCoThang = [...fbChi.keys()].some((d) => d >= dauThang);
  const thangPhan: PhanChi[] = [
    {
      nenTang: "shopee",
      chi: spAds.ok && spDau ? chiThat(trongThang(spNgay), "shopee") : null,
      thieu: !spAds.ok ? "lỗi đọc số" : !spDau ? "chưa có số tháng này" : spDau > dauThang ? `chỉ có số từ ${ngayNgan(spDau)}` : null,
    },
    {
      nenTang: "facebook",
      chi: fbAds.ok && fbCoThang ? chiThat(trongThang(fbChi), "facebook") : null,
      thieu: !fbAds.ok ? "lỗi đọc số" : !fbCoThang ? "chưa có số tháng này" : fbDau.ok && fbDau.v && fbDau.v > dauThang ? `chỉ có số từ ${ngayNgan(fbDau.v)}, thiếu các ngày trước đó` : null,
    },
    { nenTang: "tiktok", chi: null, thieu: "chưa có nguồn chi quảng cáo TikTok" },
  ];
  const fbLuc = fbAds.ok ? maxIso(fbAds.v.map((r) => r.updated_at)) : null;
  const spLuc = spAds.ok ? maxIso(spAds.v.map((r) => r.updated_at)) : null;

  // ----- Đơn -----
  const khoLuc = maxIso([...(khoDon.ok ? khoDon.v.map((r) => r.tao_luc) : []), ...(khoVideo.ok ? khoVideo.v.map((r) => r.bat_dau) : [])]);
  const gomMo = new Map<string, { nhan: string; so: number; cuNhat: string | null }>();
  for (const m of w?.don_pancake.mo ?? []) {
    const key = m.trang_thai ?? "?";
    const a = gomMo.get(key) ?? { nhan: TRANG_THAI_PANCAKE[key] ?? key, so: 0, cuNhat: null };
    a.so += n(m.so);
    if (m.cu_nhat && (!a.cuNhat || m.cu_nhat < a.cuNhat)) a.cuNhat = m.cu_nhat;
    gomMo.set(key, a);
  }

  // ----- Việc (chưa có hàm mới thì đếm tạm bằng mk_task_list, tối đa 200 việc) -----
  let nguoi: ViecNguoi[] | null = w ? xepViec(w.viec.map((v) => ({ nguoi: v.nguoi, mo: n(v.mo), tre: n(v.tre), gap: n(v.gap) }))) : null;
  let itNhat = false;
  let deXuat = w?.de_xuat ?? null;
  let deXuatSo: number | null = deXuat ? deXuat.reduce((s, d) => s + n(d.so), 0) : null;
  let viecLoi: string | undefined;
  if (!w) {
    const [tl, pl] = await Promise.all([
      thu(() => rpc<{ assignee: string; due: string | null; priority: number }[]>("mk_task_list", { p_agent: AGENT, p_assignee: null, p_created_by: null, p_status: null, p_limit: 200 })),
      thu(() => rpc<unknown[]>("mk_list_proposals", { p_agent: AGENT, p_status: "cho_duyet" })),
    ]);
    if (tl.ok) {
      nguoi = gomViec(tl.v ?? [], homNay);
      itNhat = (tl.v ?? []).length >= 200;
    } else viecLoi = tl.loi;
    if (pl.ok) deXuatSo = (pl.v ?? []).length;
  }

  // ----- Hệ thống -----
  const nguon: Nguon[] = [];
  const them = (ten: string, chuKy: string, lanCuoi: string | null, trePhut: number, loi = false, ghiChu?: string) => {
    const tuoi = tuoiPhut(lanCuoi, now);
    nguon.push({ ten, chuKy, lanCuoi: gioVN(lanCuoi), tinhTrang: loi ? "loi" : tuoi == null ? "chua_co" : tuoi > trePhut ? "tre" : "tot", ghiChu });
  };
  const j = jobs.ok ? jobs.v : null;
  them("Đơn và quảng cáo Shopee", "15 phút một lần", j?.collect.lanCuoiOk ?? null, 45, j?.collect.ok === false, jobs.ok ? undefined : jobs.loi);
  them("Shopee chốt ngày (đơn, tiền về)", "mỗi đêm 01:05–01:10", maxIso([j?.daily_orders.lanCuoiOk, j?.daily_escrow.lanCuoiOk]), 26 * 60, j?.daily_orders.ok === false || j?.daily_escrow.ok === false);
  them("Tồn kho, giá vốn Pancake", "mỗi đêm 01:15", tonLuc.ok ? tonLuc.v ?? null : null, 26 * 60, j?.daily_costs.ok === false);
  them("Quảng cáo Facebook", "mỗi giờ 9h–23h, chốt 07:00", fbLuc, 14 * 60);
  if (w) them("Đơn Pancake (Facebook, TikTok)", "máy anh đẩy mỗi sáng khoảng 07:00", pancakeRun?.lan_cuoi_ok ?? null, 26 * 60, pancakeRun?.ok === false, pancakeRun?.ok === false ? `lần chạy ${gioVN(pancakeRun.lan_cuoi) ?? "gần nhất"} lỗi; đơn mới nhất tạo lúc ${gioVN(w.don_pancake.den) ?? "?"}` : undefined);
  else nguon.push({ ten: "Đơn Pancake (Facebook, TikTok)", chuKy: "máy anh đẩy mỗi sáng khoảng 07:00", lanCuoi: null, tinhTrang: "chua_co", ghiChu: thieuHam ? "chưa đọc được: cần chạy migration 0024" : web.ok ? undefined : web.loi });
  them("Quầy đóng hàng", "khi kho quét", khoLuc, 36 * 60);
  nguon.push({ ten: "Đơn Viettel Post lỗi, hoàn", chuKy: "chưa có", lanCuoi: null, tinhTrang: "chua_co", ghiChu: "chưa có bảng trên Supabase (đang ở file của CSKH)" });
  nguon.push({ ten: "Quảng cáo TikTok", chuKy: "chưa có", lanCuoi: null, tinhTrang: "chua_co", ghiChu: "chưa kết nối" });

  return {
    homNay,
    homQua,
    luc: gioVN(now) as string,
    thieuHam,
    ban: {
      loi: ban.ok ? undefined : ban.loi,
      cot: cotBan,
      soLucShopee: gioVN(collect?.lanCuoiOk),
      soLucPancake: gioVN(w?.don_pancake.den),
      pancakeLoi: pancakeRun?.ok === false,
    },
    qc: { loi: !spAds.ok && !fbAds.ok ? spAds.loi : undefined, ngay: qcNgay, thang: soTran(thangPhan), thangPhan, soLuc: gioVN(maxIso([spLuc, fbLuc])) },
    ton: {
      loi: !hang.ok && !am.ok ? hang.loi : undefined,
      sapHet: hang.ok ? tonSapHet(hang.v ?? []) : null,
      am: am.ok ? amTon(am.v) : null,
      soLuc: gioVN(tonLuc.ok ? tonLuc.v : null),
    },
    don: {
      dongHang: khoDon.ok && khoVideo.ok ? demDaDong(khoDon.v.map((r) => r.ma), khoVideo.v) : null,
      dongHangLoi: khoDon.ok ? (khoVideo.ok ? undefined : khoVideo.loi) : khoDon.loi,
      dongHangLuc: gioVN(khoLuc),
      shopeeChoGui: choGui.ok ? choGui.v : null,
      shopeeLoi: choGui.ok ? undefined : choGui.loi,
      pancakeMo: w ? [...gomMo.values()].sort((a, b) => b.so - a.so) : null,
      pancakeLuc: gioVN(w?.don_pancake.den),
      soLucShopee: gioVN(collect?.lanCuoiOk),
    },
    viec: { loi: viecLoi, nguoi, itNhat, deXuat, deXuatSo, soLuc: gioVN(now) as string },
    heThong: { nguon, loi24h: loi24h.ok ? loi24h.v.map((r) => ({ job: r.job, luc: gioVN(r.started_at) })) : null },
  };
}
