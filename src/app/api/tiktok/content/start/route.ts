import { adminFromRequest } from "@/lib/autopilot/admin-auth";
import { appUrl } from "@/lib/env";
import { db } from "@/lib/supabase";
import { contentAuthUrl } from "@/lib/tiktok/content";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Nút trên /admin/tiktok: ủy quyền kênh TikTok cho app "Magickids Content" (đẩy video vào nháp). */
export async function POST(request: Request) {
  if (!adminFromRequest(request)) return new Response("unauthorized", { status: 401 });
  const { data, error } = await db().from("tiktok_auth_requests").insert({}).select("id").single();
  if (error) return new Response(`Không tạo được yêu cầu ủy quyền: ${error.message}`, { status: 500 });
  try {
    return Response.redirect(contentAuthUrl(`${appUrl(request)}/api/tiktok/content/callback`, data.id), 303);
  } catch (err) {
    return new Response(err instanceof Error ? err.message : String(err), { status: 500 });
  }
}
