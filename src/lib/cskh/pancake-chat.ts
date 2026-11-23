/**
 * Đọc chat từ Pancake (pages.fm public API). CHỈ ĐỌC: file này chỉ có lệnh GET, không gửi tin, không gắn thẻ.
 * Mỗi page một khóa riêng, đặt ở biến môi trường PANCAKE_PAGE_TOKENS:
 *   {"<mã page>":"<khóa>"}  hoặc  {"<mã page>":{"ten":"<tên hiện trên trang>","khoa":"<khóa>"}}
 * Tin đọc về được rút gọn ngay: bỏ tên, SĐT, nội dung; chỉ giữ giờ gửi, bên gửi, độ dài, mã hàng nhắc tới, dấu băm.
 */
import { createHash, createHmac } from "node:crypto";
import type { Ben, LoaiTin, Tin } from "./tinh";

const BASE = "https://pages.fm/api/public_api";
const MOI_LUOT = 60;
const TIN_MOI_LUOT = 30;

export interface PageKhoa {
  id: string;
  ten: string;
  khoa: string;
}

export function pageTokens(raw = process.env.PANCAKE_PAGE_TOKENS): PageKhoa[] {
  if (!raw?.trim()) return [];
  let o: unknown;
  try {
    o = JSON.parse(raw);
  } catch {
    throw new Error("PANCAKE_PAGE_TOKENS không phải JSON");
  }
  const out: PageKhoa[] = [];
  for (const [id, v] of Object.entries((o ?? {}) as Record<string, any>)) {
    const khoa = String(typeof v === "string" ? v : (v?.khoa ?? "")).trim();
    if (!/^[\w.-]{1,40}$/.test(id) || !khoa) continue;
    out.push({ id, ten: String((typeof v === "object" && v?.ten) || `Page …${id.slice(-4)}`).slice(0, 60), khoa });
  }
  return out;
}

const cho = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Một lệnh GET tới Pancake. Thông báo lỗi không bao giờ chứa URL (URL có khóa). */
async function lay(duong: string, thamSo: Record<string, string>, nhan: string): Promise<any> {
  const url = `${BASE}${duong}?${new URLSearchParams(thamSo)}`;
  for (let lan = 0; ; lan++) {
    const res = await fetch(url, { method: "GET", headers: { Accept: "application/json" } });
    if (res.status === 429 && lan < 3) {
      await cho(1000 * (lan + 1));
      continue;
    }
    if (!res.ok) throw new Error(`Pancake chat HTTP ${res.status} (${nhan})`);
    const body: any = await res.json();
    if (body?.success === false) throw new Error(`Pancake chat: ${String(body?.message ?? "lỗi").slice(0, 200)} (${nhan})`);
    return body;
  }
}

/** Giờ Pancake trả là UTC, không ghi múi giờ. */
export function gioPancake(s: unknown): number {
  const t = String(s ?? "");
  if (!t) return 0;
  const ms = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(t) ? t : `${t}Z`);
  return Number.isFinite(ms) ? ms : 0;
}

/** SĐT về dạng 0xxxxxxxxx để băm. */
export function chuanSdt(s: unknown): string {
  let d = String(s ?? "").replace(/\D/g, "");
  if (d.startsWith("84") && d.length >= 11) d = `0${d.slice(2)}`;
  return d.length >= 9 && d.length <= 11 ? d : "";
}

/** Băm SĐT với muối bí mật của máy chủ, để khớp đơn POS mà không lưu SĐT. Không có muối thì không băm. */
export function bamSdt(s: unknown, muoi = process.env.CSKH_SALT?.trim() || process.env.JOB_SECRET?.trim() || ""): string {
  const d = chuanSdt(s);
  return d && muoi ? createHmac("sha256", muoi).update(d).digest("hex").slice(0, 32) : "";
}

export interface HoiThoaiTho {
  page: string;
  id: string;
  loai: string;
  taoLuc: number;
  capNhatLuc: number;
  the: string[];
  coSdt: boolean;
  sdtBam: string[];
  adIds: string[];
  soTin: number;
}

export function rutHoiThoai(c: any, page: string): HoiThoaiTho | null {
  const id = String(c?.id ?? "");
  if (!id) return null;
  const sdt: string[] = (Array.isArray(c?.recent_phone_numbers) ? c.recent_phone_numbers : []).map((p: any) => bamSdt(p?.phone_number ?? p)).filter(Boolean);
  return {
    page,
    id,
    loai: String(c?.type ?? "INBOX").toUpperCase(),
    taoLuc: gioPancake(c?.inserted_at),
    capNhatLuc: gioPancake(c?.updated_at),
    the: (Array.isArray(c?.tags) ? c.tags : []).map((t: any) => String(t?.text ?? "").trim()).filter(Boolean).slice(0, 30),
    coSdt: !!c?.has_phone,
    sdtBam: [...new Set(sdt)].slice(0, 5),
    adIds: (Array.isArray(c?.ad_ids) ? c.ad_ids : []).map(String).slice(0, 10),
    soTin: Number(c?.message_count ?? 0) || 0,
  };
}

/** Chỉ xin những trường cần, không xin tên khách. */
const TRUONG = "id,type,inserted_at,updated_at,tags,has_phone,message_count,ad_ids,recent_phone_numbers";

