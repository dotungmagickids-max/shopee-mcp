import { db } from "../supabase";
import { decryptToken, encryptToken } from "../token-crypto";

/**
 * TikTok Content Posting API (app "Magickids Content", developers.tiktok.com).
 * Chỉ dùng "Upload to TikTok": video vào hộp nháp của kênh, người dùng mở app TikTok
 * để gắn sản phẩm và đăng. Biến môi trường (chỉ máy chủ):
 *   TIKTOK_CONTENT_CLIENT_KEY, TIKTOK_CONTENT_CLIENT_SECRET
 */

const OPEN = "https://open.tiktokapis.com";
export const CONTENT_SCOPES = "user.info.basic,video.upload";

export class ContentConfigError extends Error {}

export function contentConfigured(): boolean {
  return !!process.env.TIKTOK_CONTENT_CLIENT_KEY && !!process.env.TIKTOK_CONTENT_CLIENT_SECRET;
}

function cfg() {
  const key = process.env.TIKTOK_CONTENT_CLIENT_KEY;
  const secret = process.env.TIKTOK_CONTENT_CLIENT_SECRET;
  if (!key || !secret) throw new ContentConfigError("Chưa cấu hình TIKTOK_CONTENT_CLIENT_KEY / TIKTOK_CONTENT_CLIENT_SECRET.");
  return { key, secret };
}

export function contentAuthUrl(redirectUri: string, state: string): string {
  const url = new URL("https://www.tiktok.com/v2/auth/authorize/");
  url.searchParams.set("client_key", cfg().key);
  url.searchParams.set("scope", CONTENT_SCOPES);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("state", state);
  return url.toString();
}

interface TokenResp {
  access_token: string;
  expires_in: number;
  open_id: string;
  refresh_token: string;
  refresh_expires_in: number;
  scope?: string;
}

async function tokenCall(params: Record<string, string>): Promise<TokenResp> {
  const { key, secret } = cfg();
  const res = await fetch(`${OPEN}/v2/oauth/token/`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_key: key, client_secret: secret, ...params }),
  });
  const data = (await res.json().catch(() => ({}))) as Partial<TokenResp> & { error?: string; error_description?: string };
  if (!res.ok || !data.access_token) throw new Error(`TikTok token lỗi: ${data.error ?? res.status} ${data.error_description ?? ""}`.trim());
  return data as TokenResp;
}

async function store(t: TokenResp, extra: Record<string, unknown> = {}) {
  const now = Date.now();
  const { error } = await db()
    .from("tiktok_content_users")
    .upsert({
      open_id: t.open_id,
      access_token: encryptToken(t.access_token),
      refresh_token: encryptToken(t.refresh_token),
      access_expire_at: now + Number(t.expires_in) * 1000 - 60_000,
      refresh_expire_at: now + Number(t.refresh_expires_in) * 1000,
      ...(t.scope ? { scopes: t.scope } : {}),
      updated_at: new Date().toISOString(),
      ...extra,
    });
  if (error) throw new Error(`Không lưu được token kênh TikTok: ${error.message}`);
}

async function api(path: string, accessToken: string, init: { method?: string; body?: unknown } = {}) {
  const res = await fetch(`${OPEN}${path}`, {
    method: init.method ?? "POST",
    headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json; charset=UTF-8" },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
  const data = (await res.json().catch(() => ({}))) as { data?: Record<string, unknown>; error?: { code?: string; message?: string } };
  if (!res.ok || (data.error?.code && data.error.code !== "ok")) {
    throw new Error(`TikTok ${path} lỗi (HTTP ${res.status}): ${data.error?.code ?? ""} ${data.error?.message ?? ""}`.trim());
  }
  return data.data ?? {};
}

export async function exchangeContentCode(code: string, redirectUri: string): Promise<{ open_id: string; name: string }> {
  const t = await tokenCall({ code, grant_type: "authorization_code", redirect_uri: redirectUri });
  let name = t.open_id;
  let avatar: string | null = null;
  try {
    const info = (await api("/v2/user/info/?fields=open_id,display_name,avatar_url", t.access_token, { method: "GET" })) as {
      user?: { display_name?: string; avatar_url?: string };
    };
    name = info.user?.display_name || name;
    avatar = info.user?.avatar_url ?? null;
  } catch {
    // Không lấy được tên thì vẫn lưu token.
  }
  await store(t, { display_name: name, avatar_url: avatar });
  return { open_id: t.open_id, name };
}

export interface ContentUser {
  open_id: string;
  display_name: string | null;
  access_expire_at: number;
  refresh_expire_at: number | null;
  scopes: string | null;
}

export async function listContentUsers(): Promise<ContentUser[]> {
  const { data, error } = await db()
    .from("tiktok_content_users")
    .select("open_id, display_name, access_expire_at, refresh_expire_at, scopes")
    .order("updated_at", { ascending: false });
  if (error) throw new Error(error.message);
  return (data ?? []) as ContentUser[];
}

async function tokenFor(openId: string): Promise<string> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const { data, error } = await db()
      .from("tiktok_content_users")
      .select("access_token, refresh_token, access_expire_at")
      .eq("open_id", openId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) throw new ContentConfigError(`Kênh TikTok ${openId} chưa ủy quyền.`);
    if (Number(data.access_expire_at) > Date.now()) return decryptToken(data.access_token);
    const now = new Date();
    const { data: locked } = await db()
      .from("tiktok_content_users")
      .update({ refresh_lock_until: new Date(now.getTime() + 30_000).toISOString() })
      .eq("open_id", openId)
      .or(`refresh_lock_until.is.null,refresh_lock_until.lt.${now.toISOString()}`)
      .select("open_id");
    if (!locked?.length) {
      await new Promise((r) => setTimeout(r, 1000));
      continue;
    }
    try {
      const t = await tokenCall({ grant_type: "refresh_token", refresh_token: decryptToken(data.refresh_token) });
      await store({ ...t, open_id: openId }, { refresh_lock_until: null });
      return t.access_token;
    } finally {
      await db().from("tiktok_content_users").update({ refresh_lock_until: null }).eq("open_id", openId).then(undefined, () => undefined);
    }
  }
  throw new Error("Hết thời gian chờ làm mới token kênh TikTok.");
}

