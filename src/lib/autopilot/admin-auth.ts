import { createHmac } from "node:crypto";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { safeEqual } from "./config";

export const ADMIN_COOKIE = "mk_admin";
const SESSION_DAYS = 30;

function secret(): string | null {
  const pw = process.env.ADMIN_PASSWORD;
  if (!pw) return null;
  // Đổi ADMIN_PASSWORD là mọi phiên cũ hết hiệu lực.
  return `${process.env.ADMIN_SESSION_SECRET ?? process.env.JOB_SECRET ?? ""}|${pw}`;
}

function sign(payload: string, key: string): string {
  return createHmac("sha256", key).update(payload).digest("base64url");
}

export function checkPassword(input: string): boolean {
  const pw = process.env.ADMIN_PASSWORD;
  return !!pw && safeEqual(input, pw);
}

export function newSessionValue(): { value: string; maxAge: number } {
  const key = secret();
  if (!key) throw new Error("ADMIN_PASSWORD chưa cấu hình");
  const exp = Math.floor(Date.now() / 1000) + SESSION_DAYS * 86400;
  return { value: `${exp}.${sign(String(exp), key)}`, maxAge: SESSION_DAYS * 86400 };
}

export function isValidSession(value: string | undefined): boolean {
  const key = secret();
  if (!key || !value) return false;
  const [exp, sig] = value.split(".");
  if (!exp || !sig || Number(exp) < Date.now() / 1000) return false;
  return safeEqual(sig, sign(exp, key));
}

/** Dùng trong server component / route: chưa đăng nhập thì chuyển về trang đăng nhập. */
export async function requireAdmin(): Promise<void> {
  const jar = await cookies();
  if (!isValidSession(jar.get(ADMIN_COOKIE)?.value)) redirect("/admin/login");
}

/** Dùng trong route handler: trả về Response 401 nếu chưa đăng nhập. */
export function adminFromRequest(request: Request): boolean {
  const cookie = request.headers.get("cookie") ?? "";
  const match = cookie.split(/;\s*/).find((c) => c.startsWith(`${ADMIN_COOKIE}=`));
  return isValidSession(match ? decodeURIComponent(match.slice(ADMIN_COOKIE.length + 1)) : undefined);
}
