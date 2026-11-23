/**
 * FB Magic Tool — Phần 1: đọc bài của page kèm tồn kho và kết quả quảng cáo cũ; chạy lệnh tạo camp (tạm dừng)
 * và ghi nhật ký fb_write_log. Lệnh tạo chỉ được gọi từ /api/fb/launch sau khi anh bấm xác nhận.
 */
import { addDays, vnDate } from "../autopilot/time";
import { db } from "../supabase";
import { loadStock } from "./jobs";
import { adParams, adsetParams, buildPlan, campaignParams, codesFromText, creativeParams, creativeParamsWithCta, explainMetaError, isCreativeIncompatible, type LaunchConfig, type LaunchItem } from "./launch";
import { loadManualCodes, readPagePosts } from "./content-data";
import { adsInfo, createObject, listAccounts, scrub } from "./meta";
import { realSpend } from "./rules";

export type PostRow = {
  id: string;
  message: string;
  created_time: string;
  picture: string | null;
  permalink: string | null;
  kind: string;
  codes: string[];
  stock: number | null;
  stockDays: number | null;
  /** Bán mỗi ngày (mọi kênh, theo Pancake), cộng các mã trong bài. */
  rate: number | null;
  /** Kết quả quảng cáo cũ của bài này trong 90 ngày (chi thật, đơn, doanh thu Pancake). */
  ran: { ads: number; spendReal: number; orders: number; revenue: number } | null;
};

export type LaunchDraft = { id: number; created_at: string; name: string; page_id: string; config: Partial<LaunchConfig>; items: LaunchItem[] };
export type LaunchData = {
  posts: PostRow[];
  accounts: { id: string; name: string }[];
  usedNames: string[];
  usedCampaigns: string[];
  /** Nháp đã lưu của page này; null = chưa có bảng (chưa áp migration), nút lưu nháp sẽ báo lỗi. */
  drafts: LaunchDraft[] | null;
  errors: string[];
};

async function loadDrafts(pageId: string): Promise<LaunchDraft[] | null> {
  const { data, error } = await db().from("fb_launch_drafts").select("id, created_at, name, page_id, config, items").eq("page_id", pageId).order("created_at", { ascending: false }).limit(30);
  return error ? null : ((data ?? []) as LaunchDraft[]);
}

type AdSum = { ad_name: string | null; campaign_name: string | null; spend: number; orders: number; revenue: number };

/** Cộng fb_ad_daily 90 ngày theo ad_id. */
async function adHistory(): Promise<Map<string, AdSum>> {
  const out = new Map<string, AdSum>();
  const from = addDays(vnDate(), -90);
  for (let page = 0; page < 30; page++) {
    const { data, error } = await db()
      .from("fb_ad_daily")
      .select("ad_id, ad_name, campaign_name, spend, orders, revenue")
      .gte("ngay", from)
      .order("ngay")
      .order("ad_id")
      .range(page * 1000, page * 1000 + 999);
    if (error) throw new Error(`fb_ad_daily: ${error.message}`);
    for (const r of data ?? []) {
      const s = out.get(r.ad_id) ?? { ad_name: r.ad_name, campaign_name: r.campaign_name ?? null, spend: 0, orders: 0, revenue: 0 };
      s.spend += Number(r.spend ?? 0);
      s.orders += Number(r.orders ?? 0);
      s.revenue += Number(r.revenue ?? 0);
      s.ad_name = r.ad_name ?? s.ad_name;
      out.set(r.ad_id, s);
    }
    if (!data || data.length < 1000) break;
  }
  return out;
}

