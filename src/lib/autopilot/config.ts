import { timingSafeEqual } from "node:crypto";

export interface ShopConf {
  shopId: number;
  name: string;
}

/**
 * Shop do autopilot theo dõi. Ghi đè bằng AUTOPILOT_SHOPS="92907330:Magickids,971643674:Annie Baby".
 */
export function shops(): ShopConf[] {
  const raw = process.env.AUTOPILOT_SHOPS ?? "92907330:Magickids,971643674:Annie Baby - Váy bé gái";
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const [id, ...name] = s.split(":");
      return { shopId: Number(id), name: name.join(":") || id };
    });
}

export function shopName(shopId: number): string {
  return shops().find((s) => s.shopId === shopId)?.name ?? String(shopId);
}

/** Hành động được chạy thật dù đang dry-run, vd AUTOPILOT_LIVE_ACTIONS="change_budget". */
export function liveActions(): string[] {
  return (process.env.AUTOPILOT_LIVE_ACTIONS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Dry-run: chỉ ghi log, không gửi Shopee. Mặc định bật; AUTOPILOT_DRY_RUN=false tắt cho mọi hành động.
 * Khi truyền action, hành động có trong AUTOPILOT_LIVE_ACTIONS được chạy thật.
 */
export function isDryRun(action?: string): boolean {
  if (process.env.AUTOPILOT_DRY_RUN === "false") return false;
  return !(action && liveActions().includes(action));
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** Kiểm tra header `Authorization: Bearer <JOB_SECRET>` của các job route. */
export function checkJobSecret(request: Request): boolean {
  const secret = process.env.JOB_SECRET;
  if (!secret) return false;
  const header = request.headers.get("authorization") ?? "";
  return safeEqual(header, `Bearer ${secret}`);
}
