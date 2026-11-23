/**
 * Quản lý chất lượng CSKH: lưu trên Supabase (migration 0027) và đồng bộ từ Pancake.
 * Chỉ ĐỌC Pancake chat và Pancake POS; chỉ GHI vào các bảng cskh_* của mình.
 * Không lưu tên, SĐT, địa chỉ, nội dung tin của khách.
 */
import { allRows, db } from "../supabase";
import { bamSdt, docHoiThoai, docTin, gioPancake, pageTokens, type HoiThoaiTho, type PageKhoa } from "./pancake-chat";
import { dauNgay, tinhNgay, tomTat, type DonKhop, type HoiThoai, type KetQuaNgay, type Tin } from "./tinh";

const NGAY = 86_400_000;
const POS = "https://pos.pages.fm/api/v1";
const HUY = new Set([6, 7]);
const iso = (ms: number) => new Date(ms).toISOString();
const loi = (e: { message: string } | null) => {
  if (e) throw new Error(e.message);
};
const chia = <T>(xs: T[], n: number): T[][] => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));

export const ngayVN = (ms = Date.now()) => new Date(ms + 7 * 3_600_000).toISOString().slice(0, 10);
export const congNgay = (ngay: string, n: number) => ngayVN(dauNgay(ngay) + n * NGAY + 1);

/* ------------------------------- ghi ------------------------------- */

async function luuHoiThoai(h: HoiThoaiTho): Promise<void> {
  loi(
    (
      await db()
        .from("cskh_hoi_thoai")
        .upsert({ page_id: h.page, id: h.id, loai: h.loai, tao_luc: iso(h.taoLuc), cap_nhat_luc: iso(h.capNhatLuc), the: h.the, co_sdt: h.coSdt, sdt_bam: h.sdtBam, ad_ids: h.adIds, so_tin: h.soTin, dong_bo_luc: iso(Date.now()) })
    ).error,
  );
}

async function luuTin(page: string, hoiThoai: string, tin: Tin[]): Promise<void> {
  for (const lo of chia(tin, 500)) {
    loi((await db().from("cskh_tin").upsert(lo.map((t) => ({ page_id: page, hoi_thoai_id: hoiThoai, id: t.id, luc: iso(t.luc), ben: t.ben, nhan_vien: t.nv ?? null, ky_tu: t.kyTu, loai: t.loai, ma: t.ma ?? [], bam: t.bam ?? null })))).error);
  }
}

export async function luuNgay(k: KetQuaNgay): Promise<void> {
  loi((await db().from("cskh_ngay").upsert({ ngay: k.ngay, du_lieu: k, tom_tat: tomTat(k), tinh_luc: iso(k.tinhLuc) })).error);
}

/* ------------------------------- đọc ------------------------------- */

export async function layNgay(ngay: string): Promise<KetQuaNgay | null> {
  const r = await db().from("cskh_ngay").select("du_lieu").eq("ngay", ngay).maybeSingle();
  loi(r.error);
  return (r.data?.du_lieu as KetQuaNgay) ?? null;
}

export async function layXuHuong(tu: string, den: string): Promise<unknown[]> {
  const r = await db().from("cskh_ngay").select("tom_tat").gte("ngay", tu).lte("ngay", den).order("ngay");
  loi(r.error);
  return (r.data ?? []).map((x: any) => x.tom_tat);
}

