import { adminFromRequest } from "@/lib/autopilot/admin-auth";
import { db } from "@/lib/supabase";
import { authorizationUrl } from "@/lib/tiktok/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Nút trên /admin/tiktok: chuyển sang TikTok để ủy quyền shop (hoặc kênh Creator) cho app Magickids Gateway. */
export async function POST(request: Request) {
  if (!adminFromRequest(request)) return new Response("unauthorized", { status: 401 });
  const { data, error } = await db().from("tiktok_auth_requests").insert({}).select("id").single();
  if (error) return new Response(`Không tạo được yêu cầu ủy quyền: ${error.message}`, { status: 500 });
  try {
    return Response.redirect(authorizationUrl(data.id), 303);
  } catch (err) {
    return new Response(err instanceof Error ? err.message : String(err), { status: 500 });
  }
}
