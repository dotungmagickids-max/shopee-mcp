import { db } from "@/lib/supabase";
import { exchangeCode } from "@/lib/video/client";
import { logJob } from "@/lib/video/ops";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TTL_MS = 15 * 60 * 1000;

/** Shopee redirects here after authorization: exchange the code, store the user token. */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const back = (msg: string) => Response.redirect(`${url.origin}/video?msg=${encodeURIComponent(msg)}`, 303);
  const requestId = url.searchParams.get("request_id");
  const code = url.searchParams.get("code");
  if (!requestId || !code) return back("Ủy quyền lỗi: thiếu request_id hoặc code.");

  const { data: pending } = await db()
    .from("video_auth_requests")
    .update({ consumed_at: new Date().toISOString() })
    .eq("id", requestId)
    .is("consumed_at", null)
    .gt("created_at", new Date(Date.now() - TTL_MS).toISOString())
    .select("id")
    .maybeSingle();
  if (!pending) return back("Link ủy quyền đã hết hạn hoặc đã dùng. Bấm Ủy quyền lại.");

  const num = (k: string) => Number(url.searchParams.get(k)) || undefined;
  try {
    const users = await exchangeCode(code, {
      shop_id: num("shop_id"),
      main_account_id: num("main_account_id"),
      user_id: num("user_id"),
    });
    await logJob({ status: "authorized", detail: { users, params: [...url.searchParams.keys()] }, created_by: "auth" });
    return back(`Đã ủy quyền tài khoản Shopee Video: ${users.join(", ")}.`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await logJob({ status: "auth_failed", detail: { message, params: [...url.searchParams.keys()] }, created_by: "auth" });
    return back(`Ủy quyền lỗi: ${message}`);
  }
}