/** Mọi hội thoại có tin trong ngày, kèm tin tới hết 2 ngày sau (để thấy câu trả lời muộn), và đơn khớp. */
export async function docNgay(ngay: string): Promise<{ ds: HoiThoai[]; dons: DonKhop[] }> {
  const d0 = dauNgay(ngay);
  const tu = iso(d0);
  const den = iso(d0 + 3 * NGAY);
  const tin = await allRows<any>(() => db().from("cskh_tin").select("page_id,hoi_thoai_id,id,luc,ben,nhan_vien,ky_tu,loai,ma,bam").gte("luc", tu).lt("luc", den).order("luc").order("id"));
  const theo = new Map<string, HoiThoai>();
  const coTrongNgay = new Set<string>();
  for (const r of tin) {
    const k = `${r.page_id}|${r.hoi_thoai_id}`;
    let h = theo.get(k);
    if (!h) theo.set(k, (h = { page: r.page_id, id: r.hoi_thoai_id, loai: "INBOX", taoLuc: 0, the: [], coSdt: false, tin: [] }));
    const luc = Date.parse(r.luc);
    if (luc < d0 + NGAY) coTrongNgay.add(k);
    const t: Tin = { id: r.id, luc, ben: r.ben, kyTu: r.ky_tu ?? 0, loai: r.loai ?? "khac" };
    if (r.nhan_vien) t.nv = r.nhan_vien;
    if (r.ma?.length) t.ma = r.ma;
    if (r.bam) t.bam = r.bam;
    h.tin.push(t);
  }
  const ds = [...theo.entries()].filter(([k]) => coTrongNgay.has(k)).map(([, h]) => h);
  const theoPage = new Map<string, string[]>();
  for (const h of ds) theoPage.set(h.page, [...(theoPage.get(h.page) ?? []), h.id]);
  for (const [page, ids] of theoPage) {
    for (const lo of chia(ids, 200)) {
      const r = await db().from("cskh_hoi_thoai").select("id,loai,tao_luc,the,co_sdt").eq("page_id", page).in("id", lo);
      loi(r.error);
      for (const m of r.data ?? []) {
        const h = theo.get(`${page}|${m.id}`);
        if (h) Object.assign(h, { loai: m.loai ?? "INBOX", taoLuc: Date.parse(m.tao_luc), the: m.the ?? [], coSdt: !!m.co_sdt });
      }
    }
  }
  const don = await allRows<any>(() => db().from("cskh_don_khop").select("ma_don,page_id,hoi_thoai_id,tao_luc,trang_thai").gte("tao_luc", tu).lt("tao_luc", den).order("ma_don"));
  const dons: DonKhop[] = don.filter((d) => !HUY.has(Number(d.trang_thai))).map((d) => ({ page: d.page_id, hoiThoai: d.hoi_thoai_id, ma: d.ma_don, taoLuc: Date.parse(d.tao_luc) }));
  return { ds, dons };
}

/** Tính lại số của một ngày từ dữ liệu đã đồng bộ và lưu bản chụp. */
export async function tinhLaiNgay(ngay: string, now = Date.now()): Promise<KetQuaNgay> {
  const { ds, dons } = await docNgay(ngay);
  const k = tinhNgay(ds, dons, ngay, undefined, now);
  await luuNgay(k);
  return k;
}

/* ------------------------------- đơn POS (chỉ đọc) ------------------------------- */

export interface DonPos {
  ma: string;
  trangThai: number;
  taoLuc: number;
  hoiThoai: string;
  page: string;
  sdtBam: string;
}

/** Chỉ giữ những gì cần để khớp cuộc chat; SĐT được băm ngay, không giữ số. */
export function rutDon(o: any): DonPos | null {
  const ma = String(o?.id ?? "");
  const taoLuc = gioPancake(o?.inserted_at);
  if (!ma || !taoLuc) return null;
  return { ma, trangThai: Number(o?.status ?? 0) || 0, taoLuc, hoiThoai: String(o?.conversation_id ?? ""), page: String(o?.page_id ?? ""), sdtBam: bamSdt(o?.bill_phone_number) };
}

