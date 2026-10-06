import { ShopeeSDK } from "@congminh1254/shopee-sdk";
import type { ShopeeRegion } from "@congminh1254/shopee-sdk/schemas/region";
import type { AccessToken } from "@congminh1254/shopee-sdk/schemas/access-token";
import type { TokenStorage } from "@congminh1254/shopee-sdk/storage";
import { partnerCredentials } from "./env";
import { db } from "./supabase";

/**
 * TokenStorage backed by the `shopee_tokens` table, scoped to one shop.
 * The SDK calls get() before each request and store() after a refresh.
 */
export class SupabaseTokenStorage implements TokenStorage {
  constructor(
    private readonly region: ShopeeRegion,
    private readonly shopId: number
  ) {}

  async store(token: AccessToken): Promise<void> {
    const { error } = await db()
      .from("shopee_tokens")
      .upsert({
        region: this.region,
        shop_id: this.shopId,
        access_token: token.access_token,
        refresh_token: token.refresh_token,
        expired_at: token.expired_at ?? Date.now() + token.expire_in * 1000 - 60_000,
        updated_at: new Date().toISOString(),
      });
    if (error) throw new Error(`Failed to store Shopee token: ${error.message}`);
  }

  async get(): Promise<AccessToken | null> {
    const { data, error } = await db()
      .from("shopee_tokens")
      .select("access_token, refresh_token, expired_at")
      .eq("region", this.region)
      .eq("shop_id", this.shopId)
      .maybeSingle();
    if (error) throw new Error(`Failed to load Shopee token: ${error.message}`);
    if (!data) return null;
    return {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expired_at: Number(data.expired_at),
      expire_in: Math.max(0, Math.floor((Number(data.expired_at) - Date.now()) / 1000)),
      shop_id: this.shopId,
      request_id: "",
      error: "",
      message: "",
    };
  }

  async clear(): Promise<void> {
    await db().from("shopee_tokens").delete().eq("region", this.region).eq("shop_id", this.shopId);
  }
}

/** SDK instance without a shop (for building auth URLs and exchanging codes). */
export function partnerSdk(region: ShopeeRegion, tokenStorage?: TokenStorage): ShopeeSDK {
  const creds = partnerCredentials(region);
  if (!creds) {
    throw new Error(`No Shopee partner credentials configured for region ${region}`);
  }
  return new ShopeeSDK(
    { partner_id: creds.partnerId, partner_key: creds.partnerKey, region },
    tokenStorage
  );
}

/** SDK instance acting on behalf of one authorized shop. */
export function shopSdk(region: ShopeeRegion, shopId: number): ShopeeSDK {
  return partnerSdk(region, new SupabaseTokenStorage(region, shopId));
}
