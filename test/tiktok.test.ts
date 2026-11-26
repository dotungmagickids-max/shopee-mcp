/**
 * TikTok: ký request TikTok Shop, phân loại đọc/ghi, chia khối và luồng đẩy video vào nháp
 * (Content Posting API). Supabase REST, TikTok và nguồn video đều giả lập ở tầng fetch.
 */
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { beforeEach, describe, it } from "node:test";

process.env.SUPABASE_URL = "https://supabase.test";
process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role";
process.env.TIKTOK_APP_KEY = "app-key";
process.env.TIKTOK_APP_SECRET = "app-secret";
process.env.TIKTOK_CONTENT_CLIENT_KEY = "ck-test";
process.env.TIKTOK_CONTENT_CLIENT_SECRET = "cs-test";
delete process.env.TOKEN_ENC_KEY;

const { signRequest, isReadOnly, rawCall } = await import("../src/lib/tiktok/client");
const { chunkPlan, uploadMime, uploadDraft, draftStatus, contentAuthUrl } = await import("../src/lib/tiktok/content");

const MB = 1024 * 1024;
type Row = Record<string, unknown>;
let users: Row[];
let jobs: Row[];
let calls: { url: URL; method: string; headers: Headers; body: unknown }[];
let video: Buffer;
let videoType: string;

const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });

function match(rows: Row[], q: URLSearchParams) {
  return rows.filter((r) =>
    [...q.entries()].every(([k, v]) => (v.startsWith("eq.") ? String(r[k]) === v.slice(3) : true))
  );
}

async function fakeSupabase(url: URL, init: RequestInit) {
  const table = url.pathname.replace("/rest/v1/", "");
  const rows = ({ tiktok_content_users: users, tiktok_content_jobs: jobs } as Record<string, Row[]>)[table] ?? [];
  const method = init.method ?? "GET";
  const one = new Headers(init.headers).get("accept")?.includes("vnd.pgrst.object");
  if (method === "GET") {
    const found = match(rows, url.searchParams);
    return one ? (found[0] ? json(found[0]) : json(null)) : json(found);
  }
  const body = JSON.parse(String(init.body ?? "{}"));
  if (method === "POST") {
    for (const item of Array.isArray(body) ? body : [body]) {
      const i = table === "tiktok_content_users" ? rows.findIndex((r) => r.open_id === item.open_id) : -1;
      if (i >= 0) Object.assign(rows[i], item);
      else rows.push(item);
    }
    return new Response(null, { status: 201 });
  }
  if (method === "PATCH") {
    const found = match(rows, url.searchParams);
    found.forEach((r) => Object.assign(r, body));
    return json(found);
  }
  return new Response(null, { status: 204 });
}

let uploaded = 0;
globalThis.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  if (url.host === "supabase.test") return fakeSupabase(url, init);
  const headers = new Headers(init.headers);
  let body: unknown = init.body;
  if (typeof init.body === "string") body = headers.get("content-type")?.includes("json") ? JSON.parse(init.body) : init.body;
  else if (init.body instanceof URLSearchParams) body = Object.fromEntries(init.body);
  else if (init.body instanceof Uint8Array) body = init.body.byteLength;
  calls.push({ url, method: init.method ?? "GET", headers, body });

  if (url.host === "cdn.test") return new Response(new Uint8Array(video), { headers: { "content-type": videoType } });
  if (url.host === "open.tiktokapis.com") {
    switch (url.pathname) {
      case "/v2/oauth/token/":
        return json({ access_token: "at-new", expires_in: 7200, refresh_token: "rt-new", refresh_expires_in: 15552000, open_id: "oid-1", scope: "user.info.basic,video.upload", token_type: "Bearer" });
      case "/v2/post/publish/inbox/video/init/":
        uploaded = 0;
        return json({ data: { publish_id: "v_inbox_file~v2.1", upload_url: "https://open-upload.test/video/?upload_id=1" }, error: { code: "ok", message: "" } });
      case "/v2/post/publish/status/fetch/":
        return json({ data: { status: "SEND_TO_USER_INBOX", uploaded_bytes: 10 }, error: { code: "ok", message: "" } });
    }
  }
  if (url.host === "open-upload.test") {
    uploaded += Number(headers.get("content-length"));
    const total = Number(headers.get("content-range")!.split("/")[1]);
    return new Response(null, { status: uploaded >= total ? 201 : 206 });
  }
  if (url.host === "open-api.tiktokglobalshop.com") return json({ code: 0, message: "Success", data: { orders: [] } });
  return new Response("not found", { status: 404 });
}) as typeof fetch;

beforeEach(() => {
  users = [{ open_id: "oid-1", display_name: "Kênh Test", access_token: "at-1", refresh_token: "rt-1", access_expire_at: Date.now() + 3_600_000, refresh_expire_at: Date.now() + 86_400_000, scopes: "video.upload", updated_at: "2026-01-01" }];
  jobs = [];
  calls = [];
  video = Buffer.alloc(1000, 7);
  videoType = "video/mp4";
});

