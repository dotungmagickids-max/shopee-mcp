import { appUrl } from "@/lib/env";
import { db } from "@/lib/supabase";
import { authorizationUrl, videoConfig } from "@/lib/video/client";
import { sameOrigin, videoUserFromRequest } from "@/lib/video/ui-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Button on /video: send the seller to Shopee to authorize the Magickids Video app. */
export async function POST(request: Request) {
  if (!videoUserFromRequest(request)) return new Response("unauthorized", { status: 401 });
  if (!sameOrigin(request)) return new Response("bad origin", { status: 403 });
  const { env } = videoConfig();
  const { data, error } = await db().from("video_auth_requests").insert({ env }).select("id").single();
  if (error) return new Response(`Could not start authorization: ${error.message}`, { status: 500 });
  const redirectUri = `${appUrl(request)}/api/video/auth/callback?request_id=${data.id}`;
  return Response.redirect(authorizationUrl(redirectUri), 303);
}
