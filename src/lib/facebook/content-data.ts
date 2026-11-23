/**
 * FB Magic Tool — Nội dung: đọc bài đã đăng của mọi page Magickids trong một khoảng ngày. Chỉ đọc.
 * Mỗi page thử lần lượt: Pancake (nguồn chính, anh chốt 23/11/2026; cần token trang của page) → Meta (token hệ thống)
 * → Composio (kết nối Facebook của quản trị page). Nguồn nào chưa cấu hình thì bỏ qua. Không nguồn nào được thì
 * báo riêng page đó, các page khác vẫn hiện.
 */
import { composioConfig, composioPosts } from "./composio-posts";
import { addDays } from "../autopilot/time";
import { db } from "../supabase";
import { adsByPost, enrich, inRange, toContentPost, daysToFetch, type ContentPost, type PostAds } from "./content";
import { PAGES } from "./magic-data";
import { adsInfo, pagePosts, scrub, type PagePost } from "./meta";
import { pancakePageTokens, pancakePosts } from "./pancake-posts";

export type ContentSource = "meta" | "composio" | "pancake";
export type ContentPage = { id: string; name: string; source: ContentSource | null; error: string | null };
export type ContentData = { posts: ContentPost[]; pages: ContentPage[]; notes: string[] };

const ADS_DAYS = 7;

/** Quảng cáo có chi tiền trong 7 ngày gần nhất (fb_ad_daily), gom theo bài gốc kèm trạng thái hiện tại trên Meta. Chỉ đọc. */
async function loadPostAds(today: string): Promise<Map<string, PostAds>> {
  const { data, error } = await db()
    .from("fb_ad_daily")
    .select("ad_id, ad_name, ngay")
    .gte("ngay", addDays(today, -(ADS_DAYS - 1)))
    .gt("spend", 0)
    .order("ngay", { ascending: false })
    .limit(5000);
  if (error) throw new Error(`fb_ad_daily: ${error.message}`);
  const seen = new Map<string, { ad_id: string; ad_name: string | null }>();
  for (const r of data ?? []) if (!seen.has(r.ad_id)) seen.set(r.ad_id, { ad_id: r.ad_id, ad_name: r.ad_name });
  if (!seen.size) return new Map();
  return adsByPost([...seen.values()], await adsInfo([...seen.keys()]));
}

/** Mã anh nhập tay cho từng bài (bảng fb_post_codes). Chưa áp migration thì coi như chưa có dòng nào. */
export async function loadManualCodes(): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  const { data, error } = await db().from("fb_post_codes").select("post_id, codes").limit(5000);
  if (error) throw new Error("chưa có bảng fb_post_codes (chưa áp migration)");
  for (const r of data ?? []) out.set(String(r.post_id), Array.isArray(r.codes) ? r.codes.map(String) : []);
  return out;
}

const msg = (e: unknown) => scrub(e instanceof Error ? e.message : String(e)).slice(0, 160);

/**
 * Bài của MỘT page trong [since, until], thử lần lượt Pancake → Meta → Composio. Dùng chung cho màn Bài đã đăng và
 * màn Lên camp. Không nguồn nào đọc được thì `source` = null và `error` ghi lý do từng nguồn.
 */
export async function readPagePosts(
  id: string,
  since: string,
  until: string,
  days: number
): Promise<{ source: ContentSource | null; error: string | null; posts: (PagePost & { off_wall?: boolean })[] }> {
  const composio = composioConfig();
  const token = pancakePageTokens().get(id);
  const sources: [ContentSource, () => Promise<PagePost[]>][] = [];
  if (token) sources.push(["pancake", () => pancakePosts(id, token, since, until)]);
  sources.push(["meta", () => pagePosts(id, days)]);
  if (composio) sources.push(["composio", () => composioPosts(composio, id, since, until)]);
  const errors: string[] = [];
  for (const [source, read] of sources) {
    try {
      return { source, error: null, posts: await read() };
    } catch (e) {
      errors.push(`${source}: ${msg(e)}`);
    }
  }
  if (!token) errors.push("chưa có token Pancake của page này");
  return { source: null, error: errors.join("; "), posts: [] };
}

export async function loadContent(since: string, until: string, today: string): Promise<ContentData> {
  const days = daysToFetch(since, today);
  const results = await Promise.all(
    Object.entries(PAGES).map(async ([id, name]) => {
      const r = await readPagePosts(id, since, until, days);
      const posts = r.posts.map((p) => toContentPost(id, p)).filter((p) => inRange(p, since, until));
      return { id, name, source: r.source, error: r.error, posts };
    })
  );
  const notes: string[] = [];
  const soft = <T,>(label: string, empty: T) => (e: unknown): T => {
    notes.push(`${label}: ${msg(e)}`);
    return empty;
  };
  const [ads, manual] = await Promise.all([
    loadPostAds(today).catch(soft("Chưa đọc được quảng cáo đang chạy", new Map<string, PostAds>())),
    loadManualCodes().catch(soft("Chưa sửa được mã cho bài", new Map<string, string[]>())),
  ]);
  const posts = enrich(results.flatMap((r) => r.posts), ads, manual).sort((a, b) => b.created_time.localeCompare(a.created_time));
  return { posts, pages: results.map(({ id, name, source, error }) => ({ id, name, source, error })), notes };
}
