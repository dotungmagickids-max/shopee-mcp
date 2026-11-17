import { VIDEO_COOKIE } from "@/lib/video/ui-auth";

export const runtime = "nodejs";

export async function POST(request: Request) {
  return new Response(null, {
    status: 303,
    headers: {
      Location: `${new URL(request.url).origin}/video/login`,
      "Set-Cookie": `${VIDEO_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`,
    },
  });
}