describe("TikTok Shop signRequest", () => {
  it("khớp ví dụ chính thức (partner.tiktokshop.com/docv2/page/sign-your-api-request)", () => {
    assert.equal(
      signRequest("/authorization/202309/shops", { app_key: "29a39d", timestamp: "1623812664" }, "", "e59af819cc"),
      "b596b73e0cc6de07ac26f036364178ab16b0a907af13d43f0a0cd2345f582dc8"
    );
  });

  it("nối path + query (bỏ sign, access_token; xếp theo tên) + body, bọc secret, HMAC-SHA256 hex", () => {
    const query = { timestamp: "1700000000", app_key: "app-key", shop_cipher: "C1", sign: "x", access_token: "tok", page_size: "10" };
    const body = '{"order_status":"UNPAID"}';
    const base = "/order/202309/orders/search" + "app_keyapp-key" + "page_size10" + "shop_cipherC1" + "timestamp1700000000" + body;
    const expected = createHmac("sha256", "secret").update("secret" + base + "secret").digest("hex");
    assert.equal(signRequest("/order/202309/orders/search", query, body, "secret"), expected);
    assert.match(expected, /^[0-9a-f]{64}$/);
  });

  it("sign và access_token không ảnh hưởng chữ ký; body thì có", () => {
    const a = signRequest("/p", { app_key: "k", timestamp: "1" }, "", "s");
    assert.equal(signRequest("/p", { timestamp: "1", app_key: "k", sign: "old", access_token: "t" }, "", "s"), a);
    assert.notEqual(signRequest("/p", { app_key: "k", timestamp: "1" }, "{}", "s"), a);
  });

  it("rawCall gắn app_key, timestamp, shop_cipher, sign hợp lệ và header x-tts-access-token", async () => {
    calls = [];
    await rawCall({ path: "/order/202309/orders/search", method: "POST", query: { page_size: 50 }, body: { create_time_ge: 1 }, accessToken: "tok", shopCipher: "C9" });
    const c = calls[0];
    assert.equal(c.headers.get("x-tts-access-token"), "tok");
    const q = Object.fromEntries(c.url.searchParams);
    assert.equal(q.app_key, "app-key");
    assert.equal(q.shop_cipher, "C9");
    assert.equal(q.access_token, undefined);
    assert.equal(q.sign, signRequest(c.url.pathname, q, JSON.stringify({ create_time_ge: 1 }), "app-secret"));
  });
});

describe("isReadOnly", () => {
  it("GET và POST tra cứu là đọc", () => {
    assert.equal(isReadOnly("GET", "/product/202309/products/123"), true);
    assert.equal(isReadOnly("POST", "/order/202309/orders/search"), true);
    assert.equal(isReadOnly("POST", "/product/202309/products/search"), true);
    assert.equal(isReadOnly("POST", "/product/202309/prerequisites/check"), true);
  });
  it("POST/PUT/DELETE thay đổi dữ liệu là ghi", () => {
    assert.equal(isReadOnly("POST", "/product/202309/products/123/prices/update"), false);
    assert.equal(isReadOnly("POST", "/product/202309/products/123/inventory/update"), false);
    assert.equal(isReadOnly("PUT", "/product/202309/products/123"), false);
    assert.equal(isReadOnly("DELETE", "/product/202309/products"), false);
    assert.equal(isReadOnly("POST", "/fulfillment/202309/packages/1/ship"), false);
  });
});

describe("chunkPlan (Media Transfer Guide)", () => {
  it("≤ 64 MB: một khối bằng cả file (dưới 5 MB bắt buộc)", () => {
    assert.deepEqual(chunkPlan(4 * MB), { chunkSize: 4 * MB, count: 1 });
    assert.deepEqual(chunkPlan(64 * MB), { chunkSize: 64 * MB, count: 1 });
  });
  it("> 64 MB: khối 5–64 MB, count = floor(size/chunk), khối cuối ≤ 128 MB, ≤ 1000 khối", () => {
    for (const size of [64 * MB + 1, 200 * MB + 123, 1024 * MB]) {
      const { chunkSize, count } = chunkPlan(size);
      assert.ok(chunkSize >= 5 * MB && chunkSize <= 64 * MB);
      assert.equal(count, Math.floor(size / chunkSize));
      assert.ok(count >= 2 && count <= 1000);
      const last = size - (count - 1) * chunkSize;
      assert.ok(last >= chunkSize && last <= 128 * MB);
    }
  });
});

