import { createHash, createHmac } from "node:crypto";
import type { ShopeeRegion } from "@congminh1254/shopee-sdk/schemas/region";
import { SHOPEE_BASE_URLS } from "@congminh1254/shopee-sdk/schemas/region";
import { partnerCredentials } from "./env";

/**
 * Binary uploads to Shopee media space (images and videos for items).
 *
 * The generic call_write_endpoint can't carry files through JSON, so these
 * helpers download the file from a public https URL (or take base64) on the
 * server and hand Buffers to the SDK, which sends them as multipart/form-data.
 */

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // Shopee limit per image
export const MAX_VIDEO_BYTES = 30 * 1024 * 1024; // Shopee limit per video
export const VIDEO_PART_BYTES = 4 * 1024 * 1024; // parts must be exactly 4MB except the last
const FETCH_TIMEOUT_MS = 20_000;

/** Minimal shape of the SDK's MediaSpaceManager used here. */
export interface MediaSpaceApi {
  uploadImage(p: { image: Buffer | Buffer[]; scene?: string; ratio?: string }): Promise<unknown>;
  initVideoUpload(p: { file_md5: string; file_size: number }): Promise<unknown>;
  uploadVideoPart(p: {
    video_upload_id: string;
    part_seq: number;
    content_md5: string;
    part_content: Buffer;
  }): Promise<unknown>;
  completeVideoUpload(p: {
    video_upload_id: string;
    part_seq_list: number[];
    report_data: { upload_cost: number };
  }): Promise<unknown>;
  getVideoUploadResult(p: { video_upload_id: string }): Promise<unknown>;
}

export class MediaInputError extends Error {}

const md5 = (b: Buffer) => createHash("md5").update(b).digest("hex");

