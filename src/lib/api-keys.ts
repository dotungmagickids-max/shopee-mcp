import { createHash, randomBytes } from "node:crypto";
import type { ShopeeRegion } from "@congminh1254/shopee-sdk/schemas/region";
import type { Access } from "./regions";
import { db } from "./supabase";

const KEY_PREFIX = "smcp_";

export type ApiKeyContext = {
  id: string;
  access: Access;
  region: ShopeeRegion;
  shopIds: number[];
  label: string | null;
};

export function hashKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

/** Creates a key for the given shops. The plaintext key is returned once and never stored. */
export async function createApiKey(input: {
  access: Access;
  region: ShopeeRegion;
  shopIds: number[];
  label: string | null;
}): Promise<string> {
  const key = KEY_PREFIX + randomBytes(32).toString("base64url");
  const { error } = await db()
    .from("api_keys")
    .insert({
      key_hash: hashKey(key),
      key_prefix: key.slice(0, KEY_PREFIX.length + 6),
      label: input.label,
      access: input.access,
      region: input.region,
      shop_ids: input.shopIds,
    });
  if (error) throw new Error(`Failed to create API key: ${error.message}`);
  return key;
}

/** Extracts the key from `Authorization: Bearer …` or `X-API-Key`. */
export function keyFromRequest(request: Request): string | null {
  const auth = request.headers.get("authorization");
  if (auth?.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim();
  return request.headers.get("x-api-key")?.trim() || null;
}

export async function verifyApiKey(key: string | null): Promise<ApiKeyContext | null> {
  if (!key?.startsWith(KEY_PREFIX)) return null;
  const { data, error } = await db()
    .from("api_keys")
    .select("id, access, region, shop_ids, label, revoked_at")
    .eq("key_hash", hashKey(key))
    .maybeSingle();
  if (error || !data || data.revoked_at) return null;

  // Best effort; don't fail the request on it.
  await db()
    .from("api_keys")
    .update({ last_used_at: new Date().toISOString() })
    .eq("id", data.id)
    .then(undefined, () => undefined);

  return {
    id: data.id,
    access: data.access,
    region: data.region,
    shopIds: (data.shop_ids as (number | string)[]).map(Number),
    label: data.label,
  };
}

export async function revokeApiKey(key: string): Promise<boolean> {
  const { data, error } = await db()
    .from("api_keys")
    .update({ revoked_at: new Date().toISOString() })
    .eq("key_hash", hashKey(key))
    .is("revoked_at", null)
    .select("id");
  if (error) throw new Error(`Failed to revoke API key: ${error.message}`);
  return (data?.length ?? 0) > 0;
}
