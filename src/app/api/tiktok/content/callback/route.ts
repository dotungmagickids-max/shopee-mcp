import { appUrl } from "@/lib/env";
import { db } from "@/lib/supabase";
import { exchangeContentCode } from "@/lib/tiktok/content";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TTL_MS = 15 * 60 * 1000;

/** TikTok (Login Kit) chuyển về đây: đổi code lấy token kênh và lưu. */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const back = (msg: string) => Response.redirect(`${url.origin}/admin/tiktok?msg=${encodeURIComponent(msg)}`, 303);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (url.searchParams.get("error")) return back(`Ủy quyền kênh lỗi: ${url.searchParams.get("error_description") ?? url.searchParams.get("error")}`);
  if (!code || !state || !/^[0-9a-f-]{36}$/i.test(state)) return back("Ủy quyền kênh lỗi: thiếu code hoặc mã yêu cầu.");

  const { data: pending } = await db()
    .from("tiktok_auth_requests")
    .update({ consumed_at: new Date().toISOString() })
    .eq("id", state)
    .is("consumed_at", null)
    .gt("created_at", new Date(Date.now() - TTL_MS).toISOString())
    .select("id")
    .maybeSingle();
  if (!pending) return back("Link ủy quyền đã hết hạn hoặc đã dùng. Bấm lại.");

  try {
    const r = await exchangeContentCode(code, `${appUrl(request)}/api/tiktok/content/callback`);
    return back(`Đã ủy quyền kênh TikTok ${r.name} để đẩy video vào nháp.`);
  } catch (err) {
    return back(`Ủy quyền kênh lỗi: ${err instanceof Error ? err.message : String(err)}`);
  }
}
