import { createHmac } from "node:crypto";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { ADMIN_COOKIE, isValidSession as isAdminSession } from "../autopilot/admin-auth";
import { safeEqual } from "../autopilot/config";

/**
 * Login for the /video page. It has its own password (VIDEO_UI_PASSWORD) so a
 * reviewer account (e.g. Shopee's Go-Live check) never gets the /admin password.
 * A valid /admin session is accepted too.
 */
export const VIDEO_COOKIE = "mk_video";
const SESSION_DAYS = 30;

function secret(): string | null {
  const pw = process.env.VIDEO_UI_PASSWORD;
  if (!pw) return null;
  return `video|${process.env.ADMIN_SESSION_SECRET ?? process.env.JOB_SECRET ?? ""}|${pw}`;
}

const sign = (payload: string, key: string) => createHmac("sha256", key).update(payload).digest("base64url");

export function checkVideoPassword(input: string): boolean {
  const pw = process.env.VIDEO_UI_PASSWORD;
  return !!pw && safeEqual(input, pw);
}

export function newVideoSession(): { value: string; maxAge: number } {
  const key = secret();
  if (!key) throw new Error("VIDEO_UI_PASSWORD chưa cấu hình");
  const exp = Math.floor(Date.now() / 1000) + SESSION_DAYS * 86400;
  return { value: `${exp}.${sign(String(exp), key)}`, maxAge: SESSION_DAYS * 86400 };
}

function isVideoSession(value: string | undefined): boolean {
  const key = secret();
  if (!key || !value) return false;
  const [exp, sig] = value.split(".");
  if (!exp || !sig || Number(exp) < Date.now() / 1000) return false;
  return safeEqual(sig, sign(exp, key));
}

function cookieFrom(header: string, name: string): string | undefined {
  const match = header.split(/;\s*/).find((c) => c.startsWith(`${name}=`));
  return match ? decodeURIComponent(match.slice(name.length + 1)) : undefined;
}

/** "video" for a /video login, "admin" for an /admin session, null if neither. */
export function videoUserFromRequest(request: Request): "video" | "admin" | null {
  const cookie = request.headers.get("cookie") ?? "";
  if (isAdminSession(cookieFrom(cookie, ADMIN_COOKIE))) return "admin";
  if (isVideoSession(cookieFrom(cookie, VIDEO_COOKIE))) return "video";
  return null;
}

export async function requireVideoUser(): Promise<"video" | "admin"> {
  const jar = await cookies();
  if (isAdminSession(jar.get(ADMIN_COOKIE)?.value)) return "admin";
  if (isVideoSession(jar.get(VIDEO_COOKIE)?.value)) return "video";
  redirect("/video/login");
}

/** Rejects cross-site form posts. */
export function sameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  return !origin || origin === new URL(request.url).origin;
}
