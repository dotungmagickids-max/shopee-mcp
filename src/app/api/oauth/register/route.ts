import { registerClient } from "@/lib/oauth";
import { CORS_HEADERS, isAllowedRedirectUri, oauthError } from "@/lib/oauth-core";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Dynamic client registration (RFC 7591). Public clients with PKCE only. */
export async function POST(request: Request): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return oauthError("invalid_client_metadata", "Body must be JSON.");
  }
  const redirectUris = body.redirect_uris;
  if (!Array.isArray(redirectUris) || redirectUris.length === 0 || redirectUris.length > 10) {
    return oauthError("invalid_redirect_uri", "redirect_uris must be a non-empty array.");
  }
  if (!redirectUris.every(isAllowedRedirectUri)) {
    return oauthError("invalid_redirect_uri", "Redirect URIs must be https (or http on localhost).");
  }
  const clientName = typeof body.client_name === "string" ? body.client_name.slice(0, 200) : null;

  const client = await registerClient({ clientName, redirectUris: redirectUris as string[] });
  return Response.json(
    {
      client_id: client.client_id,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      client_name: client.client_name ?? undefined,
      redirect_uris: client.redirect_uris,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    },
    { status: 201, headers: { ...CORS_HEADERS, "Cache-Control": "no-store" } }
  );
}

export function OPTIONS(): Response {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}
