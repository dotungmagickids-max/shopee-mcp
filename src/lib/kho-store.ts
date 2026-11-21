import { normSku } from "./autopilot/pancake";
import { allRows, db } from "./supabase";

/**
 * Dữ liệu vận hành của phần mềm quay đóng hàng trên Supabase (migration 0022):
 * danh sách đơn cần đóng theo ngày, ghi chú soát đơn, tình trạng kiện hoàn, sổ video.
 * Không lưu video. Mục đích: xem kết quả của máy kho từ xa, và để AI nhập đơn cần đóng theo lệnh anh Tùng.
 */

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const CODE = /^[A-Z0-9_-]{4,40}$/;
const KEY = /^[\w.:+@ -]{1,200}$/;

export const validDay = (s: unknown): s is string => typeof s === "string" && DAY.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));
export const validKey = (s: unknown): s is string => typeof s === "string" && KEY.test(s);

/** Lọc và chuẩn hóa mã đơn: viết hoa, bỏ khoảng trắng, bỏ trùng, bỏ thứ không phải mã. */
export function cleanCodes(v: unknown, max = 3000): string[] {
  if (!Array.isArray(v)) return [];
  const out = new Set<string>();
  for (const x of v) {
    const c = normSku(x == null ? "" : String(x));
    if (CODE.test(c)) out.add(c);
    if (out.size >= max) break;
  }
  return [...out];
}

const NOTE_FIELDS = ["lyDo", "xuLy", "state", "note"] as const;
/** Chỉ giữ các trường ghi chú đã biết, cắt 500 ký tự. */
export function cleanNote(v: any): Record<string, string> {
  const o: Record<string, string> = {};
  for (const k of NOTE_FIELDS) if (v && v[k] != null) o[k] = String(v[k]).slice(0, 500);
  return o;
}

const str = (x: unknown, n: number) => (x == null ? "" : String(x).slice(0, n));
const num = (x: unknown) => (Number.isFinite(Number(x)) ? Number(x) : 0);

/**
 * Tình trạng một kiện hoàn: ngoài ghi chú còn giữ sản phẩm đã quét lúc mở kiện (items), sản phẩm của đơn (need),
 * các mã của kiện (codes, code) và dấu "video đã tự xóa" (gone). Không có tên, SĐT, địa chỉ khách.
 */
export function cleanMark(v: any): Record<string, unknown> {
  const o: Record<string, unknown> = cleanNote(v);
  if (Array.isArray(v?.items)) o.items = v.items.slice(0, 100).map((u: any) => ({ code: normSku(str(u?.code, 60)), name: str(u?.name, 200), ok: !!u?.ok, at: num(u?.at) })).filter((u: any) => u.code);
  if (Array.isArray(v?.need)) o.need = v.need.slice(0, 100).map((u: any) => ({ sku: normSku(str(u?.sku, 60)), name: str(u?.name, 200), quantity: Math.min(999, Math.max(1, Math.round(num(u?.quantity)) || 1)) })).filter((u: any) => u.sku);
  if (Array.isArray(v?.codes)) o.codes = v.codes.slice(0, 10).map((x: unknown) => normSku(str(x, 60))).filter(Boolean);
  if (v?.code != null) o.code = normSku(str(v.code, 60));
  if (num(v?.gone) > 0) o.gone = num(v.gone);
  return o;
}

export interface NhapHoan {
  id: string;
  sku: string;
  code: string;
  qty: number;
  kind: "nhap" | "bo";
  note: string;
  at: number;
  may: string;
}

/** Một lượt nhập hàng hoàn vào kho (kind "bo": ghi "không nhập"). qty âm là lượt hủy. null nếu thiếu mã hoặc số lượng. */
export function nhapEntry(v: any): NhapHoan | null {
  const id = str(v?.id, 80);
  const sku = normSku(str(v?.sku, 60));
  const qty = Math.round(num(v?.qty));
  if (!/^[\w.-]{6,80}$/.test(id) || !sku || !qty || Math.abs(qty) > 999) return null;
  return { id, sku, code: normSku(str(v?.code, 60)), qty, kind: v?.kind === "bo" ? "bo" : "nhap", note: str(v?.note, 200), at: num(v?.at) || Date.now(), may: str(v?.may, 40) };
}

export interface VideoRow {
  file: string;
  ma: string;
  ma_don: string | null;
  so_don: string | null;
  che_do: string;
  bat_dau: string;
  giay: number | null;
  kich_thuoc: number | null;
  soat: string | null;
  kenh: string | null;
  loai_ma: string | null;
  may: string | null;
  da_xoa: boolean;
  cap_nhat: string;
}

