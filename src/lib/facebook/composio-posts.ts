/**
 * Bài đã đăng của page lấy qua Composio (công cụ FACEBOOK_GET_PAGE_POSTS, chỉ đọc), dùng khi token hệ thống Meta
 * không đọc được bài của page. Composio đọc bằng kết nối Facebook của người quản trị page nên có cả ảnh đại diện.
 * Cần trên máy chủ: COMPOSIO_API_KEY và COMPOSIO_FB_ACCOUNT (id kết nối Facebook trong Composio);
 * COMPOSIO_USER_ID nếu kết nối thuộc một người dùng cụ thể.
 */
import type { PagePost } from "./meta";

const URL_EXECUTE = "https://backend.composio.dev/api/v3.1/tools/execute/FACEBOOK_GET_PAGE_POSTS";
const FIELDS = "id,message,created_time,permalink_url,full_picture,status_type";
const LIMIT = 100; // công cụ không nhận con trỏ trang, nên chia khoảng ngày cho mỗi lần gọi không quá 100 bài
const WINDOW_DAYS = 30;
const MAX_CALLS = 24;

export type ComposioConfig = { key: string; account: string; userId: string | null };

export function composioConfig(env: Record<string, string | undefined> = process.env): ComposioConfig | null {
  const key = env.COMPOSIO_API_KEY?.trim();
  const account = env.COMPOSIO_FB_ACCOUNT?.trim();
  if (!key || !account) return null;
  return { key, account, userId: env.COMPOSIO_USER_ID?.trim() || null };
}

const shift = (day: string, n: number): string => {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/** Chia [since, until] thành các khoảng liền nhau, mỗi khoảng tối đa `size` ngày, mới nhất trước. */
export function dayWindows(since: string, until: string, size = WINDOW_DAYS): { since: string; until: string }[] {
  const out: { since: string; until: string }[] = [];
  let end = until;
  while (end >= since && out.length < 400) {
    const start = shift(end, -(size - 1));
    out.push({ since: start < since ? since : start, until: end });
    end = shift(start, -1);
  }
  return out;
}

/** Một bài trong câu trả lời của Composio (cùng dạng Graph API) → dạng chung. */
export function fromGraphPost(r: any): PagePost | null {
  const id = String(r?.id ?? "");
  if (!id) return null;
  return {
    id,
    message: String(r?.message ?? ""),
    created_time: String(r?.created_time ?? ""),
    picture: typeof r?.full_picture === "string" ? r.full_picture : null,
    permalink: typeof r?.permalink_url === "string" ? r.permalink_url : null,
    kind: String(r?.status_type ?? ""),
  };
}

/** Lấy mảng bài ra khỏi câu trả lời (có thể lồng data.data). */
export function postsOf(body: any): any[] {
  const d = body?.data;
  if (Array.isArray(d)) return d;
  if (Array.isArray(d?.data)) return d.data;
  if (Array.isArray(d?.data?.data)) return d.data.data;
  return [];
}

const unix = (day: string, end = false) => Math.floor(Date.parse(`${day}T${end ? "23:59:59" : "00:00:00"}+07:00`) / 1000);

async function call(cfg: ComposioConfig, pageId: string, since: string, until: string): Promise<any[]> {
  const res = await fetch(URL_EXECUTE, {
    method: "POST",
    headers: { "x-api-key": cfg.key, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      connected_account_id: cfg.account,
      ...(cfg.userId ? { user_id: cfg.userId } : {}),
      arguments: { page_id: pageId, limit: LIMIT, since: String(unix(since)), until: String(unix(until, true)), fields: FIELDS },
    }),
  });
  const body: any = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`Composio HTTP ${res.status}: ${String(body?.error?.message ?? "lỗi").slice(0, 120)}`);
  if (body?.successful === false) throw new Error(`Composio: ${String(body?.error ?? "lỗi").slice(0, 150)}`);
  return postsOf(body);
}

/** Bài của page trong [since, until] (ngày giờ Việt Nam). Khoảng nào chạm 100 bài thì chia đôi để không sót. */
export async function composioPosts(cfg: ComposioConfig, pageId: string, since: string, until: string): Promise<PagePost[]> {
  const queue = dayWindows(since, until);
  const seen = new Map<string, PagePost>();
  let calls = 0;
  while (queue.length) {
    const w = queue.shift()!;
    if (++calls > MAX_CALLS) throw new Error("Composio: khoảng ngày quá nhiều bài, hãy chọn khoảng ngắn hơn");
    const rows = await call(cfg, pageId, w.since, w.until);
    if (rows.length >= LIMIT && w.since < w.until) {
      const days = Math.round((Date.parse(`${w.until}T00:00:00Z`) - Date.parse(`${w.since}T00:00:00Z`)) / 86_400_000) + 1;
      queue.unshift(...dayWindows(w.since, w.until, Math.max(1, Math.floor(days / 2))));
      continue;
    }
    for (const r of rows) {
      const p = fromGraphPost(r);
      if (p) seen.set(p.id, p);
    }
  }
  return [...seen.values()];
}