async function docDonPos(tu: number, den: number): Promise<DonPos[]> {
  const key = process.env.PANCAKE_API_KEY?.trim();
  if (!key) throw new Error("Chưa đặt PANCAKE_API_KEY");
  const shop = process.env.PANCAKE_SHOP_ID?.trim() || "608127";
  const out: DonPos[] = [];
  for (let trang = 1; trang <= 50; trang++) {
    const q = new URLSearchParams({ api_key: key, page_size: "200", page_number: String(trang), updateStatus: "inserted_at", startDateTime: String(Math.floor(tu / 1000)), endDateTime: String(Math.ceil(den / 1000)) });
    const res = await fetch(`${POS}/shops/${shop}/orders?${q}`, { method: "GET", headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error(`Pancake POS HTTP ${res.status} (đơn, trang ${trang})`);
    const body: any = await res.json();
    if (body?.success === false) throw new Error(`Pancake POS: ${String(body?.message ?? "lỗi").slice(0, 200)}`);
    for (const o of body?.data ?? []) {
      const d = rutDon(o);
      if (d) out.push(d);
    }
    const tong = Number(body?.total_pages ?? 0);
    if (!body?.data?.length || (tong && trang >= tong)) break;
  }
  return out;
}

/** Mã hội thoại trên đơn POS và trên Pancake chat có thể khác nhau ở tiền tố mã page: thử cả các dạng. */
export function ungVienHoiThoai(hoiThoai: string, page: string): string[] {
  if (!hoiThoai) return [];
  const duoi = hoiThoai.includes("_") ? hoiThoai.slice(hoiThoai.lastIndexOf("_") + 1) : hoiThoai;
  return [...new Set([hoiThoai, duoi, `${page}_${duoi}`])];
}

async function khopDon(dons: DonPos[], pages: Set<string>, tuLuc: number): Promise<number> {
  const rows: any[] = [];
  const conLai: DonPos[] = [];
  for (const d of dons) {
    let ok = false;
    if (d.hoiThoai && pages.has(d.page)) {
      const r = await db().from("cskh_hoi_thoai").select("id").eq("page_id", d.page).in("id", ungVienHoiThoai(d.hoiThoai, d.page)).limit(1);
      loi(r.error);
      if (r.data?.[0]) {
        rows.push({ ma_don: d.ma, page_id: d.page, hoi_thoai_id: r.data[0].id, tao_luc: iso(d.taoLuc), trang_thai: d.trangThai, khop_bang: "hoi_thoai" });
        ok = true;
      }
    }
    if (!ok && d.sdtBam) conLai.push(d);
  }
  for (const lo of chia(conLai, 100)) {
    const r = await db().from("cskh_hoi_thoai").select("page_id,id,sdt_bam").overlaps("sdt_bam", lo.map((d) => d.sdtBam)).gte("cap_nhat_luc", iso(tuLuc)).order("cap_nhat_luc", { ascending: false }).limit(1000);
    loi(r.error);
    for (const d of lo) {
      const h = (r.data ?? []).find((x: any) => (x.sdt_bam ?? []).includes(d.sdtBam));
      if (h) rows.push({ ma_don: d.ma, page_id: h.page_id, hoi_thoai_id: h.id, tao_luc: iso(d.taoLuc), trang_thai: d.trangThai, khop_bang: "sdt" });
    }
  }
  for (const lo of chia(rows, 500)) loi((await db().from("cskh_don_khop").upsert(lo)).error);
  return rows.length;
}

/* ------------------------------- đồng bộ ------------------------------- */

async function dongBoPage(p: PageKhoa, d0: number, hetHan: () => boolean) {
  const ds = await docHoiThoai(p, d0, Date.now());
  const daBiet = new Map<string, number>();
  for (const lo of chia(ds.map((h) => h.id), 200)) {
    const r = await db().from("cskh_hoi_thoai").select("id,cap_nhat_luc").eq("page_id", p.id).in("id", lo);
    loi(r.error);
    for (const x of r.data ?? []) daBiet.set(x.id, Date.parse(x.cap_nhat_luc));
  }
  const can = ds.filter((h) => daBiet.get(h.id) !== h.capNhatLuc);
  let xong = 0;
  // 4 hội thoại một lượt: Pancake giới hạn 5 lệnh mỗi giây cho mỗi page.
  for (const lo of chia(can, 4)) {
    if (hetHan()) break;
    await Promise.all(
      lo.map(async (h) => {
        await luuTin(p.id, h.id, await docTin(p, h.id, d0 - NGAY));
        await luuHoiThoai(h); // ghi sau cùng: lỗi giữa chừng thì lượt sau đọc lại cuộc này
      }),
    );
    xong += lo.length;
  }
  return { page: `…${p.id.slice(-4)}`, ten: p.ten, hoiThoai: ds.length, dongBo: xong, conLai: can.length - xong };
}

/**
 * Đồng bộ một ngày (mặc định hôm nay, giờ Việt Nam). Chạy lại được nhiều lần: cuộc nào đã có và không đổi thì bỏ qua;
 * hết thời gian thì dừng, lượt sau đọc tiếp phần còn lại (`xong: false`).
 */
export async function dongBoCskh(ngay = ngayVN(), hanMs = 240_000) {
  const pages = pageTokens();
  if (!pages.length) throw new Error("Chưa đặt PANCAKE_PAGE_TOKENS");
  const batDau = Date.now();
  const hetHan = () => Date.now() - batDau > hanMs;
  const d0 = dauNgay(ngay);
  const kq = [];
  for (const p of pages) kq.push(await dongBoPage(p, d0, hetHan));
  const don = await khopDon(await docDonPos(d0 - 2 * NGAY, Date.now()), new Set(pages.map((p) => p.id)), d0 - 3 * NGAY);
  // Tính lại cả 2 ngày trước: câu trả lời muộn và đơn chốt trong 48 giờ làm số các ngày đó đổi.
  const hom = ngayVN();
  for (const n of [congNgay(ngay, -2), congNgay(ngay, -1), ngay]) if (n <= hom) await tinhLaiNgay(n);
  return { ngay, pages: kq, donKhop: don, xong: kq.every((x) => x.conLai === 0) };
}

/** Tên hiện trên trang cho từng page (lấy từ cấu hình khóa, không gọi Pancake). */
export function tenPage(): Record<string, string> {
  try {
    return Object.fromEntries(pageTokens().map((p) => [p.id, p.ten]));
  } catch {
    return {};
  }
}
