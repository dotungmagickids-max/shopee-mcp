/**
 * Meta Graph / Marketing API bằng token System User (META_SYSTEM_TOKEN) của app Magickids Ads Tool.
 * Mọi request kèm appsecret_proof (META_APP_SECRET). Không bao giờ đưa URL hay token vào thông báo lỗi.
 */
import { createHmac } from "node:crypto";

/** Phiên bản Graph API. v27.0 ra 04/11/2026; đổi ở đây khi Meta ra bản mới. */
export const GRAPH_VERSION = "v27.0";
const GRAPH = `https://graph.facebook.com/${GRAPH_VERSION}`;

/** Mã lỗi giới hạn tốc độ của Meta: thử lại có giãn cách. */
const RATE_LIMIT_CODES = new Set([4, 17, 32, 613, ...Array.from({ length: 15 }, (_, i) => 80000 + i)]);

export function appSecretProof(token: string, secret: string): string {
  return createHmac("sha256", secret).update(token).digest("hex");
}

/** Xóa token khỏi chuỗi trước khi ghi log / trả lỗi. */
export function scrub(s: string): string {
  return s
    .replace(/(access_token|appsecret_proof)=[^&\s"]+/gi, "$1=***")
    // Meta có khi in nguyên token trong thông báo lỗi ("Malformed access token EAA…").
    .replace(/\bEAA[A-Za-z0-9]{10,}/g, "EAA***");
}

function authParams(pageToken?: string): Record<string, string> {
  const t = pageToken ?? token();
  const secret = process.env.META_APP_SECRET?.trim();
  return secret ? { access_token: t, appsecret_proof: appSecretProof(t, secret) } : { access_token: t };
}

async function send(url: URL, init: RequestInit): Promise<any> {
  const delays = [2000, 8000, 20000];
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, init).catch(() => null);
    if (!res) throw new MetaError("Meta API: không kết nối được");
    const body: any = await res.json().catch(() => null);
    if (res.ok && !body?.error && body?.success !== false) return body;
    const e = body?.error;
    const retry = RATE_LIMIT_CODES.has(Number(e?.code)) && init.method !== "POST" && attempt < delays.length;
    if (!retry) {
      throw new MetaError(scrub(`Meta API ${res.status}: ${String(e?.error_user_msg ?? e?.message ?? "lỗi").slice(0, 200)}${e?.code ? ` (mã ${e.code})` : ""}`));
    }
    await new Promise((r) => setTimeout(r, delays[attempt]));
  }
}

/** Tài khoản không tính khi báo cáo (anh chốt): BOSS TUYỀN 3, 4, 5, 6. */
export const EXCLUDED_ACCOUNTS = new Set(["263854262635122", "1221559028478456", "203632012307325", "242962362083925"]);

export class MetaError extends Error {}

function token(): string {
  const t = process.env.META_SYSTEM_TOKEN?.trim();
  if (!t) throw new MetaError("Chưa đặt META_SYSTEM_TOKEN");
  return t;
}

