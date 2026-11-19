/**
 * Shopee Video (separate app, user-level token). Supabase REST and Shopee are faked at fetch level.
 */
import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { beforeEach, describe, it } from "node:test";

process.env.SUPABASE_URL = "https://supabase.test";
process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role";
process.env.SHOPEE_VIDEO_PARTNER_ID = "1254077";
process.env.SHOPEE_VIDEO_PARTNER_KEY = "video-key";
delete process.env.SHOPEE_VIDEO_ENV;
delete process.env.TOKEN_ENC_KEY;

type Row = Record<string, unknown>;
let users: Row[];
let jobs: Row[];
let calls: { path: string; method: string; query: URLSearchParams; body: Row }[];
let uploadStatus: string;
const md5 = (b: Buffer) => createHash("md5").update(b).digest("hex");

function reset() {
  users = [{ env: "test", user_id: 77, access_token: "at-77", refresh_token: "rt-77", expired_at: Date.now() + 3_600_000 }];
  jobs = [];
  calls = [];
  uploadStatus = "SUCCEEDED";
}

const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });

function match(rows: Row[], q: URLSearchParams) {
  return rows.filter((r) =>
    [...q.entries()].every(([k, v]) => {
      if (["select", "order", "limit", "or", "on_conflict"].includes(k)) return true;
      if (v.startsWith("eq.")) return String(r[k]) === v.slice(3);
      return true;
    })
  );
}

