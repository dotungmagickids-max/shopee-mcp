import { NextResponse, type NextRequest } from "next/server";
import { isPublicHost, sitePathAction } from "@/lib/site-host";

/** Chỉ tác động khi vào bằng magickids.vn / www.magickids.vn; host khác đi qua nguyên vẹn. */
export function proxy(req: NextRequest) {
  if (!isPublicHost(req.headers.get("host"))) return NextResponse.next();
  const action = sitePathAction(req.nextUrl.pathname);
  if (action.kind === "rewrite") return NextResponse.rewrite(new URL(action.to, req.url));
  if (action.kind === "redirect") return NextResponse.redirect(new URL(action.to, req.url), 307);
  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image).*)"],
};
