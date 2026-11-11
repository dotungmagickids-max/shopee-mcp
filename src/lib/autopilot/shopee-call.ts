import { ShopeeRegion } from "@congminh1254/shopee-sdk/schemas/region";
import { catalog } from "../catalog.generated";
import { shopSdk } from "../shopee";
import { db } from "../supabase";

const endpointsById = new Map(catalog.map((e) => [e.id, e]));
const REGION = (process.env.AUTOPILOT_REGION as ShopeeRegion | undefined) ?? ShopeeRegion.GLOBAL;

export class ShopeeCallError extends Error {
  constructor(
    message: string,
    readonly kind: "auth" | "rate_limit" | "api" | "network",
    readonly data?: unknown
  ) {
    super(message);
  }
}

function classify(err: unknown): ShopeeCallError {
  if (err instanceof ShopeeCallError) return err;
  const e = err as { name?: string; status?: number; data?: { error?: string; message?: string } };
  if (e?.name === "ShopeeApiError") {
    const code = e.data?.error ?? "";
    const msg = `${code}: ${e.data?.message ?? ""} (HTTP ${e.status})`;
    if (/auth|access_token|refresh_token|permission/i.test(code)) return new ShopeeCallError(msg, "auth", e.data);
    if (e.status === 429 || /rate|limit|too_many|busy/i.test(code)) return new ShopeeCallError(msg, "rate_limit", e.data);
    if ((e.status ?? 0) >= 500 || /system|inner|timeout/i.test(code)) return new ShopeeCallError(msg, "network", e.data);
    return new ShopeeCallError(msg, "api", e.data);
  }
  const message = err instanceof Error ? err.message : String(err);
  if (/token/i.test(message)) return new ShopeeCallError(message, "auth");
  return new ShopeeCallError(message, "network");
}

/**
 * Gọi một endpoint Shopee cho autopilot: thử lại có backoff khi rate limit / lỗi mạng,
 * ghi audit_log (api_key_id = null, endpoint có tiền tố "autopilot:").
 * Giai đoạn 1 chỉ cho phép endpoint đọc.
 */
export async function callShopee<T = any>(
  shopId: number,
  endpointId: string,
  params: Record<string, unknown> = {},
  opts: { allowWrite?: boolean } = {}
): Promise<T> {
  const entry = endpointsById.get(endpointId);
  if (!entry) throw new Error(`Unknown endpoint ${endpointId}`);
  if (entry.access === "write" && !opts.allowWrite) {
    throw new Error(`Autopilot không được phép gọi endpoint ghi ${endpointId}`);
  }
  const sdk = shopSdk(REGION, shopId) as unknown as Record<string, Record<string, unknown>>;
  const manager = sdk[entry.sdkProperty];
  const method = manager?.[entry.sdkMethod] as ((p: unknown) => Promise<T>) | undefined;
  if (typeof method !== "function") throw new Error(`SDK has no method for ${endpointId}`);

  const delays = [1000, 4000, 10000];
  let lastErr: ShopeeCallError | null = null;
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    const started = Date.now();
    try {
      const result = await method.call(manager, params);
      // Lệnh đọc thành công không ghi audit (job 15 phút sẽ làm phình bảng); lỗi và lệnh ghi thì luôn ghi.
      if (entry.access === "write") await audit(shopId, endpointId, entry.access, true, null, Date.now() - started);
      return result;
    } catch (err) {
      lastErr = classify(err);
      await audit(shopId, endpointId, entry.access, false, lastErr.message, Date.now() - started);
      const retryable = lastErr.kind === "rate_limit" || lastErr.kind === "network";
      // Không bao giờ tự thử lại lệnh ghi: tránh gửi trùng.
      if (!retryable || entry.access === "write" || attempt === delays.length) break;
      await new Promise((r) => setTimeout(r, delays[attempt]));
    }
  }
  throw lastErr!;
}

async function audit(shopId: number, endpoint: string, access: string, ok: boolean, error: string | null, ms: number) {
  await db()
    .from("audit_log")
    .insert({
      api_key_id: null,
      shop_id: shopId,
      endpoint: `autopilot:${endpoint}`,
      access,
      ok,
      error: error?.slice(0, 1000) ?? null,
      duration_ms: ms,
    })
    .then(undefined, () => undefined);
}

/** Chia mảng thành lô. */
export function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}
