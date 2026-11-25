/**
 * FB Magic Tool — Lịch sử lên camp (hàm thuần, không gọi mạng, dễ test).
 * Mỗi lần bấm Tạo được lưu ở bảng fb_launch_runs. Lần lên camp trước khi có bảng đó (hoặc lưu lỗi) được dựng lại từ
 * nhật ký lệnh ghi fb_write_log, để anh vẫn thấy quảng cáo nào đã tạo, quảng cáo nào lỗi, và tạo lại bài lỗi.
 */

export type RunResult = {
  /** Bài gốc `<page>_<bài>`; rỗng khi nhóm/chiến dịch lỗi trước lúc tạo quảng cáo (không biết bài). */
  post_id: string;
  ad_name: string;
  account_id: string;
  campaign_id: string | null;
  campaign_name?: string | null;
  adset_id: string | null;
  adset_name?: string | null;
  ad_id: string | null;
  error: string | null;
  notes?: string[];
};

export type LogRow = {
  id: number;
  created_at: string;
  action: string;
  account_id: string | null;
  target_id: string | null;
  target_name: string | null;
  ok: boolean;
  error: string | null;
  after: Record<string, unknown> | null;
};

export type LogRun = { key: string; from_id: number; to_id: number; started_at: string; finished_at: string; page_id: string | null; results: RunResult[] };

/** Hai lệnh cách nhau hơn ngần này thì coi là hai lần bấm khác nhau. */
export const RUN_GAP_MS = 3 * 60_000;

const str = (v: unknown) => (v == null ? "" : String(v));
const pageOfStory = (story: string) => (/^\d+_\d+$/.test(story) ? story.split("_")[0] : null);
const pageOfAdset = (after: Record<string, unknown> | null): string | null => {
  try {
    const po = JSON.parse(str(after?.promoted_object) || "{}");
    return po?.page_id ? String(po.page_id) : null;
  } catch {
    return null;
  }
};

/**
 * Dựng lại kết quả từng quảng cáo của một cụm lệnh ghi (một lần bấm Tạo). Thứ tự lệnh của web: chiến dịch → nhóm →
 * creative → quảng cáo (lỗi "không hợp mục tiêu" thì creative có nút nhắn tin → quảng cáo). Lỗi cuối cùng của một
 * quảng cáo là lỗi hiện ra; lần thử sau thành công thì xóa lỗi.
 */
export function resultsFromLog(rows: LogRow[]): { results: RunResult[]; page_id: string | null } {
  const results: RunResult[] = [];
  const camps = new Map<string, { id: string | null; name: string; error: string | null }>(); // theo tài khoản
  const sets = new Map<string, { id: string | null; name: string; campaign_id: string | null; account: string }>(); // theo id nhóm
  let curSet: { id: string | null; name: string; campaign_id: string | null; account: string } | null = null;
  let cur: RunResult | null = null;
  let page: string | null = null;
  for (const r of [...rows].sort((a, b) => a.id - b.id)) {
    const acc = str(r.account_id);
    const after = r.after ?? {};
    if (r.action === "create_campaign") {
      camps.set(acc, { id: r.ok ? str(r.target_id) : null, name: str(r.target_name), error: r.ok ? null : str(r.error) });
      if (!r.ok) results.push({ post_id: "", ad_name: `(chiến dịch ${str(r.target_name)})`, account_id: acc, campaign_id: null, campaign_name: str(r.target_name), adset_id: null, ad_id: null, error: str(r.error) });
      cur = null;
    } else if (r.action === "create_adset") {
      const campaign_id = str(after.campaign_id) || camps.get(acc)?.id || null;
      page = page ?? pageOfAdset(after);
      curSet = { id: r.ok ? str(r.target_id) : null, name: str(r.target_name), campaign_id, account: acc };
      if (curSet.id) sets.set(curSet.id, curSet);
      if (!r.ok) {
        results.push({ post_id: "", ad_name: `(nhóm ${str(r.target_name)})`, account_id: acc, campaign_id, campaign_name: camps.get(acc)?.name ?? null, adset_id: null, adset_name: str(r.target_name), ad_id: null, error: str(r.error) });
      }
      cur = null;
    } else if (r.action === "create_creative") {
      const story = str(after.object_story_id);
      page = page ?? pageOfStory(story);
      const name = str(r.target_name);
      if (!cur || cur.ad_name !== name || cur.account_id !== acc || cur.ad_id || cur.adset_id !== (curSet?.id ?? null)) {
        cur = {
          post_id: story,
          ad_name: name,
          account_id: acc,
          campaign_id: curSet?.campaign_id ?? camps.get(acc)?.id ?? null,
          campaign_name: camps.get(acc)?.name ?? null,
          adset_id: curSet?.id ?? null,
          adset_name: curSet?.name ?? null,
          ad_id: null,
          error: null,
        };
        results.push(cur);
      }
      if (!r.ok && !cur.ad_id) cur.error = str(r.error);
    } else if (r.action === "create_ad") {
      const adset = str(after.adset_id) || curSet?.id || null;
      if (!cur || cur.ad_name !== str(r.target_name)) {
        cur = { post_id: "", ad_name: str(r.target_name), account_id: acc, campaign_id: sets.get(adset ?? "")?.campaign_id ?? null, adset_id: adset, ad_id: null, error: null };
        results.push(cur);
      }
      if (r.ok) {
        cur.ad_id = str(r.target_id);
        cur.error = null;
      } else cur.error = str(r.error);
    }
  }
  return { results, page_id: page };
}

