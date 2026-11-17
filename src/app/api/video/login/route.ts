import { checkVideoPassword, newVideoSession, VIDEO_COOKIE } from "@/lib/video/ui-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const form = await request.formData();
  const origin = new URL(request.url).origin;
  if (!checkVideoPassword(String(form.get("password") ?? ""))) {
    await new Promise((r) => setTimeout(r, 1000));
    return Response.redirect(`${origin}/video/login?error=1`, 303);
  }
  const { value, maxAge } = newVideoSession();
  return new Response(null, {
    status: 303,
    headers: {
      Location: `${origin}/video`,
      "Set-Cookie": `${VIDEO_COOKIE}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`,
    },
  });
}
