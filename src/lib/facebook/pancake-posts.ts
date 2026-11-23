/**
 * Bài đã đăng của page lấy qua Pancake (API trang, chỉ đọc), dùng khi token Meta không đọc được bài của page đó.
 * Cần biến PANCAKE_PAGE_TOKENS trên máy chủ: JSON {"<page_id>": "<page access token của page trong Pancake>"}.
 * Tài liệu Pancake không ghi trường ảnh của bài; nếu câu trả lời có ảnh thì lấy, không thì bài hiện không ảnh.
 */
import type { PagePost } from "./meta";

const BASE = "https://pages.fm/api/public_api/v1";
const PAGE_SIZE = 30; // mức tối đa Pancake cho phép
const MAX_PAGES = 40;

/** Token từng page; biến thiếu hoặc sai định dạng thì coi như chưa có. Không bao giờ in giá trị ra ngoài. */
export function pancakePageTokens(env: string | undefined = process.env.PANCAKE_PAGE_TOKENS): Map<string, string> {
  const out = new Map<string, string>();
  if (!env?.trim()) return out;
  try {
    const o = JSON.parse(env);
    if (o && typeof o === "object" && !Array.isArray(o)) {
      for (const [k, v] of Object.entries(o)) if (typeof v === "string" && v.trim()) out.set(String(k).trim(), v.trim());
    }
  } catch {
    /* sai định dạng: coi như chưa đặt */
  }
  return out;
}

const IMG_KEYS = ["full_picture", "picture", "thumbnail", "thumbnail_url", "preview_url", "image_url", "src", "url"];
const looksLikeImage = (s: unknown): s is string => typeof s === "string" && /^https:\/\/[^\s]+$/.test(s) && !/\.(mp4|mov|m3u8)(\?|$)/i.test(s);

/** Tìm đường dẫn ảnh đầu tiên trong một bài Pancake (dạng trả về không cố định, nên dò theo tên trường, sâu tối đa 5 tầng). */
export function pickImage(v: unknown, depth = 0): string | null {
  if (!v || typeof v !== "object" || depth > 5) return null;
  if (Array.isArray(v)) {
    for (const x of v) {
      const r = pickImage(x, depth + 1);
      if (r) return r;
    }
    return null;
  }
  const o = v as Record<string, unknown>;
  for (const k of IMG_KEYS) if (looksLikeImage(o[k])) return o[k] as string;
  for (const k of ["attachments", "data", "media", "image", "image_data", "subattachments", "target"]) {
    const r = pickImage(o[k], depth + 1);
    if (r) return r;
  }
  return null;
}

/** Bài Pancake → cùng dạng với bài đọc từ Meta. Giờ của Pancake là UTC, không kèm múi giờ. Bài đã gỡ và ảnh con của album thì bỏ (null). */
export function fromPancakePost(r: any): PagePost | null {
  const id = String(r?.id ?? "");
  if (!id || r?.removed === true) return null;
  // Pancake đếm cả từng ảnh con của album thành một bài (ảnh, không có chữ): bỏ, để số bài khớp với Facebook.
  if (String(r?.type ?? "") === "photo" && !String(r?.message ?? "").trim()) return null;
  const at = String(r?.inserted_at ?? r?.created_time ?? "");
  const created = at && !/(Z|[+-]\d{2}:?\d{2})$/.test(at) ? `${at}Z` : at;
  return {
    id,
    message: String(r?.message ?? ""),
    created_time: created,
    picture: pickImage({ attachments: r?.attachments, image_data: r?.image_data, full_picture: r?.full_picture, picture: r?.picture, thumbnail: r?.thumbnail }),
    permalink: /^\d+_\d+$/.test(id) ? `https://www.facebook.com/${id}` : null,
    kind: String(r?.type ?? ""),
  };
}

/** 00:00 ngày `since` đến hết ngày `until`, giờ Việt Nam, đổi ra giây unix. */
export const vnRangeUnix = (since: string, until: string) => ({
  since: Math.floor(Date.parse(`${since}T00:00:00+07:00`) / 1000),
  until: Math.floor(Date.parse(`${until}T23:59:59+07:00`) / 1000),
});

export async function pancakePosts(pageId: string, token: string, since: string, until: string): Promise<PagePost[]> {
  const t = vnRangeUnix(since, until);
  const out: PagePost[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const q = new URLSearchParams({ page_access_token: token, since: String(t.since), until: String(t.until), page_number: String(page), page_size: String(PAGE_SIZE) });
    const res = await fetch(`${BASE}/pages/${encodeURIComponent(pageId)}/posts?${q}`, { headers: { Accept: "application/json" } });
    // Không đưa URL (có token) vào thông báo lỗi.
    if (!res.ok) throw new Error(`Pancake HTTP ${res.status} (bài, trang ${page})`);
    const body: any = await res.json();
    if (body?.success === false) throw new Error(`Pancake: ${String(body?.message ?? "lỗi").slice(0, 150)}`);
    const rows: any[] = Array.isArray(body?.posts) ? body.posts : [];
    for (const r of rows) {
      const p = fromPancakePost(r);
      if (p) out.push(p);
    }
    if (rows.length < PAGE_SIZE) break;
  }
  return out;
}