/** Một dòng sổ video từ máy kho → dòng bảng kho_video. null nếu thiếu tên file, mã hoặc giờ quay. */
export function videoRow(v: any, may: string, now: Date): VideoRow | null {
  const file = String(v?.fileName ?? v?.file ?? "");
  const ma = normSku(v?.code ?? v?.ma ?? "");
  const t = Number(v?.startedAt);
  if (!/^[\w.-]{5,160}\.mp4$/i.test(file) || !ma || !Number.isFinite(t) || t <= 0) return null;
  const s = (x: unknown, n: number) => (x == null || x === "" ? null : String(x).slice(0, n));
  return {
    file,
    ma: ma.slice(0, 60),
    ma_don: s(v?.orderId, 60),
    so_don: s(v?.sysId, 30),
    che_do: v?.mode === "HH" ? "HH" : "DH",
    bat_dau: new Date(t).toISOString(),
    giay: Number.isFinite(Number(v?.durationSec)) ? Number(v.durationSec) : null,
    kich_thuoc: Number.isFinite(Number(v?.size)) ? Math.round(Number(v.size)) : null,
    soat: s(v?.check, 120),
    kenh: s(v?.source, 60),
    loai_ma: s(v?.type, 60),
    may: s(may, 40),
    da_xoa: !!v?.del,
    cap_nhat: now.toISOString(),
  };
}

const fail = (what: string, error: { message: string } | null) => {
  if (error) throw new Error(`${what}: ${error.message}`);
};

export interface DayDoc {
  ngay: string;
  codes: string[];
  notes: Record<string, Record<string, string>>;
  resetAt: number;
  updatedAt: number;
}

export async function dayGet(ngay: string): Promise<DayDoc> {
  const [codes, notes, reset] = await Promise.all([
    db().from("kho_don").select("ma, tao_luc").eq("ngay", ngay).order("tao_luc").order("ma").limit(5000),
    db().from("kho_ghi_chu").select("khoa, du_lieu, cap_nhat").eq("pham_vi", `soat:${ngay}`).limit(5000),
    db().from("kho_ghi_chu").select("du_lieu").eq("pham_vi", "ngay-reset").eq("khoa", ngay).maybeSingle(),
  ]);
  fail("kho_don", codes.error);
  fail("kho_ghi_chu", notes.error);
  fail("kho_ghi_chu", reset.error);
  let updatedAt = 0;
  const outNotes: DayDoc["notes"] = {};
  for (const r of notes.data ?? []) {
    outNotes[r.khoa] = r.du_lieu ?? {};
    updatedAt = Math.max(updatedAt, Date.parse(r.cap_nhat) || 0);
  }
  for (const r of codes.data ?? []) updatedAt = Math.max(updatedAt, Date.parse(r.tao_luc) || 0);
  const resetAt = Number((reset.data?.du_lieu as any)?.at) || 0;
  return { ngay, codes: (codes.data ?? []).map((r) => r.ma), notes: outNotes, resetAt, updatedAt: Math.max(updatedAt, resetAt) };
}

async function notesMerge(phamVi: string, notes: Record<string, unknown>, clean: (v: any) => Record<string, unknown> = cleanNote): Promise<void> {
  const keys = Object.keys(notes).filter(validKey).slice(0, 500);
  if (!keys.length) return;
  const cur = await db().from("kho_ghi_chu").select("khoa, du_lieu").eq("pham_vi", phamVi).in("khoa", keys);
  fail("kho_ghi_chu", cur.error);
  const old = new Map((cur.data ?? []).map((r) => [r.khoa, r.du_lieu ?? {}]));
  const now = new Date().toISOString();
  const rows = keys.map((k) => ({ pham_vi: phamVi, khoa: k, du_lieu: { ...(old.get(k) as object), ...clean(notes[k]), at: Date.now() }, cap_nhat: now }));
  fail("kho_ghi_chu", (await db().from("kho_ghi_chu").upsert(rows)).error);
}

/**
 * Sửa danh sách và ghi chú của một ngày.
 *   add: thêm mã (bỏ qua mã đã có).   set: thay toàn bộ danh sách (đánh dấu resetAt để các máy khác bỏ bản cũ).
 *   clearNotes: xóa mọi ghi chú của ngày.   notes: gộp ghi chú theo từng mã.
 */
