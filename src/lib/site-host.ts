/**
 * Định tuyến theo tên miền cho trang công khai magickids.vn.
 * Host công ty (magickids.vn, www.magickids.vn) chỉ thấy trang giới thiệu, /terms, /privacy và /api/*;
 * mọi khu quản trị khác bị đưa về trang chủ. Host khác (vercel.app, localhost) giữ nguyên.
 */
export const PUBLIC_HOSTS = ["magickids.vn", "www.magickids.vn"];

export function isPublicHost(hostHeader: string | null | undefined): boolean {
  if (!hostHeader) return false;
  const host = hostHeader.toLowerCase().split(":")[0].replace(/\.$/, "");
  return PUBLIC_HOSTS.includes(host);
}

const ALLOWED_EXACT = new Set([
  "/terms",
  "/privacy",
  "/styles.css",
  "/magickids-logo-1024.png",
  "/favicon.ico",
  "/robots.txt",
]);
const ALLOWED_PREFIX = ["/api/", "/.well-known/", "/_next/", "/site/"];

export type SiteAction = { kind: "rewrite"; to: string } | { kind: "redirect"; to: string } | { kind: "pass" };

/** Quyết định xử lý một đường dẫn khi truy cập bằng host công ty. */
export function sitePathAction(pathname: string): SiteAction {
  if (pathname === "/" || pathname === "") return { kind: "rewrite", to: "/site/index.html" };
  const p = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  if (ALLOWED_EXACT.has(p) || ALLOWED_PREFIX.some((x) => p.startsWith(x) || p + "/" === x)) return { kind: "pass" };
  return { kind: "redirect", to: "/" };
}