/**
 * Gom nhật ký thành các lần bấm Tạo (cách nhau hơn RUN_GAP_MS là lần khác). Bỏ cụm chỉ có creative/quảng cáo (không
 * tạo chiến dịch hay nhóm): đó là lần "Tạo lại" một bài lỗi, kết quả đã ghi vào lần lên camp gốc.
 */
export function runsFromLog(rows: LogRow[], gapMs = RUN_GAP_MS): LogRun[] {
  const sorted = [...rows].filter((r) => r.action.startsWith("create_")).sort((a, b) => a.id - b.id);
  const groups: LogRow[][] = [];
  for (const r of sorted) {
    const g = groups[groups.length - 1];
    if (g && Date.parse(r.created_at) - Date.parse(g[g.length - 1].created_at) <= gapMs) g.push(r);
    else groups.push([r]);
  }
  return groups
    .filter((g) => g.some((r) => r.action === "create_campaign" || r.action === "create_adset"))
    .map((g) => {
      const { results, page_id } = resultsFromLog(g);
      const first = g[0];
      const last = g[g.length - 1];
      return { key: `${first.id}-${last.id}`, from_id: first.id, to_id: last.id, started_at: first.created_at, finished_at: last.created_at, page_id, results };
    })
    .reverse();
}

/** Lệnh ghi nằm trong khoảng thời gian của một lần đã lưu thì không dựng lại nữa (tránh hiện trùng). */
export function uncovered(rows: LogRow[], saved: { created_at: string; finished_at: string | null }[], slackMs = 5_000): LogRow[] {
  const spans = saved.map((s) => [Date.parse(s.created_at) - slackMs, Date.parse(s.finished_at ?? s.created_at) + slackMs] as const);
  return rows.filter((r) => {
    const t = Date.parse(r.created_at);
    return !spans.some(([a, b]) => t >= a && t <= b);
  });
}

/** Bài lỗi tạo lại được ngay: đã có nhóm (chỉ thiếu quảng cáo) và biết bài gốc. */
export const canRetry = (r: RunResult): boolean => !r.ad_id && !!r.adset_id && /^\d+_\d+$/.test(r.post_id) && !!r.ad_name;

export const adsManagerAd = (r: Pick<RunResult, "account_id" | "ad_id">) => `https://adsmanager.facebook.com/adsmanager/manage/ads/edit?act=${r.account_id}&selected_ad_ids=${r.ad_id}`;
export const adsManagerAdset = (r: Pick<RunResult, "account_id" | "adset_id">) => `https://adsmanager.facebook.com/adsmanager/manage/adsets/edit?act=${r.account_id}&selected_adset_ids=${r.adset_id}`;
