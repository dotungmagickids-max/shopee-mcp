import { createHash, createHmac } from "node:crypto";
import { db } from "../supabase";
import { decryptToken, encryptToken } from "../token-crypto";

/**
 * Client for the separate "Magickids Video" Open Platform app (category
 * Shopee Video Management). Configured by:
 *   SHOPEE_VIDEO_ENV          test | live (default test until Shopee approves Go-Live)
 *   SHOPEE_VIDEO_PARTNER_ID   partner_id of that environment
 *   SHOPEE_VIDEO_PARTNER_KEY  partner key of that environment
 *
 * Signatures (Shopee v2):
 *   Public (media.*, auth.*): HMAC(partner_id + path + timestamp)
 *   User   (video.*):         HMAC(partner_id + path + timestamp + access_token + user_id)
 */

export type VideoEnv = "test" | "live";

const HOSTS: Record<VideoEnv, { api: string; auth: string }> = {
  test: {
    api: "https://openplatform.sandbox.test-stable.shopee.sg",
    auth: "https://open.sandbox.test-stable.shopee.com/auth",
  },
  live: { api: "https://partner.shopeemobile.com", auth: "https://open.shopee.com/auth" },
};

export class VideoConfigError extends Error {}

export interface VideoConfig {
  env: VideoEnv;
  partnerId: number;
  partnerKey: string;
}

export function videoConfig(): VideoConfig {
  const env: VideoEnv = process.env.SHOPEE_VIDEO_ENV === "live" ? "live" : "test";
  const id = process.env.SHOPEE_VIDEO_PARTNER_ID;
  const key = process.env.SHOPEE_VIDEO_PARTNER_KEY;
  if (!id || !key) {
    throw new VideoConfigError("Shopee Video chưa cấu hình: thiếu SHOPEE_VIDEO_PARTNER_ID / SHOPEE_VIDEO_PARTNER_KEY.");
  }
  return { env, partnerId: Number(id), partnerKey: key };
}

export function videoConfigured(): boolean {
  return !!process.env.SHOPEE_VIDEO_PARTNER_ID && !!process.env.SHOPEE_VIDEO_PARTNER_KEY;
}

const hmac = (key: string, base: string) => createHmac("sha256", key).update(base).digest("hex");
export const md5 = (b: Buffer) => createHash("md5").update(b).digest("hex");

export class ShopeeVideoApiError extends Error {
  constructor(
    readonly path: string,
    readonly status: number,
    readonly data: Record<string, unknown>
  ) {
    super(`Shopee ${path} lỗi (HTTP ${status}): ${JSON.stringify(data)}`);
  }
}

type Fields = Record<string, unknown>;

function isFileField(v: unknown): boolean {
  return Buffer.isBuffer(v);
}

async function send(
  cfg: VideoConfig,
  path: string,
  method: "GET" | "POST",
  fields: Fields,
  user?: { userId: number; accessToken: string }
): Promise<Record<string, unknown>> {
  const apiPath = `/api/v2${path}`;
  const url = new URL(`${HOSTS[cfg.env].api}${apiPath}`);
  const ts = Math.floor(Date.now() / 1000);
  const base = user
    ? `${cfg.partnerId}${apiPath}${ts}${user.accessToken}${user.userId}`
    : `${cfg.partnerId}${apiPath}${ts}`;
  url.searchParams.set("partner_id", String(cfg.partnerId));
  url.searchParams.set("timestamp", String(ts));
  if (user) {
    url.searchParams.set("access_token", user.accessToken);
    url.searchParams.set("user_id", String(user.userId));
  }
  url.searchParams.set("sign", hmac(cfg.partnerKey, base));

  const init: RequestInit = { method };
  if (method === "GET") {
    for (const [k, v] of Object.entries(fields)) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
  } else if (Object.values(fields).some(isFileField)) {
    const form = new FormData();
    for (const [k, v] of Object.entries(fields)) {
      if (v === undefined) continue;
      if (Buffer.isBuffer(v)) form.append(k, new Blob([new Uint8Array(v)], { type: "application/octet-stream" }), `${k}.bin`);
      else form.append(k, typeof v === "object" ? JSON.stringify(v) : String(v));
    }
    init.body = form;
  } else {
    init.body = JSON.stringify(fields);
    init.headers = { "Content-Type": "application/json" };
  }

  const res = await fetch(url, init);
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok || (typeof data.error === "string" && data.error)) {
    throw new ShopeeVideoApiError(path, res.status, data);
  }
  return data;
}

/** Public API (media.*): partner signature only. */
export function publicCall(path: string, method: "GET" | "POST", fields: Fields = {}) {
  return send(videoConfig(), path, method, fields);
}

// ---------------------------------------------------------------------------
// Authorization (user level)
// ---------------------------------------------------------------------------

