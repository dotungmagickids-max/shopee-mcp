import { ShopeeRegion } from "@congminh1254/shopee-sdk/schemas/region";

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable ${name}`);
  }
  return value;
}

export function supabaseEnv() {
  return {
    url: required("SUPABASE_URL"),
    serviceRoleKey: required("SUPABASE_SERVICE_ROLE_KEY"),
  };
}

/**
 * Partner credentials for a region. Region-specific variables
 * (e.g. SHOPEE_PARTNER_ID_TEST_GLOBAL) win over the shared SHOPEE_PARTNER_ID,
 * since sandbox and China apps usually have their own partner id/key.
 */
export function partnerCredentials(region: ShopeeRegion): { partnerId: number; partnerKey: string } | null {
  const id = process.env[`SHOPEE_PARTNER_ID_${region}`] ?? process.env.SHOPEE_PARTNER_ID;
  const key = process.env[`SHOPEE_PARTNER_KEY_${region}`] ?? process.env.SHOPEE_PARTNER_KEY;
  if (!id || !key) return null;
  return { partnerId: Number(id), partnerKey: key };
}

/** Public base URL of this deployment, used to build the Shopee redirect URL. */
export function appUrl(request: Request): string {
  if (process.env.APP_URL) return process.env.APP_URL.replace(/\/$/, "");
  return new URL(request.url).origin;
}
