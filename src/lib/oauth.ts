/**
 * OAuth storage: clients, authorization codes and tokens in Supabase.
 * Tokens map to existing api_keys rows, so revoking an smcp_ key also cuts off
 * every OAuth session that was built on it.
 */
import type { ShopeeRegion } from "@congminh1254/shopee-sdk/schemas/region";
import type { ApiKeyContext } from "./api-keys";
import {
  ACCESS_TOKEN_PREFIX,
  ACCESS_TOKEN_TTL_S,
  CLIENT_PREFIX,
  CODE_PREFIX,
  CODE_TTL_MS,
  mergeContexts,
  randomToken,
  REFRESH_TOKEN_PREFIX,
  REFRESH_TOKEN_TTL_S,
  sha256Hex,
} from "./oauth-core";
import type { Access } from "./regions";
import { db } from "./supabase";

export type OAuthClient = { client_id: string; client_name: string | null; redirect_uris: string[] };

export async function registerClient(input: { clientName: string | null; redirectUris: string[] }): Promise<OAuthClient> {
  const client = {
    client_id: randomToken(CLIENT_PREFIX),
    client_name: input.clientName,
    redirect_uris: input.redirectUris,
  };
  const { error } = await db().from("oauth_clients").insert(client);
  if (error) throw new Error(`Failed to register client: ${error.message}`);
  return client;
}

export async function getClient(clientId: string | null): Promise<OAuthClient | null> {
  if (!clientId?.startsWith(CLIENT_PREFIX)) return null;
  const { data, error } = await db()
    .from("oauth_clients")
    .select("client_id, client_name, redirect_uris")
    .eq("client_id", clientId)
    .maybeSingle();
  if (error || !data) return null;
  return data as OAuthClient;
}

/** Loads non-revoked API keys by id as contexts. */
export async function loadApiKeys(ids: string[]): Promise<ApiKeyContext[]> {
  if (ids.length === 0) return [];
  const { data, error } = await db()
    .from("api_keys")
    .select("id, access, region, shop_ids, label, revoked_at")
    .in("id", ids);
  if (error || !data) return [];
  return (data as Record<string, unknown>[])
    .filter((row) => !row.revoked_at)
    .map((row) => ({
      id: row.id as string,
      access: row.access as Access,
      region: row.region as ShopeeRegion,
      shopIds: (row.shop_ids as (number | string)[]).map(Number),
      label: (row.label as string | null) ?? null,
    }));
}

export async function createAuthCode(input: {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  apiKeyIds: string[];
  resource: string | null;
}): Promise<string> {
  const code = randomToken(CODE_PREFIX);
  const { error } = await db()
    .from("oauth_codes")
    .insert({
      code_hash: sha256Hex(code),
      client_id: input.clientId,
      redirect_uri: input.redirectUri,
      code_challenge: input.codeChallenge,
      api_key_ids: input.apiKeyIds,
      resource: input.resource,
      expires_at: new Date(Date.now() + CODE_TTL_MS).toISOString(),
    });
  if (error) throw new Error(`Failed to create authorization code: ${error.message}`);
  return code;
}

/** Marks the code used and returns it, or null if unknown, expired or already used. */
export async function consumeAuthCode(code: string | null): Promise<{
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  api_key_ids: string[];
} | null> {
  if (!code?.startsWith(CODE_PREFIX)) return null;
  const { data, error } = await db()
    .from("oauth_codes")
    .update({ consumed_at: new Date().toISOString() })
    .eq("code_hash", sha256Hex(code))
    .is("consumed_at", null)
    .gt("expires_at", new Date().toISOString())
    .select("client_id, redirect_uri, code_challenge, api_key_ids")
    .maybeSingle();
  if (error || !data) return null;
  return data as { client_id: string; redirect_uri: string; code_challenge: string; api_key_ids: string[] };
}

export type TokenResponse = {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  refresh_token: string;
  scope: string;
};

export async function issueTokens(clientId: string, apiKeyIds: string[]): Promise<TokenResponse> {
  const accessToken = randomToken(ACCESS_TOKEN_PREFIX);
  const refreshToken = randomToken(REFRESH_TOKEN_PREFIX);
  const now = Date.now();
  const { error } = await db()
    .from("oauth_tokens")
    .insert([
      {
        token_hash: sha256Hex(accessToken),
        kind: "access",
        client_id: clientId,
        api_key_ids: apiKeyIds,
        expires_at: new Date(now + ACCESS_TOKEN_TTL_S * 1000).toISOString(),
      },
      {
        token_hash: sha256Hex(refreshToken),
        kind: "refresh",
        client_id: clientId,
        api_key_ids: apiKeyIds,
        expires_at: new Date(now + REFRESH_TOKEN_TTL_S * 1000).toISOString(),
      },
    ]);
  if (error) throw new Error(`Failed to issue tokens: ${error.message}`);
  return {
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: ACCESS_TOKEN_TTL_S,
    refresh_token: refreshToken,
    scope: "shopee",
  };
}

/** Revokes a refresh token and returns its key ids, if it is valid for this client. */
export async function consumeRefreshToken(token: string | null, clientId: string): Promise<string[] | null> {
  if (!token?.startsWith(REFRESH_TOKEN_PREFIX)) return null;
  const { data, error } = await db()
    .from("oauth_tokens")
    .update({ revoked_at: new Date().toISOString() })
    .eq("token_hash", sha256Hex(token))
    .eq("kind", "refresh")
    .eq("client_id", clientId)
    .is("revoked_at", null)
    .gt("expires_at", new Date().toISOString())
    .select("api_key_ids")
    .maybeSingle();
  if (error || !data) return null;
  return data.api_key_ids as string[];
}

export function isAccessToken(token: string | null): token is string {
  return !!token?.startsWith(ACCESS_TOKEN_PREFIX);
}

/** Resolves an OAuth access token to the merged context of its underlying API keys. */
export async function contextFromAccessToken(token: string): Promise<ApiKeyContext | null> {
  const { data, error } = await db()
    .from("oauth_tokens")
    .select("api_key_ids, expires_at, revoked_at")
    .eq("token_hash", sha256Hex(token))
    .eq("kind", "access")
    .maybeSingle();
  if (error || !data || data.revoked_at) return null;
  if (new Date(data.expires_at as string).getTime() <= Date.now()) return null;
  const merged = mergeContexts(await loadApiKeys(data.api_key_ids as string[]));
  return "error" in merged ? null : merged;
}
