/**
 * FB Magic Tool — Nội dung: đếm và lọc bài đã đăng của từng page (hàm thuần, không gọi mạng, dễ test).
 */
import { codesFromText } from "./launch";

export type ContentKind = "video" | "reel" | "photo" | "other";
export const KIND_LABEL: Record<ContentKind, string> = { video: "Video", reel: "Reel", photo: "Ảnh", other: "Khác" };

export type ContentPost = {
  id: string; // pageId_postId
  page_id: string;
  /** Ngày đăng theo giờ Việt Nam, "YYYY-MM-DD". */
  day: string;
  created_time: string;
  message: string;
  picture: string | null;
  permalink: string | null;
  kind: ContentKind;
  codes: string[];
  /** Bài không nằm trên tường page (chỉ nguồn Pancake nhận ra): thường là video tạo riêng cho quảng cáo. */
  offWall: boolean;
};

export const MAX_RANGE_DAYS = 180;
export const RANGE_PRESETS = [7, 14, 30, 60, 90];

const VN_OFFSET_MS = 7 * 3600 * 1000;
const vnDay = (iso: string): string => {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? new Date(t + VN_OFFSET_MS).toISOString().slice(0, 10) : "";
};
const shift = (day: string, n: number): string => {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const isDay = (s?: string | null): s is string => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));
const diffDays = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

/**
 * Khoảng ngày cần xem. Có `since`/`until` hợp lệ thì dùng (cắt về tối đa MAX_RANGE_DAYS, không vượt hôm nay);
 * không thì lấy `preset` ngày gần nhất tính cả hôm nay (mặc định 30).
 */
export function contentRange(q: { r?: string; since?: string; until?: string }, today: string): { since: string; until: string; preset: string } {
  if (isDay(q.since) && isDay(q.until) && q.since <= q.until) {
    const until = q.until > today ? today : q.until;
    const since = q.since > until ? until : q.since;
    const floor = shift(until, -(MAX_RANGE_DAYS - 1));
    return { since: since < floor ? floor : since, until, preset: "custom" };
  }
  const n = RANGE_PRESETS.includes(Number(q.r)) ? Number(q.r) : 30;
  return { since: shift(today, -(n - 1)), until: today, preset: String(n) };
}

/** Số ngày phải hỏi Meta để phủ hết khoảng (tính từ hôm nay lùi về `since`, dư 1 ngày vì lệch múi giờ). */
export const daysToFetch = (since: string, today: string): number => Math.max(1, diffDays(since, today) + 2);

export function kindOf(statusType: string, permalink: string | null): ContentKind {
  if (permalink && /\/reels?\//i.test(permalink)) return "reel";
  if (/video|live/i.test(statusType)) return "video";
  if (/photo/i.test(statusType)) return "photo";
  return "other";
}

/** Bài thô của Meta → bài hiển thị: gắn page, ngày giờ VN, loại, mã sản phẩm; cắt ngắn nội dung. */
export function toContentPost(
  pageId: string,
  p: { id: string; message: string; created_time: string; picture: string | null; permalink: string | null; kind: string; off_wall?: boolean }
): ContentPost {
  return {
    id: p.id,
    page_id: pageId,
    day: vnDay(p.created_time),
    created_time: p.created_time,
    message: p.message.replace(/\s+/g, " ").trim().slice(0, 220),
    picture: p.picture,
    permalink: p.permalink,
    kind: kindOf(p.kind, p.permalink),
    codes: codesFromText(p.message),
    offWall: p.off_wall === true,
  };
}

export const inRange = (p: ContentPost, since: string, until: string) => p.day >= since && p.day <= until;

/** `scope`: "wall" (mặc định) chỉ lấy bài trên tường page; "off" chỉ lấy bài ngoài tường. */
export type ContentFilter = { page?: string; code?: string; kind?: ContentKind | ""; noCode?: boolean; scope?: "wall" | "off" };

/** Chuẩn hóa ô nhập mã: bỏ dấu cách, viết hoa. Gõ một phần mã ("ADT26") vẫn khớp. */
export const normCode = (s: string | undefined) => String(s ?? "").replace(/\s+/g, "").toUpperCase();

export function matches(p: ContentPost, f: ContentFilter): boolean {
  if ((f.scope === "off") !== p.offWall) return false;
  if (f.page && p.page_id !== f.page) return false;
  if (f.kind && p.kind !== f.kind) return false;
  if (f.noCode) return p.codes.length === 0;
  const code = normCode(f.code);
  if (code && !p.codes.some((c) => c.includes(code))) return false;
  return true;
}

export type PageCount = { page_id: string; total: number; video: number; photo: number; noCode: number; lastDay: string | null };

/** Đếm bài theo page (page không có bài vẫn có dòng, số 0). Video gồm cả reel. */
export function countByPage(posts: ContentPost[], pageIds: string[]): PageCount[] {
  const m = new Map<string, PageCount>(pageIds.map((id) => [id, { page_id: id, total: 0, video: 0, photo: 0, noCode: 0, lastDay: null }]));
  for (const p of posts) {
    const c = m.get(p.page_id);
    if (!c) continue;
    c.total += 1;
    if (p.kind === "video" || p.kind === "reel") c.video += 1;
    else if (p.kind === "photo") c.photo += 1;
    if (!p.codes.length) c.noCode += 1;
    if (!c.lastDay || p.day > c.lastDay) c.lastDay = p.day;
  }
  return [...m.values()];
}

/** Số bài theo mã sản phẩm, nhiều nhất trước. Bài có 2 mã được đếm cho cả hai. */
export function countByCode(posts: ContentPost[]): { code: string; posts: number }[] {
  const m = new Map<string, number>();
  for (const p of posts) for (const c of p.codes) m.set(c, (m.get(c) ?? 0) + 1);
  return [...m.entries()].map(([code, n]) => ({ code, posts: n })).sort((a, b) => b.posts - a.posts || a.code.localeCompare(b.code));
}
