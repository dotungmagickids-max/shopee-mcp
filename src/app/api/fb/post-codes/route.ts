import { adminFromRequest } from "@/lib/autopilot/admin-auth";
import { parseCodes } from "@/lib/facebook/content";
import { db } from "@/lib/supabase";
import { sameOrigin } from "@/lib/video/ui-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const json = (body: unknown, status = 200) => Response.json(body, { status });

/** Gắn mã sản phẩm cho một bài (bảng fb_post_codes). Chỉ ghi Supabase, không đụng Meta hay Pancake. Để trống = bỏ mã nhập tay. */
export async function POST(request: Request) {
  if (!adminFromRequest(request)) return json({ error: "Chưa đăng nhập." }, 401);
  if (!sameOrigin(request)) return json({ error: "bad origin" }, 403);
  const body: any = await request.json().catch(() => null);
  const postId = String(body?.post_id ?? "");
  if (!/^\d{5,25}_\d{5,25}$/.test(postId)) return json({ error: "Mã bài không hợp lệ." }, 400);
  const raw = String(body?.codes ?? "").trim();
  const codes = parseCodes(raw);
  if (raw && !codes.length) return json({ error: "Không đọc được mã nào. Ví dụ: ADT26001, BD26011" }, 400);
  const q = codes.length
    ? db().from("fb_post_codes").upsert({ post_id: postId, codes, updated_at: new Date().toISOString() })
    : db().from("fb_post_codes").delete().eq("post_id", postId);
  const { error } = await q;
  if (error) return json({ error: `Chưa lưu được: ${error.message.slice(0, 160)}` }, 500);
  return json({ post_id: postId, codes });
}
