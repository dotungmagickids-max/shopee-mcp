import { db } from "../supabase";
import { md5, publicCall, userCall, videoConfig } from "./client";

/** Shopee Video limits (v2.media.init_video_upload, business 3 / scene 1). */
export const MAX_SHOPEE_VIDEO_BYTES = 1024 * 1024 * 1024;
export const MIN_SECONDS = 1;
export const MAX_SECONDS = 180;
/** What this server will download per request (Vercel memory / time). */
export const MAX_DOWNLOAD_BYTES = 200 * 1024 * 1024;

export class VideoInputError extends Error {}

/** Duration in seconds from an MP4/MOV file's moov/mvhd box, or null if not found. */
export function mp4DurationSeconds(buf: Buffer): number | null {
  function scan(start: number, end: number): number | null {
    let off = start;
    while (off + 8 <= end) {
      let size = buf.readUInt32BE(off);
      const type = buf.toString("latin1", off + 4, off + 8);
      let header = 8;
      if (size === 1) {
        if (off + 16 > end) return null;
        size = Number(buf.readBigUInt64BE(off + 8));
        header = 16;
      } else if (size === 0) {
        size = end - off;
      }
      if (size < header || off + size > end) return null;
      if (type === "moov") return scan(off + header, off + size);
      if (type === "mvhd") {
        const p = off + header;
        const version = buf.readUInt8(p);
        const timescale = version === 1 ? buf.readUInt32BE(p + 20) : buf.readUInt32BE(p + 12);
        const duration = version === 1 ? Number(buf.readBigUInt64BE(p + 24)) : buf.readUInt32BE(p + 16);
        return timescale ? duration / timescale : null;
      }
      off += size;
    }
    return null;
  }
  return buf.length >= 8 ? scan(0, buf.length) : null;
}

export async function downloadVideo(url: string): Promise<{ buf: Buffer; fileName: string }> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new VideoInputError(`Link không hợp lệ: ${url}`);
  }
  if (parsed.protocol !== "https:") throw new VideoInputError("Chỉ nhận link https.");
  const res = await fetch(parsed, { signal: AbortSignal.timeout(60_000), redirect: "follow" });
  if (!res.ok) throw new VideoInputError(`Tải video lỗi (HTTP ${res.status}).`);
  const declared = Number(res.headers.get("content-length") ?? 0);
  if (declared > MAX_DOWNLOAD_BYTES) throw new VideoInputError(`Video quá lớn (${declared} byte).`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (!buf.length) throw new VideoInputError("File video rỗng.");
  if (buf.length > MAX_DOWNLOAD_BYTES) throw new VideoInputError(`Video quá lớn (${buf.length} byte).`);
  const name = decodeURIComponent(parsed.pathname.split("/").pop() || "video.mp4").slice(0, 120);
  return { buf, fileName: /\.\w{2,4}$/.test(name) ? name : `${name}.mp4` };
}

const resp = (r: Record<string, unknown>) => (r.response ?? {}) as Record<string, unknown>;

export interface UploadResult {
  video_upload_id: string;
  status: string;
  duration: number;
  parts: number;
  video_info?: unknown;
  reason?: unknown;
}

/** init → parts (size given by Shopee) → complete → poll result for up to waitMs. */
export async function uploadShopeeVideo(
  buf: Buffer,
  fileName: string,
  opts: { durationSeconds?: number; waitMs?: number; sleep?: (ms: number) => Promise<void> } = {}
): Promise<UploadResult> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  if (buf.length > MAX_SHOPEE_VIDEO_BYTES) throw new VideoInputError("Shopee Video tối đa 1GB.");
  const seconds = Math.round(opts.durationSeconds ?? mp4DurationSeconds(buf) ?? 0);
  if (!seconds) throw new VideoInputError("Không đọc được thời lượng video (cần file MP4/MOV), hãy nhập số giây.");
  if (seconds < MIN_SECONDS || seconds > MAX_SECONDS) {
    throw new VideoInputError(`Video dài ${seconds}s; Shopee Video nhận ${MIN_SECONDS}–${MAX_SECONDS}s.`);
  }

  const init = resp(
    await publicCall("/media/init_video_upload", "POST", {
      business: 3,
      scene: 1,
      file_name: fileName,
      file_size: buf.length,
      duration: seconds,
    })
  );
  const id = String(init.video_upload_id ?? "");
  const partSize = Number(init.part_size) || 4 * 1024 * 1024;
  if (!id) throw new Error("Shopee không trả video_upload_id.");

  let parts = 0;
  for (let off = 0; off < buf.length; off += partSize, parts++) {
    const part = buf.subarray(off, Math.min(off + partSize, buf.length));
    await publicCall("/media/upload_video_part", "POST", {
      video_upload_id: id,
      part_seq: parts,
      part_md5: md5(part),
      part_content: part,
    });
  }
  await publicCall("/media/complete_video_upload", "POST", { video_upload_id: id });

  const result = await pollUpload(id, opts.waitMs ?? 20_000, sleep);
  return { ...result, duration: seconds, parts };
}

