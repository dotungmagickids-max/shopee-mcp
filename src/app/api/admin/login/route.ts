import { ADMIN_COOKIE, checkPassword, newSessionValue } from "@/lib/autopilot/admin-auth";
import { sendAlertOnce } from "@/lib/autopilot/telegram";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const form = await request.formData();
  const password = String(form.get("password") ?? "");
  const origin = new URL(request.url).origin;
  // Chỉ cho quay về đường dẫn nội bộ (vd /fb), không chuyển ra trang ngoài.
  const nextRaw = String(form.get("next") ?? "");
  const next = /^\/(admin|fb)(\/|$|\?)/.test(nextRaw) ? nextRaw : "/admin";
  if (!checkPassword(password)) {
    await new Promise((r) => setTimeout(r, 1000));
    await sendAlertOnce("admin-login-failed", "🔐 Có người nhập sai mật khẩu dashboard /admin.", 60).catch(() => false);
    return Response.redirect(`${origin}/admin/login?error=1${next !== "/admin" ? `&next=${encodeURIComponent(next)}` : ""}`, 303);
  }
  const { value, maxAge } = newSessionValue();
  return new Response(null, {
    status: 303,
    headers: {
      Location: `${origin}${next}`,
      "Set-Cookie": `${ADMIN_COOKIE}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`,
    },
  });
}
