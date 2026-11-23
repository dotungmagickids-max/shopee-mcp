import { adminFromRequest } from "@/lib/autopilot/admin-auth";
import { MAX_ITEMS } from "@/lib/facebook/launch";
import { PAGES } from "@/lib/facebook/magic-data";
import { db } from "@/lib/supabase";
import { sameOrigin } from "@/lib/video/ui-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const json = (body: unknown, status = 200) => Response.json(body, { status });

/**
 * Lưu / xóa nháp kế hoạch lên camp (bảng fb_launch_drafts). Chỉ ghi Supabase: không gọi Meta, không tạo gì trên Meta.
 * Cấu hình được kiểm lại đầy đủ lúc bấm tạo thật ở /api/fb/launch, nên ở đây chỉ kiểm dạng.
 */
export async function POST(request: Request) {
  if (!adminFromRequest(request)) return json({ error: "Chưa đăng nhập." }, 401);
  if (!sameOrigin(request)) return json({ error: "bad origin" }, 403);
  const body: any = await request.json().catch(() => null);
  if (body?.delete != null) {
    const id = Number(body.delete);
    if (!Number.isInteger(id) || id <= 0) return json({ error: "Mã nháp không hợp lệ." }, 400);
    const { error } = await db().from("fb_launch_drafts").delete().eq("id", id);
    return error ? json({ error: `Chưa xóa được: ${error.message.slice(0, 160)}` }, 500) : json({ deleted: id });
  }
  const pageId = String(body?.config?.page_id ?? "");
  if (!PAGES[pageId]) return json({ error: "Page không thuộc Magickids." }, 400);
  const items = Array.isArray(body?.items)
    ? body.items.map((i: any) => ({ post_id: String(i?.post_id ?? ""), name: String(i?.name ?? "").slice(0, 200) }))
    : [];
  if (!items.length || items.length > MAX_ITEMS) return json({ error: `Nháp cần từ 1 đến ${MAX_ITEMS} bài.` }, 400);
  if (items.some((i: { post_id: string }) => !i.post_id.startsWith(`${pageId}_`) || !/^\d+_\d+$/.test(i.post_id))) return json({ error: "Có bài không thuộc page đã chọn." }, 400);
  const config = JSON.parse(JSON.stringify(body.config ?? {}));
  if (JSON.stringify(config).length > 5000) return json({ error: "Cấu hình quá dài." }, 400);
  const name = String(body?.name ?? "").trim().slice(0, 200) || `Nháp ${items.length} bài`;
  const { data, error } = await db().from("fb_launch_drafts").insert({ name, page_id: pageId, config, items }).select("id, created_at, name, page_id, config, items").single();
  if (error) return json({ error: `Chưa lưu được: ${error.message.slice(0, 160)}` }, 500);
  return json({ draft: data });
}