/** Kênh để đăng: open_id hoặc tên; bỏ trống khi chỉ có một kênh. */
export async function resolveContentUser(who?: string): Promise<ContentUser> {
  const users = await listContentUsers();
  if (!users.length) throw new ContentConfigError("Chưa có kênh TikTok nào ủy quyền đăng video. Vào /admin/tiktok để ủy quyền.");
  if (!who) {
    if (users.length === 1) return users[0];
    throw new ContentConfigError(`Có ${users.length} kênh, cần chọn: ${users.map((u) => u.display_name ?? u.open_id).join(", ")}.`);
  }
  const hit = users.find((u) => u.open_id === who || (u.display_name ?? "").toLowerCase() === who.toLowerCase());
  if (!hit) throw new ContentConfigError(`Không thấy kênh "${who}".`);
  return hit;
}

const MB = 1024 * 1024;

/** Chia khối theo quy định TikTok: video ≤ 64 MB gửi 1 khối; lớn hơn thì khối 10 MB, khối cuối gom phần dư. */
export function chunkPlan(size: number): { chunkSize: number; count: number } {
  if (size <= 64 * MB) return { chunkSize: size, count: 1 };
  const chunkSize = 10 * MB;
  return { chunkSize, count: Math.floor(size / chunkSize) };
}

/** Tải video từ URL công khai rồi đẩy vào hộp nháp của kênh. Trả publish_id. */
export async function uploadDraft(opts: { videoUrl: string; channel?: string; note?: string; createdBy?: string }) {
  const user = await resolveContentUser(opts.channel);
  const accessToken = await tokenFor(user.open_id);
  const src = await fetch(opts.videoUrl, { redirect: "follow" });
  if (!src.ok) throw new Error(`Không tải được video (HTTP ${src.status}). Link phải công khai và trỏ thẳng tới file.`);
  const type = src.headers.get("content-type") ?? "";
  if (type.includes("text/html")) throw new Error("Link trả về trang web chứ không phải file video. Dùng link tải trực tiếp.");
  const buf = Buffer.from(await src.arrayBuffer());
  if (buf.length > 1024 * MB) throw new Error("Video quá 1 GB.");
  const { chunkSize, count } = chunkPlan(buf.length);

  const init = (await api("/v2/post/publish/inbox/video/init/", accessToken, {
    body: { source_info: { source: "FILE_UPLOAD", video_size: buf.length, chunk_size: chunkSize, total_chunk_count: count } },
  })) as { publish_id?: string; upload_url?: string };
  if (!init.publish_id || !init.upload_url) throw new Error("TikTok không trả publish_id / upload_url.");

  for (let i = 0; i < count; i++) {
    const start = i * chunkSize;
    const end = i === count - 1 ? buf.length : start + chunkSize;
    const res = await fetch(init.upload_url, {
      method: "PUT",
      headers: {
        "content-type": type.startsWith("video/") ? type : "video/mp4",
        "content-length": String(end - start),
        "content-range": `bytes ${start}-${end - 1}/${buf.length}`,
      },
      body: new Uint8Array(buf.subarray(start, end)),
    });
    if (!res.ok) throw new Error(`Tải khối ${i + 1}/${count} lỗi (HTTP ${res.status}).`);
  }

  await db()
    .from("tiktok_content_jobs")
    .insert({
      open_id: user.open_id,
      publish_id: init.publish_id,
      source_url: opts.videoUrl,
      note: opts.note ?? null,
      status: "uploaded",
      detail: { size: buf.length, chunks: count },
      created_by: opts.createdBy ?? null,
    })
    .then(undefined, () => undefined);

  return { channel: user.display_name ?? user.open_id, publish_id: init.publish_id, size_mb: +(buf.length / MB).toFixed(1) };
}

export async function draftStatus(publishId: string, channel?: string) {
  const user = await resolveContentUser(channel);
  const accessToken = await tokenFor(user.open_id);
  return api("/v2/post/publish/status/fetch/", accessToken, { body: { publish_id: publishId } });
}
