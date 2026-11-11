import { ShopeeSDK } from "@congminh1254/shopee-sdk";
import type { ShopeeRegion } from "@congminh1254/shopee-sdk/schemas/region";
import type { AccessToken } from "@congminh1254/shopee-sdk/schemas/access-token";
import type { TokenStorage } from "@congminh1254/shopee-sdk/storage";
import { partnerCredentials } from "./env";
import { db } from "./supabase";
import { decryptToken, encryptToken } from "./token-crypto";

const LOCK_SECONDS = 30;

/**
 * TokenStorage backed by the `shopee_tokens` table, scoped to one shop.
 * The SDK calls get() before each request and store() after a refresh.
 * Tokens are encrypted at rest when TOKEN_ENC_KEY is set (see token-crypto.ts).
 */
export class SupabaseTokenStorage implements TokenStorage {
  /** access_token seen by the last get(), used to detect a refresh done by another process. */
  lastSeenAccessToken: string | null = null;

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
        access_token: encryptToken(token.access_token),
        refresh_token: encryptToken(token.refresh_token),
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
    const accessToken = decryptToken(data.access_token);
    this.lastSeenAccessToken = accessToken;
    return {
      access_token: accessToken,
      refresh_token: decryptToken(data.refresh_token),
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

  /** Atomically takes the refresh lock for this shop. Returns false if another process holds it. */
  async tryLock(): Promise<boolean> {
    const now = new Date();
    const { data, error } = await db()
      .from("shopee_tokens")
      .update({ refresh_lock_until: new Date(now.getTime() + LOCK_SECONDS * 1000).toISOString() })
      .eq("region", this.region)
      .eq("shop_id", this.shopId)
      .or(`refresh_lock_until.is.null,refresh_lock_until.lt.${now.toISOString()}`)
      .select("shop_id");
    // Older databases without the column: fall back to no locking.
    if (error) return /refresh_lock_until/.test(error.message);
    return (data?.length ?? 0) > 0;
  }

  async unlock(): Promise<void> {
    await db()
      .from("shopee_tokens")
      .update({ refresh_lock_until: null })
      .eq("region", this.region)
      .eq("shop_id", this.shopId)
      .then(undefined, () => undefined);
  }
}

/**
 * ShopeeSDK whose token refresh is serialized across processes with a row lock,
 * because Shopee refresh tokens are single-use: two concurrent refreshes break the chain.
 */
class LockedShopeeSDK extends ShopeeSDK {
  constructor(
    config: ConstructorParameters<typeof ShopeeSDK>[0],
    private readonly storage: SupabaseTokenStorage
  ) {
    super(config, storage);
  }

  override async refreshToken(shop_id?: number, merchant_id?: number): Promise<AccessToken | null> {
    const seen = this.storage.lastSeenAccessToken;
    const deadline = Date.now() + 20_000;
    while (!(await this.storage.tryLock())) {
      if (Date.now() > deadline) throw new Error("Timed out waiting for Shopee token refresh lock");
      await new Promise((r) => setTimeout(r, 1000));
      const current = await this.storage.get();
      if (current && current.access_token !== seen && (current.expired_at ?? 0) > Date.now()) return current;
    }
    try {
      // Another process may have refreshed between our read and taking the lock.
      const current = await this.storage.get();
      if (current && seen && current.access_token !== seen && (current.expired_at ?? 0) > Date.now()) return current;
      return await super.refreshToken(shop_id, merchant_id);
    } finally {
      await this.storage.unlock();
    }
  }
}

/** SDK instance without a shop (for building auth URLs and exchanging codes). */
export function partnerSdk(region: ShopeeRegion, tokenStorage?: TokenStorage): ShopeeSDK {
  const creds = partnerCredentials(region);
  if (!creds) {
    throw new Error(`No Shopee partner credentials configured for region ${region}`);
  }
  const config = { partner_id: creds.partnerId, partner_key: creds.partnerKey, region };
  if (tokenStorage instanceof SupabaseTokenStorage) return new LockedShopeeSDK(config, tokenStorage);
  return new ShopeeSDK(config, tokenStorage);
}

/** SDK instance acting on behalf of one authorized shop. */
export function shopSdk(region: ShopeeRegion, shopId: number): ShopeeSDK {
  return partnerSdk(region, new SupabaseTokenStorage(region, shopId));
}
