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
import { resultsFromLog, runsFromLog, uncovered, type LogRow, type LogRun, type RunResult } from "./launch-history";
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

export async function loadLaunch(pageId: string, days = 30): Promise<LaunchData> {
  const errors: string[] = [];
  const note = (label: string) => (e: unknown) => {
    errors.push(`${label}: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  };
  const today = vnDate();
  const [read, accounts, stock, history, manual, drafts] = await Promise.all([
    readPagePosts(pageId, addDays(today, -(days - 1)), today, days + 1),
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

/** Kết quả một quảng cáo. `notes`: việc chưa làm được trọn (không phải lỗi tạo), ví dụ chưa tắt được danh mục sản phẩm. */
export type LaunchResult = RunResult;

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
export async function runLaunch(cfg: LaunchConfig, items: LaunchItem[], onProgress?: (results: LaunchResult[]) => Promise<void>): Promise<LaunchResult[]> {
  const results: LaunchResult[] = [];
  const progress = async () => {
    if (onProgress) await onProgress(results).catch(() => undefined);
  };
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
      const r: LaunchResult = {
        post_id: a.post_id,
        ad_name: a.ad_name,
        account_id: c.account_id,
        campaign_id: campaignId,
        campaign_name: c.name,
        adset_id: adsetId,
        adset_name: set.name,
        ad_id: null,
        error: adsetError,
      };
      results.push(r);
      if (campaignId && adsetId) await createAdInAdset(r);
      await progress();
      }
    }
  }
  return results;
}

/**
 * Tạo creative + quảng cáo cho một bài vào một nhóm có sẵn (dùng khi lên camp và khi bấm "Tạo lại" bài lỗi).
 * Ghi kết quả vào `r` (ad_id hoặc error). Quảng cáo luôn ở trạng thái tạm dừng.
 */
export async function createAdInAdset(r: LaunchResult): Promise<LaunchResult> {
  if (!r.adset_id) return r;
  const adsetId = r.adset_id;
  r.error = null;
  try {
    // Tạo creative kèm lệnh tắt danh mục sản phẩm. Meta từ chối tham số đó thì tạo lại không kèm (tham số khác,
    // không phải gửi lại lệnh cũ) và ghi chú để anh tắt tay trong Trình quản lý quảng cáo.
    let noCatalog = true;
    const creativeId = await create(r.account_id, "adcreatives", creativeParams(r.post_id, r.ad_name)).catch(async (e) => {
      const first = e instanceof Error ? e.message : String(e);
      if (!/degrees_of_freedom|product_extensions|creative_features/i.test(first)) throw e;
      noCatalog = false;
      r.notes = [`Chưa tắt được danh mục sản phẩm qua API (${first.slice(0, 120)}): anh tắt ở mục Nguồn quảng cáo.`];
      return create(r.account_id, "adcreatives", creativeParams(r.post_id, r.ad_name, false));
    });
    try {
      r.ad_id = await create(r.account_id, "ads", adParams(r.ad_name, adsetId, creativeId));
    } catch (e) {
      const first = e instanceof Error ? e.message : String(e);
      if (!isCreativeIncompatible(first)) throw e;
      // Bài thiếu nút nhắn tin: thử đúng một lần nữa với creative có nút Messenger (tham số khác, không phải gửi lại lệnh cũ).
      const withCta = await create(r.account_id, "adcreatives", creativeParamsWithCta(r.post_id, r.ad_name, noCatalog)).catch((e2) => {
        throw new Error(`${first} | Thử thêm nút nhắn tin cũng lỗi: ${e2 instanceof Error ? e2.message : String(e2)}`);
      });
      r.ad_id = await create(r.account_id, "ads", adParams(r.ad_name, adsetId, withCta)).catch((e2) => {
        throw new Error(`${first} | Thử thêm nút nhắn tin cũng lỗi: ${e2 instanceof Error ? e2.message : String(e2)}`);
      });
    }
  } catch (e) {
    r.error = e instanceof Error ? e.message : String(e);
  }
  return r;
}

// ---------- Lịch sử lên camp (bảng fb_launch_runs + nhật ký fb_write_log) ----------

export type SavedRun = {
  id: number;
  created_at: string;
  finished_at: string | null;
  page_id: string | null;
  source: "web" | "nhat_ky";
  status: "dang_chay" | "xong";
  results: LaunchResult[];
};
export type HistoryRun = (SavedRun & { kind: "saved" }) | (LogRun & { kind: "log" });

const RUN_COLS = "id, created_at, finished_at, page_id, source, status, results";
const runsTableMissing = (e: { code?: string | null; message: string }) => e.code === "42P01" || e.code === "PGRST205" || /schema cache|does not exist/i.test(e.message);

/** Bắt đầu một lần lên camp: lưu cấu hình và danh sách bài trước khi gọi Meta. Chưa có bảng thì trả null (vẫn lên camp). */
export async function startRun(cfg: LaunchConfig, items: LaunchItem[]): Promise<number | null> {
  const { data, error } = await db().from("fb_launch_runs").insert({ page_id: cfg.page_id, config: cfg, items, results: [], status: "dang_chay", source: "web" }).select("id").single();
  return error ? null : Number(data.id);
}

export async function saveRunResults(id: number, results: LaunchResult[], done: boolean): Promise<void> {
  await db()
    .from("fb_launch_runs")
    .update({ results, ...(done ? { status: "xong", finished_at: new Date().toISOString() } : {}) })
    .eq("id", id);
}

const LOG_COLS = "id, created_at, action, account_id, target_id, target_name, ok, error, after";

async function logRows(fromIso: string): Promise<LogRow[]> {
  const { data, error } = await db().from("fb_write_log").select(LOG_COLS).like("action", "create_%").gte("created_at", fromIso).order("id").limit(3000);
  if (error) throw new Error(`fb_write_log: ${error.message}`);
  return (data ?? []) as LogRow[];
}

/** Lần lên camp gần đây: các lần đã lưu + các lần dựng lại từ nhật ký (trước khi có bảng lưu). Mới nhất trước. */
export async function loadHistory(days = 14, limit = 20): Promise<{ runs: HistoryRun[]; tableReady: boolean; error: string | null }> {
  const from = new Date(Date.now() - days * 86_400_000).toISOString();
  const { data, error } = await db().from("fb_launch_runs").select(RUN_COLS).gte("created_at", from).order("created_at", { ascending: false }).limit(limit);
  const tableReady = !error;
  if (error && !runsTableMissing(error)) return { runs: [], tableReady, error: `fb_launch_runs: ${error.message}` };
  const saved = ((data ?? []) as SavedRun[]).map((r) => ({ ...r, kind: "saved" as const }));
  let fromLog: HistoryRun[] = [];
  try {
    fromLog = runsFromLog(uncovered(await logRows(from), saved)).map((r) => ({ ...r, kind: "log" as const }));
  } catch (e) {
    return { runs: saved, tableReady, error: e instanceof Error ? e.message : String(e) };
  }
  const runs = [...saved, ...fromLog].sort((a, b) => (b.kind === "saved" ? b.created_at : b.started_at).localeCompare(a.kind === "saved" ? a.created_at : a.started_at));
  return { runs: runs.slice(0, limit), tableReady, error: null };
}

export async function loadRun(id: number): Promise<SavedRun | null> {
  const { data, error } = await db().from("fb_launch_runs").select(RUN_COLS).eq("id", id).maybeSingle();
  if (error) throw new Error(runsTableMissing(error) ? "Chưa có bảng fb_launch_runs (chưa áp migration)." : `fb_launch_runs: ${error.message}`);
  return (data as SavedRun | null) ?? null;
}

/**
 * Lưu một lần lên camp dựng từ nhật ký (lệnh id `fromId`..`toId`) thành lần đã lưu, để tạo lại bài lỗi và ghi kết
 * quả vào đó. Đã lưu rồi (cùng khoảng thời gian) thì trả lần đã lưu.
 */
export async function saveLogRun(fromId: number, toId: number): Promise<SavedRun> {
  const { data, error } = await db().from("fb_write_log").select(LOG_COLS).gte("id", fromId).lte("id", toId).order("id");
  if (error) throw new Error(`fb_write_log: ${error.message}`);
  const rows = (data ?? []) as LogRow[];
  if (!rows.length) throw new Error("Không còn nhật ký của lần lên camp này.");
  const started = rows[0].created_at;
  const finished = rows[rows.length - 1].created_at;
  const { data: dup } = await db().from("fb_launch_runs").select(RUN_COLS).eq("created_at", started).eq("source", "nhat_ky").maybeSingle();
  if (dup) return dup as SavedRun;
  const { results, page_id } = resultsFromLog(rows);
  const ins = await db()
    .from("fb_launch_runs")
    .insert({ created_at: started, finished_at: finished, page_id, config: {}, items: [], results, status: "xong", source: "nhat_ky" })
    .select(RUN_COLS)
    .single();
  if (ins.error) throw new Error(runsTableMissing(ins.error) ? "Chưa có bảng fb_launch_runs (chưa áp migration)." : `fb_launch_runs: ${ins.error.message}`);
  return ins.data as SavedRun;
}