async function fakeSupabase(url: URL, init: RequestInit) {
  const table = url.pathname.replace("/rest/v1/", "");
  const rows = ({ video_users: users, video_jobs: jobs } as Record<string, Row[]>)[table] ?? [];
  const method = init.method ?? "GET";
  const one = new Headers(init.headers).get("accept")?.includes("vnd.pgrst.object");
  if (method === "GET") {
    const found = match(rows, url.searchParams);
    return one ? (found[0] ? json(found[0]) : json(null)) : json(found);
  }
  const body = JSON.parse(String(init.body ?? "{}"));
  if (method === "POST") {
    for (const item of Array.isArray(body) ? body : [body]) {
      const i = rows.findIndex((r) => r.env === item.env && r.user_id === item.user_id && table === "video_users");
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

function fakeShopee(url: URL, init: RequestInit) {
  const path = url.pathname.replace("/api/v2", "");
  let body: Row = {};
  if (init.body instanceof FormData) {
    for (const [k, v] of init.body.entries()) body[k] = typeof v === "string" ? v : `file:${v.size}`;
  } else if (init.body) body = JSON.parse(String(init.body));
  calls.push({ path, method: init.method ?? "GET", query: url.searchParams, body });
  const ok = (response: unknown) => json({ error: "", message: "", request_id: "r", response });
  switch (path) {
    case "/media/init_video_upload":
      return ok({ video_upload_id: "vu-9", part_size: 1_000 });
    case "/media/get_video_upload_result":
      return ok({ status: uploadStatus });
    case "/video/get_cover_list":
      return ok({ image_url_list: ["https://cf.test/cover0.jpg", "https://cf.test/cover1.jpg"] });
    case "/auth/access_token/get":
      return json({ access_token: "at-new", refresh_token: "rt-new", expire_in: 14400, user_id: 77, error: "" });
    default:
      return ok({});
  }
}

/** Minimal MP4: ftyp + moov/mvhd(version 0, timescale 1000, duration 15500) + padding. */
function mp4(seconds: number, pad: number): Buffer {
  const mvhd = Buffer.alloc(8 + 100);
  mvhd.writeUInt32BE(mvhd.length, 0);
  mvhd.write("mvhd", 4, "latin1");
  mvhd.writeUInt32BE(1000, 8 + 12);
  mvhd.writeUInt32BE(Math.round(seconds * 1000), 8 + 16);
  const moov = Buffer.concat([Buffer.alloc(8), mvhd]);
  moov.writeUInt32BE(moov.length, 0);
  moov.write("moov", 4, "latin1");
  const ftyp = Buffer.alloc(16);
  ftyp.writeUInt32BE(16, 0);
  ftyp.write("ftypisom", 4, "latin1");
  const mdat = Buffer.alloc(8 + pad, 7);
  mdat.writeUInt32BE(mdat.length, 0);
  mdat.write("mdat", 4, "latin1");
  return Buffer.concat([ftyp, mdat, moov]);
}
const CLIP = mp4(15.5, 2_300);

globalThis.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
  const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  if (url.hostname === "supabase.test") return fakeSupabase(url, init);
  if (url.hostname === "openplatform.sandbox.test-stable.shopee.sg") return fakeShopee(url, init);
  if (url.hostname === "files.test") return new Response(new Uint8Array(CLIP));
  throw new Error(`Unexpected fetch ${url}`);
}) as typeof fetch;

const ops = await import("../src/lib/video/ops");
const client = await import("../src/lib/video/client");

const signOf = (base: string) => createHmac("sha256", "video-key").update(base).digest("hex");

describe("Shopee Video", () => {
  beforeEach(reset);

  it("reads MP4 duration from moov/mvhd", () => {
    assert.equal(ops.mp4DurationSeconds(CLIP), 15.5);
    assert.equal(ops.mp4DurationSeconds(Buffer.from("not a video")), null);
  });

  it("uploads in Shopee's part size with public signatures, then saves a draft", async () => {
    const r = await ops.createShopeeVideo({
      video_url: "https://files.test/clip.mp4",
      caption: "Áo dài tay ADT26002",
      item_ids: [111, 222],
      created_by: "test",
    });
    assert.equal(r.step, "draft");
    assert.deepEqual(
      calls.map((c) => c.path),
      [
        "/media/init_video_upload",
        "/media/upload_video_part",
        "/media/upload_video_part",
        "/media/upload_video_part",
        "/media/complete_video_upload",
        "/media/get_video_upload_result",
        "/media/get_video_upload_result",
        "/video/get_cover_list",
        "/video/edit_video_info",
      ]
    );
    const init = calls[0];
    assert.deepEqual(init.body, { business: 3, scene: 1, file_name: "clip.mp4", file_size: CLIP.length, duration: 16 });
    // Public API: no token, sign over partner_id + path + timestamp.
    assert.equal(init.query.get("access_token"), null);
    assert.equal(init.query.get("sign"), signOf(`1254077/api/v2/media/init_video_upload${init.query.get("timestamp")}`));
    const parts = calls.slice(1, 4).map((c) => c.body);
    assert.deepEqual(parts.map((p) => p.part_seq), ["0", "1", "2"]);
    assert.deepEqual(parts.map((p) => p.part_content), ["file:1000", "file:1000", `file:${CLIP.length - 2000}`]);
    assert.equal(parts[2].part_md5, md5(CLIP.subarray(2000)));
    // User API: access_token + user_id in query and in the signature.
    const cover = calls[7];
    assert.equal(cover.query.get("user_id"), "77");
    assert.equal(cover.query.get("access_token"), "at-77");
    assert.equal(
      cover.query.get("sign"),
      signOf(`1254077/api/v2/video/get_cover_list${cover.query.get("timestamp")}at-7777`)
    );
    assert.deepEqual(calls[8].body, {
      video_upload_list: [
        {
          video_upload_id: "vu-9",
          caption: "Áo dài tay ADT26002",
          cover_image_url: "https://cf.test/cover0.jpg",
          item_info: [{ item_id: 111 }, { item_id: 222 }],
          allow_info: { allow_duet: true, allow_stitch: true },
          scheduled_info: { scheduled_post: false },
        },
      ],
      aigc_label: false,
    });
    assert.equal(jobs.at(-1)?.status, "draft");
    assert.ok(!calls.some((c) => c.path === "/video/post_video"), "draft must not post");
  });

  it("posts with a schedule only when post=true", async () => {
    const at = Date.parse("2026-11-20T20:00:00+07:00");
    const r = await ops.publishShopeeVideo({ video_upload_id: "vu-9", post: true, scheduled_post_time: at, created_by: "test" });
    assert.equal(r.step, "scheduled");
    const edit = calls.find((c) => c.path === "/video/edit_video_info")!;
    assert.deepEqual((edit.body.video_upload_list as Row[])[0].scheduled_info, { scheduled_post: true, scheduled_post_time: at });
    assert.deepEqual(calls.at(-1)?.body, { video_upload_id_list: ["vu-9"] });
  });

  it("treats Live status SUCCEED as ready", async () => {
    uploadStatus = "SUCCEED";
    const r = await ops.publishShopeeVideo({ video_upload_id: "vu-9", created_by: "test" });
    assert.notEqual(r.step, "transcoding");
    assert.ok(calls.some((c) => c.path === "/video/edit_video_info"));
  });

  it("stops at transcoding and does not edit or post", async () => {
    uploadStatus = "TRANSCODING";
    const r = await ops.publishShopeeVideo({ video_upload_id: "vu-9", post: true, created_by: "test" });
    assert.equal(r.step, "transcoding");
    assert.ok(!calls.some((c) => c.path.startsWith("/video/")));
  });

  it("refreshes an expired user token with user_id", async () => {
    users[0].expired_at = Date.now() - 1000;
    await ops.listVideos(77, "post");
    const refresh = calls.find((c) => c.path === "/auth/access_token/get")!;
    assert.deepEqual(refresh.body, { partner_id: 1254077, refresh_token: "rt-77", user_id: 77 });
    assert.equal(calls.at(-1)?.query.get("access_token"), "at-new");
    assert.equal(users[0].access_token, "at-new");
  });

  it("rejects too-long videos and more than 6 products before calling Shopee", async () => {
    await assert.rejects(ops.uploadShopeeVideo(mp4(200, 10), "long.mp4"), /1–180s/);
    await assert.rejects(
      ops.editVideoInfo(77, { video_upload_id: "vu-9", item_ids: [1, 2, 3, 4, 5, 6, 7] }),
      /tối đa 6/
    );
    assert.equal(calls.length, 0);
  });

  it("builds the sandbox authorization URL", () => {
    const u = new URL(client.authorizationUrl("https://app.test/api/video/auth/callback?request_id=x"));
    assert.equal(u.origin + u.pathname, "https://open.sandbox.test-stable.shopee.com/auth");
    assert.equal(u.searchParams.get("partner_id"), "1254077");
  });
});
