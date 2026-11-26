import { createHmac } from "node:crypto";
import { db } from "../supabase";
import { decryptToken, encryptToken } from "../token-crypto";

/**
 * Client cho TikTok Shop Open API (app "Magickids Gateway", Partner Center, thị trường Việt Nam).
 * Biến môi trường (chỉ máy chủ):
 *   TIKTOK_APP_KEY      App key của app
 *   TIKTOK_APP_SECRET   App secret của app
 *   TIKTOK_SERVICE_ID   ID app (service_id) để dựng link ủy quyền; hoặc
 *   TIKTOK_AUTH_URL     link ủy quyền copy nguyên từ Partner Center (ưu tiên nếu có)
 *
 * Ký (TikTok Shop API v2): lấy mọi query trừ sign và access_token, xếp theo tên,
 * nối {key}{value}, đặt sau path; nếu body không phải multipart thì nối thêm body;
 * bọc app_secret hai đầu rồi HMAC-SHA256 bằng app_secret, ra hex.
 */

const API_HOST = "https://open-api.tiktokglobalshop.com";
const AUTH_HOST = "https://auth.tiktok-shops.com";

export class TikTokConfigError extends Error {}

export function tiktokConfigured(): boolean {
  return !!process.env.TIKTOK_APP_KEY && !!process.env.TIKTOK_APP_SECRET;
}

export function tiktokConfig(): { appKey: string; appSecret: string } {
  const appKey = process.env.TIKTOK_APP_KEY;
  const appSecret = process.env.TIKTOK_APP_SECRET;
  if (!appKey || !appSecret) throw new TikTokConfigError("TikTok Shop chưa cấu hình: thiếu TIKTOK_APP_KEY / TIKTOK_APP_SECRET.");
  return { appKey, appSecret };
}

/** Link ủy quyền (Partner Center → App → Copy authorization link), kèm state để chống giả mạo. */
export function authorizationUrl(state: string): string {
  const custom = process.env.TIKTOK_AUTH_URL?.trim();
  const serviceId = process.env.TIKTOK_SERVICE_ID?.trim();
  if (!custom && !serviceId) throw new TikTokConfigError("Thiếu TIKTOK_AUTH_URL hoặc TIKTOK_SERVICE_ID.");
  const url = new URL(custom || "https://services.tiktokshop.com/open/authorize");
  if (!custom) url.searchParams.set("service_id", serviceId!);
  url.searchParams.set("state", state);
  return url.toString();
}

export function signRequest(path: string, query: Record<string, string>, body: string, secret: string): string {
  const keys = Object.keys(query)
    .filter((k) => k !== "sign" && k !== "access_token")
    .sort();
  const base = path + keys.map((k) => `${k}${query[k]}`).join("") + body;
  return createHmac("sha256", secret).update(secret + base + secret).digest("hex");
}

export class TikTokApiError extends Error {
  constructor(
    readonly path: string,
    readonly status: number,
    readonly data: Record<string, unknown>
  ) {
    super(`TikTok ${path} lỗi (HTTP ${status}): ${JSON.stringify(data)}`);
  }
}

export type HttpMethod = "GET" | "POST" | "PUT" | "DELETE";
type Query = Record<string, string | number | boolean | Array<string | number> | undefined>;

function flatQuery(q: Query): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(q)) {
    if (v === undefined || v === null) continue;
    out[k] = Array.isArray(v) ? v.join(",") : String(v);
  }
  return out;
}

/** Gọi một API (đã có access token). `shopCipher` cần cho API cấp shop. */
export async function rawCall(opts: {
  path: string;
  method: HttpMethod;
  query?: Query;
  body?: unknown;
  accessToken?: string;
  shopCipher?: string;
}): Promise<Record<string, unknown>> {
  const { appKey, appSecret } = tiktokConfig();
  const path = opts.path.startsWith("/") ? opts.path : `/${opts.path}`;
  const query = flatQuery({
    ...(opts.query ?? {}),
    app_key: appKey,
    timestamp: Math.floor(Date.now() / 1000),
    ...(opts.shopCipher ? { shop_cipher: opts.shopCipher } : {}),
  });
  const bodyText = opts.body === undefined || opts.method === "GET" ? "" : JSON.stringify(opts.body);
  query.sign = signRequest(path, query, bodyText, appSecret);

  const url = new URL(API_HOST + path);
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.accessToken) headers["x-tts-access-token"] = opts.accessToken;

  const res = await fetch(url, { method: opts.method, headers, ...(bodyText ? { body: bodyText } : {}) });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok || (data.code !== undefined && data.code !== 0)) throw new TikTokApiError(path, res.status, data);
  return data;
}

