import { ADMIN_COOKIE, checkPassword, newSessionValue } from "@/lib/autopilot/admin-auth";
import { sendAlertOnce } from "@/lib/autopilot/telegram";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const form = await request.formData();
  const password = String(form.get("password") ?? "");
  const origin = new URL(request.url).origin;
  if (!checkPassword(password)) {
    await new Promise((r) => setTimeout(r, 1000));
    await sendAlertOnce("admin-login-failed", "🔐 Có người nhập sai mật khẩu dashboard /admin.", 60).catch(() => false);
    return Response.redirect(`${origin}/admin/login?error=1`, 303);
  }
  const { value, maxAge } = newSessionValue();
  return new Response(null, {
    status: 303,
    headers: {
      Location: `${origin}/admin`,
      "Set-Cookie": `${ADMIN_COOKIE}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`,
    },
  });
}
