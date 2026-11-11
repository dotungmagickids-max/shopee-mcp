import { ADMIN_COOKIE } from "@/lib/autopilot/admin-auth";

export const runtime = "nodejs";

export async function POST(request: Request) {
  return new Response(null, {
    status: 303,
    headers: {
      Location: `${new URL(request.url).origin}/admin/login`,
      "Set-Cookie": `${ADMIN_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`,
    },
  });
}
