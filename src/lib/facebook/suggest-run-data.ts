/**
 * FB Magic Tool — Đề xuất chạy: đọc số (chỉ đọc). Chi + đơn Pancake theo quảng cáo (bảng fb_ad_daily, 14 ngày tới hôm
 * qua), bài gốc + trạng thái quảng cáo (Meta), bài 60 ngày của mọi page (Pancake → Meta → Composio), mã gắn tay, tồn
 * kho (pancake_variations), bảng trần. Không có lệnh ghi lên Meta.
 */
import { addDays } from "../autopilot/time";
import { db } from "../supabase";
import { enrich, toContentPost } from "./content";
import { loadManualCodes, readPagePosts } from "./content-data";
import { loadStock } from "./jobs";
import { codesFromName } from "./magic";
import { loadCeilings, PAGES } from "./magic-data";
import { adsInfo, scrub } from "./meta";
import { realSpend } from "./rules";
import { buildSuggestions, SUGGEST_RULES, type AdStat, type CodeRow, type StockMap, type SuggestPost } from "./suggest-run";

export const POST_DAYS = 60;

export type SuggestData = { since: string; until: string; rows: CodeRow[]; posts: SuggestPost[]; stock: StockMap; pageErrors: string[]; notes: string[] };

const msg = (e: unknown) => scrub(e instanceof Error ? e.message : String(e)).slice(0, 160);

async function adRows(since: string, until: string) {
  const out: any[] = [];
  for (let page = 0; page < 30; page++) {
    const { data, error } = await db()
      .from("fb_ad_daily")
      .select("ad_id, ad_name, campaign_name, spend, orders, revenue, product_code")
      .gte("ngay", since)
      .lte("ngay", until)
      .gt("spend", 0)
      .order("ngay")
      .order("ad_id")
      .range(page * 1000, page * 1000 + 999);
    if (error) throw new Error(`fb_ad_daily: ${error.message}`);
    out.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  return out;
}

export async function loadSuggest(today: string): Promise<SuggestData> {
  const since = addDays(today, -SUGGEST_RULES.days);
  const until = addDays(today, -1);
  const notes: string[] = [];
  const soft = <T,>(label: string, empty: T) => (e: unknown): T => {
    notes.push(`${label}: ${msg(e)}`);
    return empty;
  };
  const [raw, pages, manual, stock, ceilings] = await Promise.all([
    adRows(since, until),
    Promise.all(
      Object.entries(PAGES).map(async ([id, name]) => {
        const r = await readPagePosts(id, addDays(today, -(POST_DAYS - 1)), today, POST_DAYS + 1);
        return { id, name, error: r.error, posts: r.posts.map((p) => toContentPost(id, p)) };
      })
    ),
    loadManualCodes().catch(() => new Map<string, string[]>()),
    loadStock().catch(soft("Chưa đọc được tồn kho", new Map()) as any) as Promise<StockMap>,
    loadCeilings(),
  ]);

  const agg = new Map<string, AdStat & { product_code: string | null; campaign_name: string | null }>();
  for (const r of raw) {
    const a =
      agg.get(r.ad_id) ??
      { ad_id: r.ad_id, ad_name: r.ad_name, campaign_name: r.campaign_name, product_code: r.product_code, story_id: null, codes: [], running: false, spendReal: 0, orders: 0, revenue: 0 };
    a.spendReal += realSpend(Number(r.spend ?? 0));
    a.orders += Number(r.orders ?? 0);
    a.revenue += Math.round(Number(r.revenue ?? 0));
    if (!a.product_code && r.product_code) a.product_code = r.product_code;
    agg.set(r.ad_id, a);
  }
  const info = await adsInfo([...agg.keys()]).catch(soft("Chưa đọc được bài gốc của quảng cáo", new Map()));
  const ads: AdStat[] = [...agg.values()].map((a) => {
    const i = info.get(a.ad_id);
    const named = codesFromName(a.ad_name);
    const codes = named.length ? named : codesFromName(a.campaign_name).length ? codesFromName(a.campaign_name) : a.product_code ? [String(a.product_code).toUpperCase()] : [];
    return { ad_id: a.ad_id, ad_name: a.ad_name, story_id: i?.story_id ?? null, codes, running: i?.status === "ACTIVE", spendReal: a.spendReal, orders: a.orders, revenue: a.revenue };
  });

  const posts: SuggestPost[] = enrich(pages.flatMap((p) => p.posts), new Map(), manual).map((p) => ({
    id: p.id,
    page_id: p.page_id,
    day: p.day,
    picture: p.picture,
    permalink: p.permalink,
    message: p.message,
    codes: p.codes,
    offWall: p.offWall,
    kind: p.kind,
  }));
  const pageErrors = pages.filter((p) => p.error && !p.posts.length).map((p) => `${p.name}: ${p.error}`);
  return { since, until, rows: buildSuggestions({ ads, posts, stock, ceilings }), posts, stock, pageErrors, notes };
}