export function authorizationUrl(redirectUri: string): string {
  const cfg = videoConfig();
  const url = new URL(HOSTS[cfg.env].auth);
  url.searchParams.set("partner_id", String(cfg.partnerId));
  url.searchParams.set("auth_type", "seller");
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  return url.toString();
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expire_in?: number;
  user_id_list?: number[];
  user_id?: number;
}

async function storeToken(env: VideoEnv, userId: number, t: TokenResponse, label?: string | null) {
  const { error } = await db()
    .from("video_users")
    .upsert({
      env,
      user_id: userId,
      access_token: encryptToken(String(t.access_token)),
      refresh_token: encryptToken(String(t.refresh_token)),
      expired_at: Date.now() + Number(t.expire_in ?? 0) * 1000 - 60_000,
      ...(label !== undefined ? { label } : {}),
      updated_at: new Date().toISOString(),
    });
  if (error) throw new Error(`Không lưu được token Shopee Video: ${error.message}`);
}

/** Exchanges the code from the redirect; returns the authorized user_ids. */
export async function exchangeCode(
  code: string,
  extra: { shop_id?: number; main_account_id?: number; user_id?: number }
): Promise<number[]> {
  const cfg = videoConfig();
  const t = (await send(cfg, "/auth/token/get", "POST", {
    code,
    partner_id: cfg.partnerId,
    ...(extra.shop_id ? { shop_id: extra.shop_id } : {}),
    ...(extra.main_account_id ? { main_account_id: extra.main_account_id } : {}),
  })) as TokenResponse;
  const userIds = (t.user_id_list?.length ? t.user_id_list : extra.user_id ? [extra.user_id] : []).map(Number);
  if (!userIds.length) {
    throw new Error(`Shopee không trả user_id nào (trả về: ${Object.keys(t).join(", ")}).`);
  }
  for (const id of userIds) await storeToken(cfg.env, id, t);
  return userIds;
}

export interface VideoUser {
  env: VideoEnv;
  user_id: number;
  label: string | null;
  expired_at: number;
  updated_at: string;
}

export async function listVideoUsers(): Promise<VideoUser[]> {
  const { env } = videoConfig();
  const { data, error } = await db()
    .from("video_users")
    .select("env, user_id, label, expired_at, updated_at")
    .eq("env", env)
    .order("updated_at", { ascending: false });
  if (error) throw new Error(error.message);
  return (data ?? []) as VideoUser[];
}

/** Returns a valid access token, refreshing (single-use refresh tokens, so under a row lock). */
async function accessTokenFor(cfg: VideoConfig, userId: number): Promise<string> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const { data, error } = await db()
      .from("video_users")
      .select("access_token, refresh_token, expired_at, refresh_lock_until")
      .eq("env", cfg.env)
      .eq("user_id", userId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) throw new VideoConfigError(`Tài khoản Shopee Video ${userId} chưa ủy quyền (môi trường ${cfg.env}).`);
    if (Number(data.expired_at) > Date.now()) return decryptToken(data.access_token);

    const now = new Date();
    const { data: locked } = await db()
      .from("video_users")
      .update({ refresh_lock_until: new Date(now.getTime() + 30_000).toISOString() })
      .eq("env", cfg.env)
      .eq("user_id", userId)
      .or(`refresh_lock_until.is.null,refresh_lock_until.lt.${now.toISOString()}`)
      .select("user_id");
    if (!locked?.length) {
      await new Promise((r) => setTimeout(r, 1000));
      continue;
    }
    try {
      const t = (await send(cfg, "/auth/access_token/get", "POST", {
        partner_id: cfg.partnerId,
        refresh_token: decryptToken(data.refresh_token),
        user_id: userId,
      })) as TokenResponse;
      await storeToken(cfg.env, userId, t);
      return String(t.access_token);
    } finally {
      await db()
        .from("video_users")
        .update({ refresh_lock_until: null })
        .eq("env", cfg.env)
        .eq("user_id", userId)
        .then(undefined, () => undefined);
    }
  }
  throw new Error("Hết thời gian chờ làm mới token Shopee Video.");
}

/** User API (video.*). */
export async function userCall(userId: number, path: string, method: "GET" | "POST", fields: Fields = {}) {
  const cfg = videoConfig();
  const accessToken = await accessTokenFor(cfg, userId);
  return send(cfg, path, method, fields, { userId, accessToken });
}

/** The single authorized user when there is exactly one; otherwise the caller must pick. */
export async function resolveVideoUser(userId?: number): Promise<number> {
  if (userId) return userId;
  const users = await listVideoUsers();
  if (users.length === 1) return Number(users[0].user_id);
  if (!users.length) throw new VideoConfigError("Chưa có tài khoản Shopee Video nào ủy quyền. Vào /video để ủy quyền.");
  throw new VideoConfigError(`Có ${users.length} tài khoản Shopee Video, cần chọn user_id: ${users.map((u) => u.user_id).join(", ")}.`);
}
