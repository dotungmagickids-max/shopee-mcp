/**
 * Lịch content: đọc bảng content_plan (Supabase) và ghép mục "Thiếu content gì" từ số của màn Đề xuất chạy.
 * Không gọi lệnh ghi lên Meta, Pancake hay Shopee.
 */
import { addDays } from "../autopilot/time";
import { db } from "../supabase";
import { enrich, toContentPost } from "./content";
import { loadManualCodes, readPagePosts } from "./content-data";
import { contentGaps, isOpen, type Gap, type PlanItem } from "./content-plan";
import { PAGES } from "./magic-data";
import { scrub } from "./meta";
import { loadSuggest } from "./suggest-run-data";
import type { SuggestPost } from "./suggest-run";

/** Page Annie Baby là thương hiệu riêng; các page còn lại cùng thương hiệu Magickids. */
const ANNIE_PAGE = "103086665933895";
export const MAGICKIDS_PAGES = Object.keys(PAGES).filter((id) => id !== ANNIE_PAGE);

const COLS = "id, ngay, kenh, noi_dang, ma, dang, tieu_de, ghi_chu, ly_do, nguoi, trang_thai, link, task_id, nguon, created_at";
const NOT_READY = "Chưa có bảng content_plan (chưa áp migration 0039).";
const fail = (e: { code?: string | null; message: string }) => new Error(e.code === "42P01" || e.code === "PGRST205" || /schema cache|does not exist/i.test(e.message) ? NOT_READY : `content_plan: ${e.message}`);
const toItem = (r: any): PlanItem => ({ ...r, id: Number(r.id), ma: Array.isArray(r.ma) ? r.ma.map(String) : [], task_id: r.task_id == null ? null : Number(r.task_id) });

/** Dòng có ngày trong [from, to], cộng mọi dòng chưa xếp ngày còn mở. */
export async function loadPlan(from: string, to: string): Promise<{ dated: PlanItem[]; undated: PlanItem[] }> {
  const [a, b] = await Promise.all([
    db().from("content_plan").select(COLS).gte("ngay", from).lte("ngay", to).order("ngay").order("id").limit(1000),
    db().from("content_plan").select(COLS).is("ngay", null).order("id", { ascending: false }).limit(300),
  ]);
  if (a.error) throw fail(a.error);
  if (b.error) throw fail(b.error);
  return { dated: (a.data ?? []).map(toItem), undated: (b.data ?? []).map(toItem).filter((x) => isOpen(x.trang_thai)) };
}

/** Mọi dòng còn mở (để biết đề xuất nào đã nằm trong lịch). */
export async function loadOpenPlans(): Promise<PlanItem[]> {
  const { data, error } = await db().from("content_plan").select(COLS).not("trang_thai", "in", "(da_dang,bo)").limit(1000);
  if (error) throw fail(error);
  return (data ?? []).map(toItem);
}

export async function loadPlanItem(id: number): Promise<PlanItem | null> {
  const { data, error } = await db().from("content_plan").select(COLS).eq("id", id).maybeSingle();
  if (error) throw fail(error);
  return data ? toItem(data) : null;
}

/** Bài Facebook đã đăng từ `since` tới hôm nay của các page có trong `pageIds` (để khớp với dòng lịch). Lỗi page nào thì bỏ page đó. */
export async function loadPostedSince(pageIds: string[], since: string, today: string): Promise<SuggestPost[]> {
  if (!pageIds.length) return [];
  const from = since < addDays(today, -59) ? addDays(today, -59) : since;
  const days = Math.max(1, Math.round((Date.parse(today) - Date.parse(from)) / 86_400_000) + 2);
  const [lists, manual] = await Promise.all([
    Promise.all(pageIds.map((id) => readPagePosts(id, from, today, days).then((r) => r.posts.map((p) => toContentPost(id, p))).catch(() => []))),
    loadManualCodes().catch(() => new Map<string, string[]>()),
  ]);
  return enrich(lists.flat(), new Map(), manual).map((p) => ({ id: p.id, page_id: p.page_id, day: p.day, picture: p.picture, permalink: p.permalink, message: p.message, codes: p.codes, offWall: p.offWall, kind: p.kind }));
}

export type GapData = { gaps: Gap[]; since: string; until: string; notes: string[] };

export async function loadGaps(today: string): Promise<GapData> {
  const notes: string[] = [];
  const [s, planned] = await Promise.all([
    loadSuggest(today),
    loadOpenPlans().catch((e) => {
      notes.push(scrub(e instanceof Error ? e.message : String(e)).slice(0, 160));
      return [] as PlanItem[];
    }),
  ]);
  notes.push(...s.pageErrors.map((x) => `Chưa đọc được bài: ${x}`), ...s.notes);
  return { gaps: contentGaps({ rows: s.rows, posts: s.posts, stock: s.stock, today, multiPages: MAGICKIDS_PAGES, planned }), since: s.since, until: s.until, notes };
}