describe("uploadMime", () => {
  it("chỉ mp4 / quicktime / webm", () => {
    assert.equal(uploadMime("video/mp4; charset=binary"), "video/mp4");
    assert.equal(uploadMime("video/webm"), "video/webm");
    assert.equal(uploadMime("application/octet-stream", "https://x/a.MOV?dl=1"), "video/quicktime");
    assert.equal(uploadMime("video/x-matroska", "https://x/a.mkv"), "video/mp4");
  });
});

describe("Content Posting: đẩy video vào nháp", () => {
  it("link ủy quyền đúng tham số Login Kit Web", () => {
    const u = new URL(contentAuthUrl("https://app.test/api/tiktok/content/callback", "st"));
    assert.equal(u.origin + u.pathname, "https://www.tiktok.com/v2/auth/authorize/");
    assert.equal(u.searchParams.get("client_key"), "ck-test");
    assert.equal(u.searchParams.get("scope"), "user.info.basic,video.upload");
    assert.equal(u.searchParams.get("response_type"), "code");
    assert.equal(u.searchParams.get("state"), "st");
  });

  it("video nhỏ: init FILE_UPLOAD một khối, PUT đủ header, ghi job", async () => {
    const r = await uploadDraft({ videoUrl: "https://cdn.test/v.mp4", note: "QD1" });
    assert.equal(r.publish_id, "v_inbox_file~v2.1");
    const init = calls.find((c) => c.url.pathname === "/v2/post/publish/inbox/video/init/")!;
    assert.equal(init.method, "POST");
    assert.equal(init.headers.get("authorization"), "Bearer at-1");
    assert.deepEqual(init.body, { source_info: { source: "FILE_UPLOAD", video_size: 1000, chunk_size: 1000, total_chunk_count: 1 } });
    const puts = calls.filter((c) => c.url.host === "open-upload.test");
    assert.equal(puts.length, 1);
    assert.equal(puts[0].method, "PUT");
    assert.equal(puts[0].headers.get("content-type"), "video/mp4");
    assert.equal(puts[0].headers.get("content-range"), "bytes 0-999/1000");
    assert.equal(puts[0].headers.get("content-length"), "1000");
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].publish_id, "v_inbox_file~v2.1");
    assert.equal(jobs[0].note, "QD1");
  });

  it("video lớn: chia khối, Content-Range liền mạch, khối cuối gom phần dư", async () => {
    video = Buffer.alloc(70 * MB + 5, 1);
    await uploadDraft({ videoUrl: "https://cdn.test/big.mp4" });
    const puts = calls.filter((c) => c.url.host === "open-upload.test");
    const { chunkSize, count } = chunkPlan(video.length);
    assert.equal(puts.length, count);
    let next = 0;
    for (const p of puts) {
      const [, a, b, total] = p.headers.get("content-range")!.match(/^bytes (\d+)-(\d+)\/(\d+)$/)!.map(Number);
      assert.equal(a, next);
      assert.equal(total, video.length);
      assert.equal(Number(p.headers.get("content-length")), b - a + 1);
      next = b + 1;
    }
    assert.equal(next, video.length);
    assert.ok(Number(puts.at(-1)!.headers.get("content-length")) >= chunkSize);
  });

  it("link trả trang web thì báo lỗi, không gọi TikTok", async () => {
    videoType = "text/html";
    await assert.rejects(uploadDraft({ videoUrl: "https://cdn.test/page" }), /trang web/);
    assert.equal(calls.some((c) => c.url.host === "open.tiktokapis.com"), false);
  });

  it("token hết hạn thì làm mới qua /v2/oauth/token/ rồi mới init", async () => {
    users[0].access_expire_at = Date.now() - 1000;
    await uploadDraft({ videoUrl: "https://cdn.test/v.mp4" });
    const tok = calls.find((c) => c.url.pathname === "/v2/oauth/token/")!;
    assert.equal(tok.headers.get("content-type"), "application/x-www-form-urlencoded");
    assert.deepEqual(tok.body, { client_key: "ck-test", client_secret: "cs-test", grant_type: "refresh_token", refresh_token: "rt-1" });
    const init = calls.find((c) => c.url.pathname === "/v2/post/publish/inbox/video/init/")!;
    assert.equal(init.headers.get("authorization"), "Bearer at-new");
    assert.equal(users[0].refresh_token, "rt-new");
  });

  it("draftStatus gọi status/fetch với publish_id", async () => {
    const s = await draftStatus("v_inbox_file~v2.1");
    assert.equal((s as { status: string }).status, "SEND_TO_USER_INBOX");
    const c = calls.find((x) => x.url.pathname === "/v2/post/publish/status/fetch/")!;
    assert.deepEqual(c.body, { publish_id: "v_inbox_file~v2.1" });
  });

  it("chưa có kênh nào ủy quyền thì báo vào /admin/tiktok", async () => {
    users = [];
    await assert.rejects(uploadDraft({ videoUrl: "https://cdn.test/v.mp4" }), /admin\/tiktok/);
  });
});
