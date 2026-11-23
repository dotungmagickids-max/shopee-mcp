/**
 * FB Magic Tool — Nội dung: đọc bài đã đăng của mọi page Magickids trong một khoảng ngày. Chỉ đọc.
 * Page nào không đọc được (token chưa có quyền page) thì báo riêng page đó, các page khác vẫn hiện.
 */
import { inRange, toContentPost, daysToFetch, type ContentPost } from "./content";
import { PAGES } from "./magic-data";
import { pagePosts, scrub } from "./meta";

export type ContentData = { posts: ContentPost[]; pages: { id: string; name: string; error: string | null }[] };

export async function loadContent(since: string, until: string, today: string): Promise<ContentData> {
  const days = daysToFetch(since, today);
  const results = await Promise.all(
    Object.entries(PAGES).map(async ([id, name]) => {
      try {
        const posts = (await pagePosts(id, days)).map((p) => toContentPost(id, p)).filter((p) => inRange(p, since, until));
        return { id, name, error: null as string | null, posts };
      } catch (e) {
        return { id, name, error: scrub(e instanceof Error ? e.message : String(e)).slice(0, 200), posts: [] as ContentPost[] };
      }
    })
  );
  const posts = results.flatMap((r) => r.posts).sort((a, b) => b.created_time.localeCompare(a.created_time));
  return { posts, pages: results.map(({ id, name, error }) => ({ id, name, error })) };
}