export async function pollUpload(
  id: string,
  waitMs: number,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))
): Promise<{ video_upload_id: string; status: string; video_info?: unknown; reason?: unknown }> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const r = resp(await publicCall("/media/get_video_upload_result", "GET", { video_upload_id: id }));
    const raw = String(r.status ?? "UNKNOWN");
    // Live API trả "SUCCEED", sandbox/tài liệu ghi "SUCCEEDED": coi như nhau.
    const status = raw === "SUCCEED" ? "SUCCEEDED" : raw;
    if (["SUCCEEDED", "FAILED", "CANCELLED"].includes(status) || Date.now() >= deadline) {
      return { video_upload_id: id, status, video_info: r.video_info, reason: r.reason };
    }
    await sleep(3_000);
  }
}

export async function getCovers(userId: number, videoUploadId: string): Promise<string[]> {
  const r = resp(await userCall(userId, "/video/get_cover_list", "GET", { video_upload_id: videoUploadId }));
  return (r.image_url_list as string[] | undefined) ?? [];
}

export interface VideoInfoInput {
  video_upload_id: string;
  caption?: string;
  cover_image_url?: string;
  item_ids?: number[];
  allow_duet?: boolean;
  allow_stitch?: boolean;
  /** Unix milliseconds; omit to keep as draft / post now. */
  scheduled_post_time?: number;
  aigc_label?: boolean;
}

/** Sets caption, cover (first frame if not given), up to 6 products and schedule. Video stays draft. */
export async function editVideoInfo(userId: number, input: VideoInfoInput): Promise<Record<string, unknown>> {
  if ((input.item_ids?.length ?? 0) > 6) throw new VideoInputError("Gắn tối đa 6 sản phẩm.");
  const cover = input.cover_image_url ?? (await getCovers(userId, input.video_upload_id))[0];
  if (!cover) throw new VideoInputError("Chưa có ảnh bìa (video có thể đang chuyển mã, thử lại sau).");
  const scheduled = !!input.scheduled_post_time;
  return resp(
    await userCall(userId, "/video/edit_video_info", "POST", {
      video_upload_list: [
        {
          video_upload_id: input.video_upload_id,
          caption: input.caption ?? "",
          cover_image_url: cover,
          item_info: (input.item_ids ?? []).map((item_id) => ({ item_id })),
          allow_info: { allow_duet: input.allow_duet ?? true, allow_stitch: input.allow_stitch ?? true },
          scheduled_info: scheduled
            ? { scheduled_post: true, scheduled_post_time: input.scheduled_post_time }
            : { scheduled_post: false },
        },
      ],
      aigc_label: input.aigc_label ?? false,
    })
  );
}

export async function postVideos(userId: number, ids: string[]): Promise<Record<string, unknown>> {
  if (!ids.length || ids.length > 5) throw new VideoInputError("Đăng 1–5 video mỗi lần.");
  return resp(await userCall(userId, "/video/post_video", "POST", { video_upload_id_list: ids }));
}

export async function listVideos(userId: number, listType: "draft" | "post", page = 1, pageSize = 20) {
  return resp(
    await userCall(userId, "/video/get_video_list", "GET", {
      page_no: page,
      page_size: Math.min(20, pageSize),
      list_type: listType === "draft" ? 1 : 2,
    })
  );
}

/** Best-effort job log for the /video page. */
export async function logJob(row: {
  user_id?: number | null;
  video_upload_id?: string | null;
  source_url?: string | null;
  caption?: string | null;
  item_ids?: number[] | null;
  status: string;
  detail?: unknown;
  created_by: string;
}): Promise<void> {
  let env = "test";
  try {
    env = videoConfig().env;
  } catch {
    /* not configured */
  }
  await db()
    .from("video_jobs")
    .insert({ env, ...row, detail: row.detail ?? null })
    .then(undefined, () => undefined);
}

