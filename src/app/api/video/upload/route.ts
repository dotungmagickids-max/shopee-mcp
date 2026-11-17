import { createShopeeVideo, publishShopeeVideo } from "@/lib/video/ops";
import { sameOrigin, videoUserFromRequest } from "@/lib/video/ui-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** "2026-11-20T20:00" entered in Vietnam time → unix ms. */
function vnLocalToMs(v: string): number | undefined {
  if (!v) return undefined;
  const ms = Date.parse(`${v}:00+07:00`);
  return Number.isFinite(ms) ? ms : undefined;
}

/**
 * Form POST from /video.
 *   mode=create: video_url, caption, item_ids, duration, schedule, action=draft|post
 *   mode=publish: video_upload_id (+ same info fields) for a video that finished transcoding
 */
export async function POST(request: Request) {
  const who = videoUserFromRequest(request);
  if (!who) return new Response("unauthorized", { status: 401 });
  if (!sameOrigin(request)) return new Response("bad origin", { status: 403 });
  const origin = new URL(request.url).origin;
  const form = await request.formData();
  const s = (k: string) => String(form.get(k) ?? "").trim();
  const itemIds = s("item_ids")
    .split(/[\s,;]+/)
    .filter(Boolean)
    .map(Number)
    .filter((n) => Number.isFinite(n) && n > 0);
  const common = {
    caption: s("caption") || undefined,
    item_ids: itemIds,
    scheduled_post_time: vnLocalToMs(s("schedule")),
    post: s("action") === "post",
    aigc_label: s("aigc") === "1",
    user_id: Number(s("user_id")) || undefined,
    created_by: `web:${who}`,
  };
  let msg: string;
  try {
    const r =
      s("mode") === "publish"
        ? await publishShopeeVideo({ ...common, video_upload_id: s("video_upload_id") })
        : await createShopeeVideo({ ...common, video_url: s("video_url"), duration_seconds: Number(s("duration")) || undefined });
    msg = `${r.message} (video_upload_id ${r.video_upload_id})`;
  } catch (err) {
    msg = `Lỗi: ${err instanceof Error ? err.message : String(err)}`;
  }
  return Response.redirect(`${origin}/video?msg=${encodeURIComponent(msg)}`, 303);
}
