/**
 * Đọc Meta Marketing API bằng token System User (META_SYSTEM_TOKEN). Chỉ đọc.
 * Không bao giờ đưa URL (chứa token) vào thông báo lỗi.
 */

const GRAPH = "https://graph.facebook.com/v21.0";

/** Tài khoản không tính khi báo cáo (anh chốt): BOSS TUYỀN 3, 4, 5, 6. */
export const EXCLUDED_ACCOUNTS = new Set(["263854262635122", "1221559028478456", "203632012307325", "242962362083925"]);

export class MetaError extends Error {}

function token(): string {
  const t = process.env.META_SYSTEM_TOKEN?.trim();
  if (!t) throw new MetaError("Chưa đặt META_SYSTEM_TOKEN");
  return t;
}

async function get(pathOrUrl: string, params: Record<string, string> = {}): Promise<any> {
  const url = pathOrUrl.startsWith("http")
    ? new URL(pathOrUrl)
    : new URL(`${GRAPH}/${pathOrUrl.replace(/^\//, "")}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  if (!url.searchParams.has("access_token")) url.searchParams.set("access_token", token());
  const res = await fetch(url, { headers: { Accept: "application/json" } }).catch(() => null);
  if (!res) throw new MetaError("Meta API: không kết nối được");
  const body: any = await res.json().catch(() => null);
  if (!res.ok || body?.error) {
    const e = body?.error;
    throw new MetaError(`Meta API ${res.status}: ${String(e?.message ?? "lỗi").slice(0, 200)}${e?.code ? ` (mã ${e.code})` : ""}`);
  }
  return body;
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
  const rows = await getAll("me/adaccounts", { fields: "account_id,name,account_status,disable_reason", limit: "100" });
  return rows
    .map((r) => ({
      id: String(r.account_id),
      name: String(r.name ?? r.account_id),
      status: Number(r.account_status ?? 0),
      disable_reason: Number(r.disable_reason ?? 0),
      cpas: /cpas/i.test(String(r.name ?? "")),
    }))
    .filter((a) => !EXCLUDED_ACCOUNTS.has(a.id) && (only.length === 0 || only.includes(a.id)));
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
