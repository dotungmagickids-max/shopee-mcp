import type { ShopeeRegion } from "@congminh1254/shopee-sdk/schemas/region";
import { createApiKey } from "@/lib/api-keys";
import { appUrl } from "@/lib/env";
import { escapeHtml, htmlPage } from "@/lib/html";
import type { Access } from "@/lib/regions";
import { partnerSdk, SupabaseTokenStorage } from "@/lib/shopee";
import { db } from "@/lib/supabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const REQUEST_TTL_MS = 15 * 60 * 1000;

function errorPage(message: string, status = 400): Response {
  return htmlPage(
    "Authorization failed",
    `<h1>Authorization failed</h1><p class="error">${escapeHtml(message)}</p><p><a href="/">Start over</a></p>`,
    status
  );
}

/**
 * Shopee redirects here after the seller approves the app. We exchange the code
 * for tokens, store them per shop and show a newly minted MCP API key once.
 */
export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const requestId = url.searchParams.get("request_id");
  const code = url.searchParams.get("code");
  const shopId = Number(url.searchParams.get("shop_id")) || undefined;
  const mainAccountId = Number(url.searchParams.get("main_account_id")) || undefined;

  if (!requestId || !code || (!shopId && !mainAccountId)) {
    return errorPage("Missing request_id, code or shop_id in the redirect from Shopee.");
  }

  // Consume the pending request exactly once.
  const { data: pending, error } = await db()
    .from("auth_requests")
    .update({ consumed_at: new Date().toISOString() })
    .eq("id", requestId)
    .is("consumed_at", null)
    .gt("created_at", new Date(Date.now() - REQUEST_TTL_MS).toISOString())
    .select("region, access, label")
    .maybeSingle();
  if (error || !pending) {
    return errorPage("This authorization link has expired or was already used.");
  }
  const region = pending.region as ShopeeRegion;
  const access = pending.access as Access;

  let shopIds: number[];
  try {
    const token = await partnerSdk(region).auth.getAccessToken(code, shopId, mainAccountId);
    shopIds = shopId ? [shopId] : (token.shop_id_list ?? []);
    if (shopIds.length === 0) {
      return errorPage("Shopee returned no shops for this account.");
    }
    await Promise.all(
      shopIds.map((id) => new SupabaseTokenStorage(region, id).store({ ...token, shop_id: id }))
    );
  } catch (err) {
    return errorPage(`Token exchange with Shopee failed: ${err instanceof Error ? err.message : String(err)}`, 502);
  }

  const key = await createApiKey({ access, region, shopIds, label: pending.label });
  const mcpUrl = `${appUrl(request)}/api/mcp`;

  const claudeCode = `claude mcp add --transport http shopee ${mcpUrl} --header "Authorization: Bearer ${key}"`;
  const jsonConfig = JSON.stringify(
    { mcpServers: { shopee: { type: "http", url: mcpUrl, headers: { Authorization: `Bearer ${key}` } } } },
    null,
    2
  );

  return htmlPage(
    "Your Shopee MCP key",
    `<h1>Shop connected</h1>
<p>Region <b>${escapeHtml(region)}</b> · shops <b>${shopIds.join(", ")}</b> · access
<b>${access === "read_write" ? "read + write" : "read only"}</b></p>
<h2>Your API key</h2>
<p class="warning">Copy it now — it is shown only once and cannot be recovered.</p>
<pre class="secret">${escapeHtml(key)}</pre>
<h2>Use it</h2>
<p>MCP endpoint (Streamable HTTP): <code>${escapeHtml(mcpUrl)}</code></p>
<p>Claude (web, desktop, mobile): add a custom connector with the URL above. When it asks you to sign in,
paste this key (one key per line to combine several shops).</p>
<p>Claude Code:</p>
<pre>${escapeHtml(claudeCode)}</pre>
<p>Clients that take a JSON config (Cursor, VS Code, …):</p>
<pre>${escapeHtml(jsonConfig)}</pre>
<p>Revoke it any time:</p>
<pre>${escapeHtml(`curl -X POST ${appUrl(request)}/api/keys/revoke -H "Authorization: Bearer ${key}"`)}</pre>
<p><a href="/">Connect another shop</a></p>`
  );
}