export async function dayWrite(ngay: string, body: { add?: unknown; set?: unknown; notes?: unknown; clearNotes?: unknown; nguon?: unknown }): Promise<DayDoc> {
  const nguon = String(body.nguon ?? "").slice(0, 40) || null;
  if (Array.isArray(body.set)) {
    const codes = cleanCodes(body.set);
    fail("kho_don", (await db().from("kho_don").delete().eq("ngay", ngay)).error);
    if (codes.length) fail("kho_don", (await db().from("kho_don").insert(codes.map((ma) => ({ ngay, ma, nguon })))).error);
    fail("kho_ghi_chu", (await db().from("kho_ghi_chu").upsert({ pham_vi: "ngay-reset", khoa: ngay, du_lieu: { at: Date.now() }, cap_nhat: new Date().toISOString() })).error);
  } else {
    const codes = cleanCodes(body.add);
    if (codes.length) fail("kho_don", (await db().from("kho_don").upsert(codes.map((ma) => ({ ngay, ma, nguon })), { onConflict: "ngay,ma", ignoreDuplicates: true })).error);
  }
  if (body.clearNotes) fail("kho_ghi_chu", (await db().from("kho_ghi_chu").delete().eq("pham_vi", `soat:${ngay}`)).error);
  if (body.notes && typeof body.notes === "object") await notesMerge(`soat:${ngay}`, body.notes as Record<string, unknown>);
  return dayGet(ngay);
}

/** Tình trạng kiện hoàn (đúng đủ / thiếu / lỗi / sai, ghi chú) của 90 ngày gần nhất. */
export async function marksGet(): Promise<{ marks: Record<string, Record<string, unknown>> }> {
  const since = new Date(Date.now() - 90 * 86400_000).toISOString();
  const rows = await allRows<{ khoa: string; du_lieu: Record<string, unknown> }>(() => db().from("kho_ghi_chu").select("khoa, du_lieu").eq("pham_vi", "hoan").gte("cap_nhat", since).order("khoa"));
  return { marks: Object.fromEntries(rows.map((r) => [r.khoa, r.du_lieu ?? {}])) };
}

export async function markSet(khoa: string, duLieu: unknown): Promise<void> {
  await notesMerge("hoan", { [khoa]: duLieu }, cleanMark);
}

/** Sổ nhập hàng hoàn: mỗi lượt một dòng, chỉ thêm, không sửa (lượt hủy là một dòng số âm). Dòng đã có thì bỏ qua. */
export async function nhapAdd(rows: unknown): Promise<{ saved: number; skipped: number }> {
  const list = Array.isArray(rows) ? rows.slice(0, 500) : [];
  const good = new Map<string, NhapHoan>();
  for (const v of list) {
    const e = nhapEntry(v);
    if (e) good.set(e.id, e);
  }
  if (good.size) {
    const now = new Date().toISOString();
    const up = [...good.values()].map(({ id, ...d }) => ({ pham_vi: "nhap-hoan", khoa: id, du_lieu: d, cap_nhat: now }));
    fail("kho_ghi_chu", (await db().from("kho_ghi_chu").upsert(up, { onConflict: "pham_vi,khoa", ignoreDuplicates: true })).error);
  }
  return { saved: good.size, skipped: list.length - good.size };
}

/** Các lượt nhập hàng hoàn của 180 ngày gần nhất. */
export async function nhapList(): Promise<{ entries: NhapHoan[] }> {
  const since = new Date(Date.now() - 180 * 86400_000).toISOString();
  const rows = await allRows<{ khoa: string; du_lieu: Omit<NhapHoan, "id"> }>(() => db().from("kho_ghi_chu").select("khoa, du_lieu").eq("pham_vi", "nhap-hoan").gte("cap_nhat", since).order("khoa"));
  return { entries: rows.map((r) => ({ id: r.khoa, ...r.du_lieu })) };
}

export async function videoUpsert(rows: unknown, may: unknown): Promise<{ saved: number; skipped: number }> {
  const list = Array.isArray(rows) ? rows.slice(0, 500) : [];
  const now = new Date();
  const good = new Map<string, VideoRow>();
  for (const v of list) {
    const r = videoRow(v, String(may ?? ""), now);
    if (r) good.set(r.file, r);
  }
  if (good.size) fail("kho_video", (await db().from("kho_video").upsert([...good.values()])).error);
  return { saved: good.size, skipped: list.length - good.size };
}

export async function videoList(days: number): Promise<{ rows: VideoRow[] }> {
  const since = new Date(Date.now() - Math.min(90, Math.max(1, days)) * 86400_000).toISOString();
  const rows = await allRows<VideoRow>(() => db().from("kho_video").select("*").eq("da_xoa", false).gte("bat_dau", since).order("bat_dau", { ascending: false }).order("file"));
  return { rows };
}

/* Danh sách đơn Viettel Post đang hoàn, lấy từ mail "Báo cáo vận hành" hằng ngày của Viettel Post. */

export interface VtpMailDoc {
  status: string;
  reason: string;
  ngay: string;
  first: number;
  id?: string;
  channel?: string;
  kind?: string;
  codes?: string[];
  items?: Array<{ sku: string; name: string; detail: string; quantity: number }>;
}

