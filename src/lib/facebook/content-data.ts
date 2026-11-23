/**
 * FB Magic Tool — Nội dung: đọc bài đã đăng của mọi page Magickids trong một khoảng ngày. Chỉ đọc.
 * Mỗi page: đọc bằng Meta trước; Meta không đọc được (token chưa có quyền page) thì lấy qua Pancake nếu đã có
 * token Pancake của page đó. Cả hai đều không được thì báo riêng page đó, các page khác vẫn hiện.
 */
import { inRange, toContentPost, daysToFetch, type ContentPost } from "./content";
import { PAGES } from "./magic-data";
import { pagePosts, scrub } from "./meta";
import { pancakePageTokens, pancakePosts } from "./pancake-posts";

export type ContentSource = "meta" | "pancake";
export type ContentPage = { id: string; name: string; source: ContentSource | null; error: string | null };
export type ContentData = { posts: ContentPost[]; pages: ContentPage[] };

const msg = (e: unknown) => scrub(e instanceof Error ? e.message : String(e)).slice(0, 160);

export async function loadContent(since: string, until: string, today: string): Promise<ContentData> {
  const days = daysToFetch(since, today);
  const tokens = pancakePageTokens();
  const results = await Promise.all(
    Object.entries(PAGES).map(async ([id, name]) => {
      const keep = (raw: Awaited<ReturnType<typeof pagePosts>>) => raw.map((p) => toContentPost(id, p)).filter((p) => inRange(p, since, until));
      let metaError: string;
      try {
        return { id, name, source: "meta" as ContentSource | null, error: null as string | null, posts: keep(await pagePosts(id, days)) };
      } catch (e) {
        metaError = msg(e);
      }
      const token = tokens.get(id);
      if (!token) return { id, name, source: null, error: `Meta: ${metaError}. Chưa có token Pancake của page này.`, posts: [] as ContentPost[] };
      try {
        return { id, name, source: "pancake" as ContentSource | null, error: null, posts: keep(await pancakePosts(id, token, since, until)) };
      } catch (e) {
        return { id, name, source: null, error: `Meta: ${metaError}. ${msg(e)}`, posts: [] as ContentPost[] };
      }
    })
  );
  const posts = results.flatMap((r) => r.posts).sort((a, b) => b.created_time.localeCompare(a.created_time));
  return { posts, pages: results.map(({ id, name, source, error }) => ({ id, name, source, error })) };
}