// ---------------------------------------------------------------------------
// Token
// ---------------------------------------------------------------------------

interface TokenData {
  access_token: string;
  access_token_expire_in: number; // unix giây
  refresh_token: string;
  refresh_token_expire_in: number;
  open_id: string;
  seller_name?: string;
  seller_base_region?: string;
  user_type?: number;
  granted_scopes?: string[];
}

async function tokenRequest(path: string, params: Record<string, string>): Promise<TokenData> {
  const { appKey, appSecret } = tiktokConfig();
  const url = new URL(AUTH_HOST + path);
  url.searchParams.set("app_key", appKey);
  url.searchParams.set("app_secret", appSecret);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url);
  const data = (await res.json().catch(() => ({}))) as { code?: number; message?: string; data?: TokenData };
  if (!res.ok || data.code !== 0 || !data.data?.access_token) {
    throw new TikTokApiError(path, res.status, data as Record<string, unknown>);
  }
  return data.data;
}

async function storeToken(t: TokenData, extra: Record<string, unknown> = {}) {
  const row = {
    open_id: t.open_id,
    // Phản hồi làm mới token có thể thiếu các trường này: chỉ ghi khi có để không đè mất.
    ...(t.user_type !== undefined ? { user_type: Number(t.user_type) } : {}),
    ...(t.seller_name ? { seller_name: t.seller_name } : {}),
    ...(t.seller_base_region ? { region: t.seller_base_region } : {}),
    access_token: encryptToken(t.access_token),
    refresh_token: encryptToken(t.refresh_token),
    access_expire_at: Number(t.access_token_expire_in) * 1000 - 60_000,
    refresh_expire_at: Number(t.refresh_token_expire_in) * 1000,
    ...(t.granted_scopes ? { scopes: t.granted_scopes } : {}),
    updated_at: new Date().toISOString(),
    ...extra,
  };
  const { error } = await db().from("tiktok_accounts").upsert(row);
  if (error) throw new Error(`Không lưu được token TikTok: ${error.message}`);
}

export interface TikTokShop {
  id: string;
  name: string;
  region: string;
  cipher: string;
  code?: string;
  seller_type?: string;
}

/** Đổi auth_code lấy token, lưu lại; với tài khoản Seller thì lấy luôn danh sách shop (shop_cipher). */
export async function exchangeCode(authCode: string): Promise<{ open_id: string; name: string; user_type: number; shops: TikTokShop[] }> {
  const t = await tokenRequest("/api/v2/token/get", { auth_code: authCode, grant_type: "authorized_code" });
  await storeToken(t);
  let shops: TikTokShop[] = [];
  if (Number(t.user_type ?? 0) === 0) {
    shops = await fetchShops(t.access_token);
    await db().from("tiktok_accounts").update({ shops }).eq("open_id", t.open_id);
  }
  return { open_id: t.open_id, name: t.seller_name ?? t.open_id, user_type: Number(t.user_type ?? 0), shops };
}

async function fetchShops(accessToken: string): Promise<TikTokShop[]> {
  const r = await rawCall({ path: "/authorization/202309/shops", method: "GET", accessToken });
  const list = ((r.data as { shops?: TikTokShop[] } | undefined)?.shops ?? []) as TikTokShop[];
  return list.map((s) => ({ id: String(s.id), name: s.name, region: s.region, cipher: s.cipher, code: s.code, seller_type: s.seller_type }));
}

export interface TikTokAccount {
  open_id: string;
  user_type: number;
  seller_name: string | null;
  region: string | null;
  shops: TikTokShop[] | null;
  scopes: string[] | null;
  access_expire_at: number;
  refresh_expire_at: number | null;
  updated_at: string;
}

export async function listAccounts(): Promise<TikTokAccount[]> {
  const { data, error } = await db()
    .from("tiktok_accounts")
    .select("open_id, user_type, seller_name, region, shops, scopes, access_expire_at, refresh_expire_at, updated_at")
    .order("updated_at", { ascending: false });
  if (error) throw new Error(error.message);
  return (data ?? []) as TikTokAccount[];
}