/** Mọi hội thoại của page có hoạt động trong khoảng [tu, den] (mili giây). */
export async function docHoiThoai(p: PageKhoa, tu: number, den: number, toiDaLuot = 60): Promise<HoiThoaiTho[]> {
  const out = new Map<string, HoiThoaiTho>();
  let cuoi = "";
  for (let luot = 0; luot < toiDaLuot; luot++) {
    const q: Record<string, string> = { page_access_token: p.khoa, since: String(Math.floor(tu / 1000)), until: String(Math.ceil(den / 1000)), order_by: "updated_at", fields: TRUONG };
    if (cuoi) q.last_conversation_id = cuoi;
    const body = await lay(`/v2/pages/${encodeURIComponent(p.id)}/conversations`, q, `hội thoại, lượt ${luot + 1}`);
    const ds: any[] = body?.conversations ?? [];
    let them = 0;
    for (const c of ds) {
      const h = rutHoiThoai(c, p.id);
      if (h && !out.has(h.id)) (out.set(h.id, h), them++);
    }
    if (ds.length < MOI_LUOT || !them) break;
    cuoi = String(ds[ds.length - 1]?.id ?? "");
    if (!cuoi) break;
  }
  return [...out.values()];
}

const TU_DONG = /^(pos|botcake|bot|pancake)$/i;
const MA_HANG = /\b[A-Z]{2,4}\d{5}\b/g;
/** Tên gọi nhóm hàng khách hay dùng khi không gõ mã. Lưu dạng "#tên nhóm". */
export const NHOM_HANG = ["set nỉ", "quần nỉ", "quần kaki", "quần gió", "túi hộp", "quần jean", "áo thun", "áo nỉ", "áo khoác", "áo sơ mi", "váy", "đồ bộ"];

export function boThe(s: unknown): string {
  return String(s ?? "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/[​-‏⁠﻿]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function maTrongChu(chu: string): string[] {
  const out = new Set<string>(chu.toUpperCase().match(MA_HANG) ?? []);
  const thuong = chu.toLowerCase();
  for (const n of NHOM_HANG) if (thuong.includes(n)) out.add(`#${n}`);
  return [...out].slice(0, 12);
}

/** Rút gọn một tin của Pancake. Không giữ chữ, tên khách, SĐT. */
export function rutTin(m: any, page: string): Tin | null {
  const id = String(m?.id ?? "");
  const luc = gioPancake(m?.inserted_at);
  if (!id || !luc || m?.is_removed) return null;
  const f = m?.from ?? {};
  const tenNv = String(f.admin_name ?? "").trim();
  const laShop = String(f.id ?? "") === page || !!tenNv || !!f.uid || !!f.is_automated || !!f.ai_generated;
  const ben: Ben = !laShop ? "khach" : f.is_automated || f.ai_generated || !tenNv || TU_DONG.test(tenNv) ? "tu_dong" : "nhan_vien";
  const chu = boThe(m?.original_message ?? m?.message);
  const kieu: string[] = (Array.isArray(m?.attachments) ? m.attachments : []).map((a: any) => String(a?.type ?? "").toLowerCase());
  const loai: LoaiTin = chu ? "chu" : kieu.some((k) => k.includes("sticker")) ? "sticker" : kieu.some((k) => k.includes("photo") || k.includes("image")) ? "anh" : kieu.length ? "khac" : "rong";
  const t: Tin = { id, luc, ben, kyTu: chu.length, loai };
  if (ben === "nhan_vien") t.nv = tenNv.slice(0, 60);
  const ma = chu ? maTrongChu(chu) : [];
  if (ma.length) t.ma = ma;
  // Dấu băm chỉ đặt cho tin của shop đủ dài: dùng để nhận ra tin mẫu, không dùng cho tin của khách.
  if (ben !== "khach" && chu.length >= 20) t.bam = createHash("sha256").update(chu.toLowerCase()).digest("hex").slice(0, 12);
  return t;
}

/** Tin của một hội thoại, lùi dần về trước cho tới khi gặp tin cũ hơn `tu` (mili giây). */
export async function docTin(p: PageKhoa, hoiThoai: string, tu: number, toiDaLuot = 10): Promise<Tin[]> {
  const out = new Map<string, Tin>();
  let daDoc = 0;
  for (let luot = 0; luot < toiDaLuot; luot++) {
    const q: Record<string, string> = { page_access_token: p.khoa };
    if (daDoc) q.current_count = String(daDoc);
    const body = await lay(`/v1/pages/${encodeURIComponent(p.id)}/conversations/${encodeURIComponent(hoiThoai)}/messages`, q, "tin nhắn");
    const ds: any[] = body?.messages ?? [];
    daDoc += ds.length;
    let cuNhat = Infinity;
    for (const m of ds) {
      const t = rutTin(m, p.id);
      if (!t) continue;
      cuNhat = Math.min(cuNhat, t.luc);
      if (t.luc >= tu) out.set(t.id, t);
    }
    if (ds.length < TIN_MOI_LUOT || cuNhat < tu) break;
  }
  return [...out.values()].sort((a, b) => a.luc - b.luc);
}
