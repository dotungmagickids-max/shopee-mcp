import { verifyApiKey, type ApiKeyContext } from "@/lib/api-keys";
import { escapeHtml, htmlPage } from "@/lib/html";
import { createAuthCode, getClient, type OAuthClient } from "@/lib/oauth";
import { isValidCodeChallenge, mergeContexts, parsePastedKeys } from "@/lib/oauth-core";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type AuthParams = {
  client: OAuthClient;
  redirectUri: string;
  state: string | null;
  codeChallenge: string;
  resource: string | null;
};

function errorPage(message: string, status = 400): Response {
  return htmlPage(
    "Authorization failed",
    `<h1>Authorization failed</h1><p class="error">${escapeHtml(message)}</p>`,
    status
  );
}

/**
 * Validates the request. Problems with client_id / redirect_uri are shown on a page
 * (never redirected, to avoid open redirects); others are reported to the client.
 */
async function parseParams(get: (name: string) => string | null): Promise<AuthParams | Response> {
  const client = await getClient(get("client_id"));
  if (!client) return errorPage("Unknown client. Remove the connector and add it again.");
  const redirectUri = get("redirect_uri") ?? (client.redirect_uris.length === 1 ? client.redirect_uris[0] : null);
  if (!redirectUri || !client.redirect_uris.includes(redirectUri)) {
    return errorPage("This redirect address is not registered for the client.");
  }
  const state = get("state");
  const fail = (error: string, description: string) => {
    const url = new URL(redirectUri);
    url.searchParams.set("error", error);
    url.searchParams.set("error_description", description);
    if (state) url.searchParams.set("state", state);
    return Response.redirect(url.toString(), 302);
  };
  if (get("response_type") !== "code") return fail("unsupported_response_type", "Only response_type=code is supported.");
  const codeChallenge = get("code_challenge");
  if (get("code_challenge_method") !== "S256" || !isValidCodeChallenge(codeChallenge)) {
    return fail("invalid_request", "PKCE with code_challenge_method=S256 is required.");
  }
  return { client, redirectUri, state, codeChallenge, resource: get("resource") };
}

function consentPage(p: AuthParams, error?: string): Response {
  const hidden = (name: string, value: string | null) =>
    value === null ? "" : `<input type="hidden" name="${name}" value="${escapeHtml(value)}">`;
  const clientName = p.client.client_name ?? "An MCP client";
  return htmlPage(
    "Connect Shopee MCP",
    `<h1>Connect your Shopee shop</h1>
<p class="lead"><b>${escapeHtml(clientName)}</b> wants to access your shop through Shopee MCP.</p>
${error ? `<p class="error">${escapeHtml(error)}</p>` : ""}
<form method="post" action="/api/oauth/authorize" class="card" autocomplete="off">
  ${hidden("client_id", p.client.client_id)}
  ${hidden("redirect_uri", p.redirectUri)}
  ${hidden("state", p.state)}
  ${hidden("code_challenge", p.codeChallenge)}
  ${hidden("code_challenge_method", "S256")}
  ${hidden("response_type", "code")}
  ${hidden("resource", p.resource)}
  <fieldset>
    <legend>Your API key(s)</legend>
    <p><small>Paste the <code>smcp_…</code> key you received after connecting a shop on the
    <a href="/" target="_blank" rel="noopener">home page</a>. To give access to several shops,
    paste one key per line. The connection gets the shops and access level of these keys
    (write access only if every key has it).</small></p>
    <textarea name="keys" rows="4" required spellcheck="false" placeholder="smcp_…"></textarea>
  </fieldset>
  <button type="submit" name="decision" value="allow">Allow access</button>
  <button type="submit" name="decision" value="deny" formnovalidate class="secondary">Cancel</button>
</form>`
  );
}

export async function GET(request: Request): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const parsed = await parseParams((n) => params.get(n));
  return parsed instanceof Response ? parsed : consentPage(parsed);
}

export async function POST(request: Request): Promise<Response> {
  const form = await request.formData();
  const get = (n: string) => {
    const v = form.get(n);
    return typeof v === "string" && v !== "" ? v : null;
  };
  const parsed = await parseParams(get);
  if (parsed instanceof Response) return parsed;

  const back = new URL(parsed.redirectUri);
  if (parsed.state) back.searchParams.set("state", parsed.state);

  if (get("decision") !== "allow") {
    back.searchParams.set("error", "access_denied");
    return Response.redirect(back.toString(), 302);
  }

  const keys = parsePastedKeys(get("keys") ?? "");
  if (keys.length === 0) return consentPage(parsed, "Paste at least one key starting with smcp_.");
  const contexts: ApiKeyContext[] = [];
  for (const key of keys) {
    const ctx = await verifyApiKey(key);
    if (!ctx) return consentPage(parsed, `Key ${key.slice(0, 11)}… is invalid or revoked.`);
    contexts.push(ctx);
  }
  const merged = mergeContexts(contexts);
  if ("error" in merged) return consentPage(parsed, merged.error);

  const code = await createAuthCode({
    clientId: parsed.client.client_id,
    redirectUri: parsed.redirectUri,
    codeChallenge: parsed.codeChallenge,
    apiKeyIds: contexts.map((c) => c.id),
    resource: parsed.resource,
  });
  back.searchParams.set("code", code);
  return Response.redirect(back.toString(), 302);
}
