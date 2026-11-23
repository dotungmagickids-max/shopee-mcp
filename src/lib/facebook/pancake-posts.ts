/**
 * Bài đã đăng của page lấy qua Pancake (API trang, chỉ đọc), dùng khi token Meta không đọc được bài của page đó.
 * Dùng chung biến PANCAKE_PAGE_TOKENS trên máy chủ với trang CSKH (src/lib/cskh/pancake-chat.ts).
 * Tài liệu công khai của Pancake không ghi trường ảnh, nhưng bài của Pancake có `attachments.data[].url`
 * (ảnh lưu trên máy chủ Pancake, kể cả ảnh bìa video) và `attachments.target.url` (link bài trên Facebook).
 * Câu trả lời thiếu các trường này thì bài hiện không ảnh.
 */
import { pageTokens } from "../cskh/pancake-chat";
import type { PagePost } from "./meta";

const BASE = "https://pages.fm/api/public_api/v1";
const PAGE_SIZE = 30; // mức tối đa Pancake cho phép
const MAX_PAGES = 40;

/**
 * Token từng page, dùng chung biến PANCAKE_PAGE_TOKENS với trang CSKH (cùng cách đọc: giá trị là chuỗi token
 * hoặc {"ten": ..., "khoa": ...}). Biến thiếu hoặc sai định dạng thì coi như chưa có. Không bao giờ in giá trị ra ngoài.
 */
export function pancakePageTokens(env: string | undefined = process.env.PANCAKE_PAGE_TOKENS): Map<string, string> {
  try {
    return new Map(pageTokens(env).map((p) => [p.id.trim(), p.khoa]));
  } catch {
    return new Map(); // sai định dạng: coi như chưa đặt
  }
}

const IMG_KEYS = ["full_picture", "picture", "thumbnail", "thumbnail_url", "preview_url", "image_url", "src", "url"];
const looksLikeImage = (s: unknown): s is string => typeof s === "string" && /^https:\/\/[^\s]+$/.test(s) && !/\.(mp4|mov|m3u8)(\?|$)/i.test(s) && !/^https:\/\/([a-z0-9-]+\.)?(facebook|fb)\.com\//i.test(s);

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
  for (const k of ["attachments", "data", "media", "image", "image_data", "subattachments"]) {
    const r = pickImage(o[k], depth + 1);
    if (r) return r;
  }
  return null;
}

/** Bài Pancake → cùng dạng với bài đọc từ Meta. Giờ của Pancake là UTC, không kèm múi giờ. Bài đã gỡ và ảnh con của album thì bỏ (null). */
/**
 * Video trên tường page có link dạng /reel/<id>; video Pancake giữ mà không nằm trên tường (tạo riêng cho quảng cáo,
 * tải lên thư viện) có link dạng /<page>/videos/<id>. Bài ảnh trên tường có status_type "added_photos"; bài ảnh
 * ngoài tường có "shared_story". Đối chiếu 23/11/2026 với danh sách bài trên tường của Facebook (page Magic Kids).
 */
export const isOffWall = (type: string, permalink: string | null, statusType = ""): boolean =>
  (type === "video" && !!permalink && /\/videos\//.test(permalink)) || (type === "photo" && statusType === "shared_story");

export function fromPancakePost(r: any): (PagePost & { off_wall: boolean }) | null {
  const id = String(r?.id ?? "");
  if (!id || r?.removed === true || r?.is_removed === true) return null;
  // Pancake đếm cả từng ảnh con của album thành một bài (ảnh, không có chữ): bỏ, để số bài khớp với Facebook.
  if (String(r?.type ?? "") === "photo" && !String(r?.message ?? "").trim()) return null;
  const at = String(r?.inserted_at ?? r?.created_time ?? "");
  const created = at && !/(Z|[+-]\d{2}:?\d{2})$/.test(at) ? `${at}Z` : at;
  const permalink = typeof r?.attachments?.target?.url === "string" ? r.attachments.target.url : /^\d+_\d+$/.test(id) ? `https://www.facebook.com/${id}` : null;
  return {
    id,
    message: String(r?.message ?? ""),
    created_time: created,
    picture: pickImage({ attachments: r?.attachments, image_data: r?.image_data, full_picture: r?.full_picture, picture: r?.picture, thumbnail: r?.thumbnail }),
    permalink,
    kind: String(r?.type ?? ""),
    off_wall: isOffWall(String(r?.type ?? ""), permalink, String(r?.status_type ?? "")),
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
