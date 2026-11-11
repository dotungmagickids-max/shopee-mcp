import { consumeAuthCode, consumeRefreshToken, getClient, issueTokens, loadApiKeys } from "@/lib/oauth";
import { CORS_HEADERS, mergeContexts, oauthError, verifyPkce } from "@/lib/oauth-core";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function readParams(request: Request): Promise<(name: string) => string | null> {
  const type = request.headers.get("content-type") ?? "";
  if (type.includes("application/json")) {
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    return (n) => (typeof body[n] === "string" ? (body[n] as string) : null);
  }
  const form = new URLSearchParams(await request.text());
  return (n) => form.get(n);
}

/** Token endpoint: authorization_code (with PKCE) and rotating refresh_token grants. */
export async function POST(request: Request): Promise<Response> {
  const get = await readParams(request);
  const client = await getClient(get("client_id"));
  if (!client) return oauthError("invalid_client", "Unknown client_id.", 401);

  let apiKeyIds: string[] | null;
  const grant = get("grant_type");
  if (grant === "authorization_code") {
    const code = await consumeAuthCode(get("code"));
    if (!code || code.client_id !== client.client_id) {
      return oauthError("invalid_grant", "Authorization code is invalid, expired or already used.");
    }
    const redirectUri = get("redirect_uri");
    if (redirectUri && redirectUri !== code.redirect_uri) {
      return oauthError("invalid_grant", "redirect_uri does not match the authorization request.");
    }
    if (!verifyPkce(get("code_verifier"), code.code_challenge)) {
      return oauthError("invalid_grant", "PKCE verification failed.");
    }
    apiKeyIds = code.api_key_ids;
  } else if (grant === "refresh_token") {
    apiKeyIds = await consumeRefreshToken(get("refresh_token"), client.client_id);
    if (!apiKeyIds) return oauthError("invalid_grant", "Refresh token is invalid, expired or already used.");
  } else {
    return oauthError("unsupported_grant_type", "Use authorization_code or refresh_token.");
  }

  // The underlying keys may have been revoked since; don't hand out tokens that can't work.
  if ("error" in mergeContexts(await loadApiKeys(apiKeyIds))) {
    return oauthError("invalid_grant", "The API keys behind this connection were revoked. Connect again.");
  }
  const tokens = await issueTokens(client.client_id, apiKeyIds);
  return Response.json(tokens, { headers: { ...CORS_HEADERS, "Cache-Control": "no-store", Pragma: "no-cache" } });
}

export function OPTIONS(): Response {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}
