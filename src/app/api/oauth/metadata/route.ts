import { appUrl } from "@/lib/env";
import { authorizationServerMetadata, CORS_HEADERS } from "@/lib/oauth-core";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** RFC 8414 metadata, served at /.well-known/oauth-authorization-server via a rewrite. */
export function GET(request: Request): Response {
  return Response.json(authorizationServerMetadata(appUrl(request)), { headers: CORS_HEADERS });
}

export function OPTIONS(): Response {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}