export interface CreateVideoInput {
  video_url: string;
  user_id?: number;
  duration_seconds?: number;
  caption?: string;
  item_ids?: number[];
  scheduled_post_time?: number;
  /** false (default) = leave as draft for review; true = post now (or at scheduled_post_time). */
  post?: boolean;
  aigc_label?: boolean;
  created_by: string;
}

export interface CreateVideoResult {
  video_upload_id: string;
  status: string;
  step: "uploaded" | "transcoding" | "draft" | "scheduled" | "posted" | "failed";
  message: string;
  detail?: unknown;
}

/** Download → upload → (when transcoded) set info → optionally post. Logged in video_jobs. */
export async function createShopeeVideo(input: CreateVideoInput): Promise<CreateVideoResult> {
  const { resolveVideoUser } = await import("./client");
  const userId = await resolveVideoUser(input.user_id);
  const { buf, fileName } = await downloadVideo(input.video_url);
  const up = await uploadShopeeVideo(buf, fileName, { durationSeconds: input.duration_seconds });
  const base = {
    user_id: userId,
    video_upload_id: up.video_upload_id,
    source_url: input.video_url,
    caption: input.caption ?? null,
    item_ids: input.item_ids ?? null,
    created_by: input.created_by,
  };

  if (up.status !== "SUCCEEDED") {
    const failed = up.status === "FAILED" || up.status === "CANCELLED";
    await logJob({ ...base, status: failed ? "failed" : "transcoding", detail: up });
    return {
      video_upload_id: up.video_upload_id,
      status: up.status,
      step: failed ? "failed" : "transcoding",
      message: failed
        ? `Shopee báo tải video thất bại: ${JSON.stringify(up.reason ?? "")}`
        : "Shopee đang chuyển mã video. Vài phút sau bấm 'Hoàn tất' (hoặc gọi shopee_video_publish) với video_upload_id này.",
      detail: up,
    };
  }
  return publishShopeeVideo({ ...input, user_id: userId, video_upload_id: up.video_upload_id });
}

export interface PublishInput extends Omit<CreateVideoInput, "video_url" | "duration_seconds"> {
  video_upload_id: string;
  cover_image_url?: string;
}

/** For an uploaded (SUCCEEDED) video: set info, then post if asked. */
export async function publishShopeeVideo(input: PublishInput): Promise<CreateVideoResult> {
  const { resolveVideoUser } = await import("./client");
  const userId = await resolveVideoUser(input.user_id);
  const state = await pollUpload(input.video_upload_id, 0);
  const base = {
    user_id: userId,
    video_upload_id: input.video_upload_id,
    caption: input.caption ?? null,
    item_ids: input.item_ids ?? null,
    created_by: input.created_by,
  };
  if (state.status !== "SUCCEEDED") {
    return {
      video_upload_id: input.video_upload_id,
      status: state.status,
      step: state.status === "FAILED" || state.status === "CANCELLED" ? "failed" : "transcoding",
      message: `Video chưa sẵn sàng (trạng thái ${state.status}).`,
      detail: state,
    };
  }
  const edited = await editVideoInfo(userId, {
    video_upload_id: input.video_upload_id,
    caption: input.caption,
    cover_image_url: input.cover_image_url,
    item_ids: input.item_ids,
    scheduled_post_time: input.scheduled_post_time,
    aigc_label: input.aigc_label,
  });
  if (!input.post) {
    await logJob({ ...base, status: "draft", detail: edited });
    return {
      video_upload_id: input.video_upload_id,
      status: state.status,
      step: "draft",
      message: "Đã lưu nháp trên Shopee Video (chưa đăng).",
      detail: edited,
    };
  }
  const posted = await postVideos(userId, [input.video_upload_id]);
  const step = input.scheduled_post_time ? "scheduled" : "posted";
  await logJob({ ...base, status: step, detail: posted });
  return {
    video_upload_id: input.video_upload_id,
    status: state.status,
    step,
    message: step === "scheduled" ? "Đã hẹn giờ đăng Shopee Video." : "Đã đăng lên Shopee Video.",
    detail: posted,
  };
}