/** Downloads a public https file, refusing anything larger than maxBytes. */
export async function downloadFile(url: string, maxBytes: number): Promise<Buffer> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new MediaInputError(`Not a valid URL: ${url}`);
  }
  if (parsed.protocol !== "https:") throw new MediaInputError(`Only https URLs are accepted: ${url}`);
  const res = await fetch(parsed, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), redirect: "follow" });
  if (!res.ok) throw new MediaInputError(`Download failed (${res.status}) for ${url}`);
  const declared = Number(res.headers.get("content-length") ?? 0);
  if (declared > maxBytes) throw new MediaInputError(`File too large (${declared} bytes, max ${maxBytes}): ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > maxBytes) throw new MediaInputError(`File too large (${buf.length} bytes, max ${maxBytes}): ${url}`);
  if (buf.length === 0) throw new MediaInputError(`Empty file: ${url}`);
  return buf;
}

export function decodeBase64(data: string, maxBytes: number): Buffer {
  const buf = Buffer.from(data.replace(/^data:[^;]+;base64,/, ""), "base64");
  if (buf.length === 0) throw new MediaInputError("Empty base64 file");
  if (buf.length > maxBytes) throw new MediaInputError(`File too large (${buf.length} bytes, max ${maxBytes})`);
  return buf;
}

/** JPG or PNG, checked by magic bytes (Shopee accepts JPG, JPEG, PNG). */
export function assertImage(buf: Buffer, label: string): void {
  const hex = buf.toString("hex", 0, 4).toLowerCase();
  if (!hex.startsWith("ffd8ff") && !hex.startsWith("89504e47")) {
    throw new MediaInputError(`${label} is not a JPG or PNG image`);
  }
}

/** Uploads 1–9 images in one call; returns Shopee's response (image_info_list with image_id). */
export async function uploadImages(
  api: MediaSpaceApi,
  images: Buffer[],
  opts: { scene?: "normal" | "desc"; ratio?: "1:1" | "3:4" } = {}
): Promise<unknown> {
  if (images.length < 1 || images.length > 9) throw new MediaInputError("Upload 1 to 9 images per call");
  return api.uploadImage({
    image: images.length === 1 ? images[0] : images,
    scene: opts.scene ?? "normal",
    ...(opts.ratio ? { ratio: opts.ratio } : {}),
  });
}

function responseField(result: unknown, field: string): unknown {
  const r = result as { response?: Record<string, unknown> } | null;
  return r?.response?.[field];
}

/**
 * Full video upload: init → upload 4MB parts → complete → poll the result for up to waitMs.
 * Returns the video_upload_id (usable in product.add_item / update_item once status is SUCCEEDED).
 */
export async function uploadVideo(
  api: MediaSpaceApi,
  video: Buffer,
  waitMs = 15_000,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))
): Promise<{ video_upload_id: string; status: string; result: unknown }> {
  const started = Date.now();
  const init = await api.initVideoUpload({ file_md5: md5(video), file_size: video.length });
  const videoUploadId = String(responseField(init, "video_upload_id") ?? "");
  if (!videoUploadId) throw new Error(`init_video_upload returned no video_upload_id: ${JSON.stringify(init)}`);

  const partSeqList: number[] = [];
  for (let seq = 0, off = 0; off < video.length; seq++, off += VIDEO_PART_BYTES) {
    const part = video.subarray(off, Math.min(off + VIDEO_PART_BYTES, video.length));
    await api.uploadVideoPart({
      video_upload_id: videoUploadId,
      part_seq: seq,
      content_md5: md5(part),
      part_content: part,
    });
    partSeqList.push(seq);
  }

  await api.completeVideoUpload({
    video_upload_id: videoUploadId,
    part_seq_list: partSeqList,
    report_data: { upload_cost: Date.now() - started },
  });

  let result: unknown = null;
  let status = "UNKNOWN";
  const deadline = Date.now() + waitMs;
  do {
    result = await api.getVideoUploadResult({ video_upload_id: videoUploadId });
    status = String(responseField(result, "status") ?? "UNKNOWN");
    if (status === "SUCCEEDED" || status === "FAILED" || status === "CANCELLED") break;
    if (Date.now() >= deadline) break;
    await sleep(3_000);
  } while (Date.now() < deadline);

  return { video_upload_id: videoUploadId, status, result };
}

/**
 * media_space endpoints are Public APIs in Shopee's spec: signed with
 * partner_id + path + timestamp only (no shop token). The SDK's manager signs
 * them as shop calls, so they are sent here directly.
 */
export function publicMediaSpace(region: ShopeeRegion): MediaSpaceApi {
  const creds = partnerCredentials(region);
  if (!creds) throw new Error(`No Shopee partner credentials configured for region ${region}`);
  const base = SHOPEE_BASE_URLS[region];

  async function call(apiPath: string, method: "GET" | "POST", fields: Record<string, unknown>): Promise<unknown> {
    const url = new URL(`${base}/media_space/${apiPath}`);
    const timestamp = Math.floor(Date.now() / 1000);
    const sign = createHmac("sha256", creds!.partnerKey)
      .update(`${creds!.partnerId}${url.pathname}${timestamp}`)
      .digest("hex");
    url.searchParams.set("partner_id", String(creds!.partnerId));
    url.searchParams.set("timestamp", String(timestamp));
    url.searchParams.set("sign", sign);

    let body: BodyInit | undefined;
    const headers: Record<string, string> = {};
    if (method === "GET") {
      for (const [k, v] of Object.entries(fields)) url.searchParams.set(k, String(v));
    } else if (Object.values(fields).some((v) => Buffer.isBuffer(v) || (Array.isArray(v) && v.some(Buffer.isBuffer)))) {
      const form = new FormData();
      for (const [k, v] of Object.entries(fields)) {
        for (const item of Array.isArray(v) ? v : [v]) {
          if (Buffer.isBuffer(item)) {
            const isPng = item.toString("hex", 0, 4) === "89504e47";
            const isJpg = item.toString("hex", 0, 3) === "ffd8ff";
            const type = isPng ? "image/png" : isJpg ? "image/jpeg" : "application/octet-stream";
            const ext = isPng ? "png" : isJpg ? "jpg" : "bin";
            form.append(k, new Blob([new Uint8Array(item)], { type }), `${k}.${ext}`);
          } else if (item !== undefined) {
            form.append(k, typeof item === "object" ? JSON.stringify(item) : String(item));
          }
        }
      }
      body = form;
    } else {
      body = JSON.stringify(fields);
      headers["Content-Type"] = "application/json";
    }

    const res = await fetch(url, { method, body, headers });
    const data = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
    if (!res.ok || data.error) {
      throw new Error(`Shopee media_space.${apiPath} failed (HTTP ${res.status}): ${JSON.stringify(data)}`);
    }
    return data;
  }

  return {
    uploadImage: (p) => call("upload_image", "POST", p),
    initVideoUpload: (p) => call("init_video_upload", "POST", p),
    uploadVideoPart: (p) => call("upload_video_part", "POST", p),
    completeVideoUpload: (p) => call("complete_video_upload", "POST", p),
    getVideoUploadResult: (p) => call("get_video_upload_result", "GET", p),
  };
}