/** Access token còn hạn; hết hạn thì làm mới (khóa dòng để hai yêu cầu không cùng làm mới). */
export async function accessTokenFor(openId: string): Promise<string> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const { data, error } = await db()
      .from("tiktok_accounts")
      .select("access_token, refresh_token, access_expire_at")
      .eq("open_id", openId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) throw new TikTokConfigError(`Tài khoản TikTok ${openId} chưa ủy quyền.`);
    if (Number(data.access_expire_at) > Date.now()) return decryptToken(data.access_token);

    const now = new Date();
    const { data: locked } = await db()
      .from("tiktok_accounts")
      .update({ refresh_lock_until: new Date(now.getTime() + 30_000).toISOString() })
      .eq("open_id", openId)
      .or(`refresh_lock_until.is.null,refresh_lock_until.lt.${now.toISOString()}`)
      .select("open_id");
    if (!locked?.length) {
      await new Promise((r) => setTimeout(r, 1000));
      continue;
    }
    try {
      const t = await tokenRequest("/api/v2/token/refresh", {
        refresh_token: decryptToken(data.refresh_token),
        grant_type: "refresh_token",
      });
      await storeToken({ ...t, open_id: openId }, { refresh_lock_until: null });
      return t.access_token;
    } finally {
      await db()
        .from("tiktok_accounts")
        .update({ refresh_lock_until: null })
        .eq("open_id", openId)
        .then(undefined, () => undefined);
    }
  }
  throw new Error("Hết thời gian chờ làm mới token TikTok.");
}

/**
 * Chọn tài khoản + shop để gọi. shop = id, tên hoặc mã shop; bỏ trống khi chỉ có một shop.
 * creator=true chọn tài khoản Creator (kênh TikTok) thay cho shop.
 */
export async function resolveTarget(opts: { shop?: string; creator?: boolean }): Promise<{ openId: string; shop?: TikTokShop }> {
  const accounts = await listAccounts();
  if (opts.creator) {
    const creators = accounts.filter((a) => a.user_type === 1);
    if (!creators.length) throw new TikTokConfigError("Chưa có kênh TikTok (Creator) nào ủy quyền.");
    return { openId: creators[0].open_id };
  }
  const pairs = accounts
    .filter((a) => a.user_type === 0)
    .flatMap((a) => (a.shops ?? []).map((s) => ({ openId: a.open_id, shop: s })));
  if (!pairs.length) throw new TikTokConfigError("Chưa có shop TikTok nào ủy quyền. Vào /admin/tiktok để ủy quyền.");
  if (!opts.shop) {
    if (pairs.length === 1) return pairs[0];
    throw new TikTokConfigError(`Có ${pairs.length} shop, cần chọn shop: ${pairs.map((p) => `${p.shop.name} (${p.shop.id})`).join(", ")}.`);
  }
  const q = opts.shop.toLowerCase();
  const hit = pairs.find((p) => p.shop.id === opts.shop || p.shop.code === opts.shop || p.shop.name.toLowerCase() === q);
  if (!hit) throw new TikTokConfigError(`Không thấy shop "${opts.shop}" trong các shop đã ủy quyền.`);
  return hit;
}

/** Gọi API cho shop/kênh đã ủy quyền. API cấp shop tự gắn shop_cipher; API /authorization, /seller và creator thì không. */
export async function tiktokCall(opts: {
  path: string;
  method: HttpMethod;
  query?: Query;
  body?: unknown;
  shop?: string;
  creator?: boolean;
}): Promise<{ shop?: string; result: Record<string, unknown> }> {
  const target = await resolveTarget({ shop: opts.shop, creator: opts.creator });
  const accessToken = await accessTokenFor(target.openId);
  const noCipher = opts.creator || /^\/?(authorization|seller|affiliate_creator)\//.test(opts.path);
  const result = await rawCall({
    path: opts.path,
    method: opts.method,
    query: opts.query,
    body: opts.body,
    accessToken,
    shopCipher: noCipher ? undefined : target.shop?.cipher,
  });
  return { shop: target.shop ? `${target.shop.name} (${target.shop.id})` : undefined, result };
}

/**
 * API "chỉ đọc": GET, hoặc POST tra cứu (search / query / list / precheck / performance...).
 * TikTok dùng POST cho nhiều API tìm kiếm nên không thể chỉ dựa vào method.
 */
export function isReadOnly(method: HttpMethod, path: string): boolean {
  if (method === "GET") return true;
  if (method !== "POST") return false;
  return /\/(search|query|list|precheck|performance|calculate|check)[a-z_]*($|\/)|_search$|\/search_/.test(path.toLowerCase());
}