/** Dòng từ báo cáo mail → { mã, trạng thái, lý do }. Bỏ dòng không phải mã, bỏ trùng (giữ dòng đầu). */
export function cleanVtpRows(v: unknown, max = 300): Array<{ ma: string; status: string; reason: string }> {
  if (!Array.isArray(v)) return [];
  const out = new Map<string, { ma: string; status: string; reason: string }>();
  for (const x of v) {
    const ma = normSku(x?.ma == null ? "" : String(x.ma));
    if (!CODE.test(ma) || out.has(ma)) continue;
    out.set(ma, { ma, status: String(x?.status ?? x?.trang_thai ?? "").trim().slice(0, 80), reason: String(x?.reason ?? x?.ly_do ?? "").trim().slice(0, 200) });
    if (out.size >= max) break;
  }
  return [...out.values()];
}

/** Các đơn hoàn Viettel đã lưu (45 ngày kể từ lần cuối có trong báo cáo) và ngày báo cáo mới nhất đã nhận. */
export async function vtpMailGet(): Promise<{ docs: Record<string, VtpMailDoc>; last: { ngay: string; at: number; n: number } | null }> {
  const since = new Date(Date.now() - 45 * 86400_000).toISOString();
  const [rows, meta] = await Promise.all([
    allRows<{ khoa: string; du_lieu: VtpMailDoc }>(() => db().from("kho_ghi_chu").select("khoa, du_lieu").eq("pham_vi", "hoan-vtp").gte("cap_nhat", since).order("khoa")),
    db().from("kho_ghi_chu").select("du_lieu").eq("pham_vi", "hoan-vtp-meta").eq("khoa", "last").maybeSingle(),
  ]);
  fail("kho_ghi_chu", meta.error);
  const m = meta.data?.du_lieu as any;
  return { docs: Object.fromEntries(rows.map((r) => [r.khoa, r.du_lieu])), last: m?.ngay ? { ngay: String(m.ngay), at: Number(m.at) || 0, n: Number(m.n) || 0 } : null };
}

export async function vtpMailSave(ngay: string, docs: Record<string, VtpMailDoc>): Promise<void> {
  await cacheDrop("hoan");
  const now = new Date().toISOString();
  const rows = Object.entries(docs).map(([khoa, du_lieu]) => ({ pham_vi: "hoan-vtp", khoa, du_lieu, cap_nhat: now }));
  if (rows.length) fail("kho_ghi_chu", (await db().from("kho_ghi_chu").upsert(rows)).error);
  fail("kho_ghi_chu", (await db().from("kho_ghi_chu").upsert({ pham_vi: "hoan-vtp-meta", khoa: "last", du_lieu: { ngay, at: Date.now(), n: rows.length }, cap_nhat: now })).error);
}

/* Bộ nhớ đệm cho các lời gọi chậm (hàng hoàn ~1 phút, danh mục sản phẩm ~6 giây): lưu kết quả vào kho_ghi_chu. */

/** Bản đã lưu còn dùng được không: có giờ lưu, chưa quá hạn, không nằm ở tương lai. */
export function cacheFresh(at: unknown, ttlMs: number, now: number): boolean {
  const t = Number(at);
  return Number.isFinite(t) && t > 0 && t <= now && now - t < ttlMs;
}

/**
 * Trả bản đã lưu nếu còn hạn; không thì chạy fn, lưu lại rồi trả. Lỗi đọc/ghi bộ nhớ đệm không làm hỏng lời gọi.
 * keep: chỉ lưu kết quả đạt (ví dụ không có lỗi nguồn).  force: bỏ qua bản đã lưu.
 */
export async function cached<T>(key: string, ttlMs: number, fn: () => Promise<T>, keep: (v: T) => boolean = () => true, force = false): Promise<T> {
  if (!force) {
    try {
      const r = await db().from("kho_ghi_chu").select("du_lieu").eq("pham_vi", "cache").eq("khoa", key).maybeSingle();
      const d = r.data?.du_lieu as any;
      if (!r.error && d && cacheFresh(d.at, ttlMs, Date.now())) return d.v as T;
    } catch {
      /* đọc không được thì tính lại */
    }
  }
  const v = await fn();
  if (keep(v)) {
    try {
      await db().from("kho_ghi_chu").upsert({ pham_vi: "cache", khoa: key, du_lieu: { at: Date.now(), v }, cap_nhat: new Date().toISOString() });
    } catch {
      /* ghi không được thì lần sau tính lại */
    }
  }
  return v;
}

export async function cacheDrop(key: string): Promise<void> {
  try {
    await db().from("kho_ghi_chu").delete().eq("pham_vi", "cache").eq("khoa", key);
  } catch {
    /* bỏ qua */
  }
}
