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

export function isDryRun(): boolean {
  return process.env.AUTOPILOT_DRY_RUN !== "false";
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
