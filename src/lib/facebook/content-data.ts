/**
 * FB Magic Tool — Nội dung: đọc bài đã đăng của mọi page Magickids trong một khoảng ngày. Chỉ đọc.
 * Mỗi page thử lần lượt: Meta (token hệ thống) → Composio (kết nối Facebook của quản trị page, có ảnh)
 * → Pancake (không chắc có ảnh). Nguồn nào chưa cấu hình thì bỏ qua. Không nguồn nào được thì báo riêng
 * page đó, các page khác vẫn hiện.
 */
import { composioConfig, composioPosts } from "./composio-posts";
import { inRange, toContentPost, daysToFetch, type ContentPost } from "./content";
import { PAGES } from "./magic-data";
import { pagePosts, scrub, type PagePost } from "./meta";
import { pancakePageTokens, pancakePosts } from "./pancake-posts";

export type ContentSource = "meta" | "composio" | "pancake";
export type ContentPage = { id: string; name: string; source: ContentSource | null; error: string | null };
export type ContentData = { posts: ContentPost[]; pages: ContentPage[] };

const msg = (e: unknown) => scrub(e instanceof Error ? e.message : String(e)).slice(0, 160);

export async function loadContent(since: string, until: string, today: string): Promise<ContentData> {
  const days = daysToFetch(since, today);
  const tokens = pancakePageTokens();
  const composio = composioConfig();
  const results = await Promise.all(
    Object.entries(PAGES).map(async ([id, name]) => {
      const sources: [ContentSource, () => Promise<PagePost[]>][] = [["meta", () => pagePosts(id, days)]];
      if (composio) sources.push(["composio", () => composioPosts(composio, id, since, until)]);
      const token = tokens.get(id);
      if (token) sources.push(["pancake", () => pancakePosts(id, token, since, until)]);
      const errors: string[] = [];
      for (const [source, read] of sources) {
        try {
          const posts = (await read()).map((p) => toContentPost(id, p)).filter((p) => inRange(p, since, until));
          return { id, name, source: source as ContentSource | null, error: null as string | null, posts };
        } catch (e) {
          errors.push(`${source}: ${msg(e)}`);
        }
      }
      if (sources.length === 1) errors.push("chưa cấu hình Composio hay Pancake cho page này");
      return { id, name, source: null, error: errors.join("; "), posts: [] as ContentPost[] };
    })
  );
  const posts = results.flatMap((r) => r.posts).sort((a, b) => b.created_time.localeCompare(a.created_time));
  return { posts, pages: results.map(({ id, name, source, error }) => ({ id, name, source, error })) };
}
