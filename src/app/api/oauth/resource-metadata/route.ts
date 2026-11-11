import { appUrl } from "@/lib/env";
import { CORS_HEADERS, protectedResourceMetadata } from "@/lib/oauth-core";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** RFC 9728 metadata, served at /.well-known/oauth-protected-resource via a rewrite. */
export function GET(request: Request): Response {
  return Response.json(protectedResourceMetadata(appUrl(request)), { headers: CORS_HEADERS });
}

export function OPTIONS(): Response {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}
