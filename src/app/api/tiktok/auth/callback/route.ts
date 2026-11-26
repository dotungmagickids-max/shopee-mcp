import { db } from "@/lib/supabase";
import { exchangeCode } from "@/lib/tiktok/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TTL_MS = 15 * 60 * 1000;

/** TikTok chuyển về đây sau khi ủy quyền (Redirect URL của app): đổi code lấy token và lưu. */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const back = (msg: string) => Response.redirect(`${url.origin}/admin/tiktok?msg=${encodeURIComponent(msg)}`, 303);
  const state = url.searchParams.get("state");
  const code = url.searchParams.get("code");
  if (!code) return back("Ủy quyền lỗi: TikTok không trả code.");
  if (!state || !/^[0-9a-f-]{36}$/i.test(state)) {
    return back("Thiếu mã yêu cầu. Hãy bấm nút Ủy quyền trên trang này (không dùng link copy trực tiếp).");
  }

  const { data: pending } = await db()
    .from("tiktok_auth_requests")
    .update({ consumed_at: new Date().toISOString() })
    .eq("id", state)
    .is("consumed_at", null)
    .gt("created_at", new Date(Date.now() - TTL_MS).toISOString())
    .select("id")
    .maybeSingle();
  if (!pending) return back("Link ủy quyền đã hết hạn hoặc đã dùng. Bấm Ủy quyền lại.");

  try {
    const r = await exchangeCode(code);
    const kind = r.user_type === 1 ? "kênh TikTok (Creator)" : "shop";
    const shops = r.shops.length ? `: ${r.shops.map((s) => s.name).join(", ")}` : "";
    return back(`Đã ủy quyền ${kind} ${r.name}${shops}.`);
  } catch (err) {
    return back(`Ủy quyền lỗi: ${err instanceof Error ? err.message : String(err)}`);
  }
}