export async function loadLaunch(pageId: string): Promise<LaunchData> {
  const errors: string[] = [];
  const note = (label: string) => (e: unknown) => {
    errors.push(`${label}: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  };
  const today = vnDate();
  const [read, accounts, stock, history, manual, drafts] = await Promise.all([
    readPagePosts(pageId, addDays(today, -29), today, 31),
    listAccounts().catch(note("Tài khoản")),
    loadStock().catch(note("Tồn kho")),
    adHistory().catch(note("Kết quả cũ")),
    loadManualCodes().catch(() => null), // chưa có bảng mã gắn tay: dùng mã đọc từ chữ trong bài
    loadDrafts(pageId).catch(() => null),
  ]);
  if (!read.source) throw new Error(read.error ?? "Không đọc được bài của page");
  // Bài ngoài tường page (video, ảnh tạo riêng cho quảng cáo) không đưa vào danh sách chọn.
  const posts = read.posts.filter((p) => !p.off_wall).sort((a, b) => b.created_time.localeCompare(a.created_time));
  const byStory = new Map<string, NonNullable<PostRow["ran"]>>();
  if (history?.size) {
    const info = await adsInfo([...history.keys()]).catch(note("Bài gốc của quảng cáo cũ"));
    for (const [adId, h] of history) {
      const story = info?.get(adId)?.story_id;
      if (!story) continue;
      const s = byStory.get(story) ?? { ads: 0, spendReal: 0, orders: 0, revenue: 0 };
      s.ads += 1;
      s.spendReal += realSpend(h.spend);
      s.orders += h.orders;
      s.revenue += Math.round(h.revenue);
      byStory.set(story, s);
    }
  }
  const rows: PostRow[] = posts.map((p) => {
    const typed = manual?.get(p.id);
    const codes = typed?.length ? typed : codesFromText(p.message);
    const st = codes.map((c) => stock?.get(c) as { stock: number; days: number | null; rate?: number } | undefined).filter((x) => !!x);
    const days = st.map((x) => x!.days).filter((d): d is number => d != null);
    return {
      ...p,
      message: p.message.slice(0, 300),
      codes,
      stock: st.length ? st.reduce((s, x) => s + x!.stock, 0) : null,
      stockDays: days.length ? Math.min(...days) : null,
      rate: st.length ? st.reduce((s, x) => s + (x!.rate ?? 0), 0) : null,
      ran: byStory.get(p.id) ?? null,
    };
  });
  const usedNames = history ? [...history.values()].map((h) => h.ad_name ?? "").filter(Boolean) : [];
  const usedCampaigns = history ? [...new Set([...history.values()].map((h) => h.campaign_name ?? "").filter(Boolean))] : [];
  return { posts: rows, accounts: (accounts ?? []).map((a) => ({ id: a.id, name: a.name })), usedNames, usedCampaigns, drafts, errors };
}

export type LaunchResult = {
  post_id: string;
  ad_name: string;
  account_id: string;
  campaign_id: string | null;
  adset_id: string | null;
  ad_id: string | null;
  error: string | null;
};

async function logWrite(row: { action: string; account_id: string; target_id: string | null; target_name: string; after: unknown; ok: boolean; error: string | null }) {
  // Nhật ký lỗi không được làm hỏng lệnh đang chạy.
  await db().from("fb_write_log").insert({ ...row, before: null }).then(() => undefined, () => undefined);
}

/** Tạo một đối tượng trên Meta và ghi nhật ký (kể cả khi lỗi). */
async function create(accountId: string, edge: Parameters<typeof createObject>[1], params: Record<string, string>): Promise<string> {
  const action = `create_${edge === "adcreatives" ? "creative" : edge.replace(/s$/, "")}`;
  try {
    const id = await createObject(accountId, edge, params);
    await logWrite({ action, account_id: accountId, target_id: id, target_name: params.name, after: params, ok: true, error: null });
    return id;
  } catch (e) {
    const error = scrub(e instanceof Error ? e.message : String(e));
    await logWrite({ action, account_id: accountId, target_id: null, target_name: params.name, after: params, ok: false, error });
    throw new Error(explainMetaError(error));
  }
}

/**
 * Tạo camp theo kế hoạch, tất cả ở trạng thái TẠM DỪNG. Một bài lỗi không chặn các bài khác;
 * chiến dịch CBO lỗi thì các bài trong đó đều báo lỗi. Không tự thử lại (tránh tạo trùng).
 */
export async function runLaunch(cfg: LaunchConfig, items: LaunchItem[]): Promise<LaunchResult[]> {
  const results: LaunchResult[] = [];
  for (const c of buildPlan(cfg, items)) {
    let campaignId: string | null = null;
    let campaignError: string | null = null;
    try {
      campaignId = await create(c.account_id, "campaigns", campaignParams(c));
    } catch (e) {
      campaignError = e instanceof Error ? e.message : String(e);
    }
    for (const set of c.adsets) {
      // Một nhóm có thể chứa nhiều quảng cáo ("1-1-n"): tạo nhóm một lần, nhóm lỗi thì mọi quảng cáo trong đó báo lỗi.
      let adsetId: string | null = null;
      let adsetError: string | null = campaignError;
      if (campaignId) {
        try {
          adsetId = await create(c.account_id, "adsets", adsetParams(cfg, campaignId, set));
        } catch (e) {
          adsetError = e instanceof Error ? e.message : String(e);
        }
      }
      for (const a of set.ads) {
      const r: LaunchResult = { post_id: a.post_id, ad_name: a.ad_name, account_id: c.account_id, campaign_id: campaignId, adset_id: adsetId, ad_id: null, error: adsetError };
      results.push(r);
      if (!campaignId || !adsetId) continue;
      try {
        const creativeId = await create(c.account_id, "adcreatives", creativeParams(a.post_id, a.ad_name));
        try {
          r.ad_id = await create(c.account_id, "ads", adParams(a.ad_name, adsetId, creativeId));
        } catch (e) {
          const first = e instanceof Error ? e.message : String(e);
          if (!isCreativeIncompatible(first)) throw e;
          // Bài thiếu nút nhắn tin: thử đúng một lần nữa với creative có nút Messenger (tham số khác, không phải gửi lại lệnh cũ).
          const withCta = await create(c.account_id, "adcreatives", creativeParamsWithCta(a.post_id, a.ad_name)).catch((e2) => {
            throw new Error(`${first} | Thử thêm nút nhắn tin cũng lỗi: ${e2 instanceof Error ? e2.message : String(e2)}`);
          });
          r.ad_id = await create(c.account_id, "ads", adParams(a.ad_name, adsetId, withCta)).catch((e2) => {
            throw new Error(`${first} | Thử thêm nút nhắn tin cũng lỗi: ${e2 instanceof Error ? e2.message : String(e2)}`);
          });
        }
      } catch (e) {
        r.error = e instanceof Error ? e.message : String(e);
      }
      }
    }
  }
  return results;
}