async function get(pathOrUrl: string, params: Record<string, string> = {}, pageToken?: string): Promise<any> {
  const url = pathOrUrl.startsWith("http")
    ? new URL(pathOrUrl)
    : new URL(`${GRAPH}/${pathOrUrl.replace(/^\//, "")}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  // Trang tiếp (paging.next) đã kèm token; vẫn đặt lại để chắc có appsecret_proof.
  for (const [k, v] of Object.entries(authParams(pageToken))) url.searchParams.set(k, v);
  return send(url, { method: "GET", headers: { Accept: "application/json" } });
}

/** Lấy hết các trang (paging.next đã kèm token). */
async function getAll(path: string, params: Record<string, string>, maxPages = 20): Promise<any[]> {
  const out: any[] = [];
  let body = await get(path, params);
  for (let i = 0; i < maxPages; i++) {
    out.push(...(body?.data ?? []));
    const next = body?.paging?.next;
    if (!next) break;
    body = await get(next);
  }
  return out;
}

export type MetaAccount = {
  id: string; // không có tiền tố act_
  name: string;
  status: number; // 1 = ACTIVE
  disable_reason: number;
  cpas: boolean;
};

export const ACCOUNT_STATUS: Record<number, string> = {
  1: "đang hoạt động",
  2: "bị vô hiệu hóa",
  3: "nợ chưa thanh toán",
  7: "chờ xét duyệt rủi ro",
  8: "chờ thanh toán",
  9: "trong thời gian ân hạn",
  100: "chờ đóng",
  101: "đã đóng",
};

/**
 * Tài khoản theo dõi: META_AD_ACCOUNTS (id cách nhau bằng dấu phẩy) nếu có; không thì mọi tài khoản
 * token thấy được. Luôn bỏ BOSS TUYỀN 3/4/5/6.
 */
export async function listAccounts(): Promise<MetaAccount[]> {
  const only = (process.env.META_AD_ACCOUNTS ?? "")
    .split(",")
    .map((s) => s.trim().replace(/^act_/, ""))
    .filter(Boolean);
  const cpasIds = new Set(
    (process.env.FB_CPAS_ACCOUNTS ?? "").split(",").map((x) => x.trim().replace(/^act_/, "")).filter(Boolean)
  );
  const rows = await getAll("me/adaccounts", { fields: "account_id,name,account_status,disable_reason", limit: "100" });
  return rows
    .map((r) => ({
      id: String(r.account_id),
      name: String(r.name ?? r.account_id),
      status: Number(r.account_status ?? 0),
      disable_reason: Number(r.disable_reason ?? 0),
      // Không đoán theo tên: "CPAS SHOPEE MAGICKIDS" thực ra chạy quảng cáo Facebook (đặc tả Magickids).
      cpas: cpasIds.has(String(r.account_id)),
    }))
    .filter((a) => !EXCLUDED_ACCOUNTS.has(a.id) && (only.length === 0 || only.includes(a.id)));
}

async function post(id: string, params: Record<string, string>): Promise<any> {
  // Lệnh ghi không tự thử lại (tránh làm 2 lần).
  return send(new URL(`${GRAPH}/${id}`), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ ...params, ...authParams() }),
  });
}

export type AdState = {
  ad_id: string;
  effective_status: string;
  adset: { id: string; daily_budget: number | null; lifetime_budget: number | null };
  campaign: { id: string; daily_budget: number | null; lifetime_budget: number | null };
};

const numOrNull = (v: unknown) => (v == null || v === "" || Number(v) === 0 ? null : Number(v));

export async function adState(adId: string): Promise<AdState> {
  const r = await get(adId, {
    fields: "effective_status,adset{id,daily_budget,lifetime_budget},campaign{id,daily_budget,lifetime_budget}",
  });
  return {
    ad_id: adId,
    effective_status: String(r.effective_status ?? ""),
    adset: { id: String(r.adset?.id ?? ""), daily_budget: numOrNull(r.adset?.daily_budget), lifetime_budget: numOrNull(r.adset?.lifetime_budget) },
    campaign: {
      id: String(r.campaign?.id ?? ""),
      daily_budget: numOrNull(r.campaign?.daily_budget),
      lifetime_budget: numOrNull(r.campaign?.lifetime_budget),
    },
  };
}

/** Ngân sách ngày nằm ở nhóm quảng cáo (ABO) hay chiến dịch (CBO). Ngân sách trọn đời thì không tự tăng. */
export function budgetTarget(s: AdState): { level: "adset" | "campaign"; id: string; daily: number } | null {
  if (s.adset.daily_budget) return { level: "adset", id: s.adset.id, daily: s.adset.daily_budget };
  if (s.campaign.daily_budget) return { level: "campaign", id: s.campaign.id, daily: s.campaign.daily_budget };
  return null;
}

/** Ngân sách mới: tăng `step`, làm tròn nghìn đồng, không quá `maxIncrease` mỗi lần. */
export function scaledBudget(daily: number, step: number, maxIncrease: number): number {
  const inc = Math.min(daily * step, maxIncrease);
  return Math.round((daily + inc) / 1000) * 1000;
}

export async function pauseAd(adId: string): Promise<void> {
  await post(adId, { status: "PAUSED" });
}

export async function setDailyBudget(id: string, daily: number): Promise<void> {
  await post(id, { daily_budget: String(Math.round(daily)) });
}

export type MetaAdRow = {
  ad_id: string;
  ad_name: string | null;
  adset_name: string | null;
  campaign_name: string | null;
  spend: number;
  purchases: number;
  purchase_value: number;
};

const PURCHASE_TYPES = ["omni_purchase", "purchase", "offsite_conversion.fb_pixel_purchase"];

/** Lấy số mua theo thứ tự ưu tiên (tránh cộng trùng các loại cùng nghĩa). */
export function pickPurchase(list: any[] | undefined): number {
  if (!Array.isArray(list)) return 0;
  for (const t of PURCHASE_TYPES) {
    const hit = list.find((x) => x?.action_type === t);
    if (hit) return Number(hit.value ?? 0) || 0;
  }
  return 0;
}

/** Số theo từng quảng cáo của một tài khoản trong một ngày (giờ theo múi giờ tài khoản). */
export async function adInsights(accountId: string, day: string): Promise<MetaAdRow[]> {
  const rows = await getAll(`act_${accountId}/insights`, {
    level: "ad",
    fields: "ad_id,ad_name,adset_name,campaign_name,spend,actions,action_values",
    time_range: JSON.stringify({ since: day, until: day }),
    limit: "500",
  });
  return rows
    .map((r) => ({
      ad_id: String(r.ad_id),
      ad_name: r.ad_name ?? null,
      adset_name: r.adset_name ?? null,
      campaign_name: r.campaign_name ?? null,
      spend: Math.round(Number(r.spend ?? 0)),
      purchases: pickPurchase(r.actions),
      purchase_value: Math.round(pickPurchase(r.action_values)),
    }))
    .filter((r) => r.spend > 0 || r.purchases > 0);
}

/** Loại hành động "bắt đầu cuộc trò chuyện" (quảng cáo tin nhắn / CTX). */
export const MESSAGE_ACTION = "onsite_conversion.messaging_conversation_started_7d";

export type MetaRangeRow = {
  account_id: string;
  ad_id: string;
  ad_name: string | null;
  adset_id: string | null;
  adset_name: string | null;
  campaign_id: string | null;
  campaign_name: string | null;
  spend: number;
  messages: number;
};

/** Số theo từng quảng cáo của một tài khoản, cộng dồn cả khoảng ngày (giờ theo múi giờ tài khoản). Chỉ đọc. */
export async function adInsightsRange(accountId: string, since: string, until: string): Promise<MetaRangeRow[]> {
  const rows = await getAll(`act_${accountId}/insights`, {
    level: "ad",
    fields: "ad_id,ad_name,adset_id,adset_name,campaign_id,campaign_name,spend,actions",
    time_range: JSON.stringify({ since, until }),
    limit: "500",
  });
  return rows
    .map((r) => ({
      account_id: accountId,
      ad_id: String(r.ad_id),
      ad_name: r.ad_name ?? null,
      adset_id: r.adset_id ? String(r.adset_id) : null,
      adset_name: r.adset_name ?? null,
      campaign_id: r.campaign_id ? String(r.campaign_id) : null,
      campaign_name: r.campaign_name ?? null,
      spend: Math.round(Number(r.spend ?? 0)),
      messages: Number((r.actions ?? []).find((a: any) => a?.action_type === MESSAGE_ACTION)?.value ?? 0) || 0,
    }))
    .filter((r) => r.spend > 0 || r.messages > 0);
}

export type AdInfo = {
  ad_id: string;
  status: string; // effective_status của quảng cáo
  adset_status: string;
  campaign_status: string;
  adset_daily: number | null;
  campaign_daily: number | null;
  page_id: string | null;
  /** Bài gốc của quảng cáo, dạng `pageId_postId`. */
  story_id: string | null;
};

/** Trạng thái, ngân sách ngày (nhóm / chiến dịch) và page của các quảng cáo, gọi theo lô 50 id. Chỉ đọc. */
export async function adsInfo(ids: string[]): Promise<Map<string, AdInfo>> {
  const out = new Map<string, AdInfo>();
  const fields =
    "effective_status,adset{effective_status,daily_budget},campaign{effective_status,daily_budget},creative{effective_object_story_id,object_story_spec{page_id}}";
  const batches: string[][] = [];
  for (let i = 0; i < ids.length; i += 50) batches.push(ids.slice(i, i + 50));
  await Promise.all(
    batches.map(async (b) => {
      const body = await get("", { ids: b.join(","), fields });
      for (const id of b) {
        const r = body?.[id];
        if (!r) continue;
        const story = String(r.creative?.effective_object_story_id ?? "");
        out.set(id, {
          ad_id: id,
          status: String(r.effective_status ?? ""),
          adset_status: String(r.adset?.effective_status ?? ""),
          campaign_status: String(r.campaign?.effective_status ?? ""),
          adset_daily: numOrNull(r.adset?.daily_budget),
          campaign_daily: numOrNull(r.campaign?.daily_budget),
          story_id: story || null,
          page_id: r.creative?.object_story_spec?.page_id ? String(r.creative.object_story_spec.page_id) : story.includes("_") ? story.split("_")[0] : null,
        });
      }
    })
  );
  return out;
}

export type PagePost = {
  id: string; // pageId_postId
  message: string;
  created_time: string;
  picture: string | null;
  permalink: string | null;
  kind: string; // added_video, added_photos, ...
};

/** Bài và reel đã đăng của page trong `days` ngày gần nhất (đọc bằng token của page). Chỉ đọc. */
export async function pagePosts(pageId: string, days = 30): Promise<PagePost[]> {
  const page = await get(pageId, { fields: "access_token" });
  const pageToken = page?.access_token ? String(page.access_token) : undefined;
  if (!pageToken) throw new MetaError("Token hệ thống chưa được gán quyền page này");
  const out: PagePost[] = [];
  let body = await get(
    `${pageId}/published_posts`,
    { fields: "id,message,created_time,full_picture,permalink_url,status_type", since: String(Math.floor(Date.now() / 1000) - days * 86_400), limit: "100" },
    pageToken
  );
  for (let i = 0; i < 10; i++) {
    for (const r of body?.data ?? []) {
      out.push({
        id: String(r.id),
        message: String(r.message ?? ""),
        created_time: String(r.created_time ?? ""),
        picture: r.full_picture ?? null,
        permalink: r.permalink_url ?? null,
        kind: String(r.status_type ?? ""),
      });
    }
    const next = body?.paging?.next;
    if (!next) break;
    body = await get(next, {}, pageToken);
  }
  return out;
}

/** Lệnh tạo trên Meta (chỉ FB Magic Tool gọi, sau khi anh bấm xác nhận). Không tự thử lại. Trả id đối tượng mới. */
export async function createObject(accountId: string, edge: "campaigns" | "adsets" | "adcreatives" | "ads", params: Record<string, string>): Promise<string> {
  const r = await post(`act_${accountId}/${edge}`, params);
  if (!r?.id) throw new MetaError(`Meta không trả id khi tạo ${edge}`);
  return String(r.id);
}
