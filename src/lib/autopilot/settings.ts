import { db } from "../supabase";
import { vnDate } from "./time";

/** Tham số luật mặc định; ghi đè từng shop qua autopilot_settings.rule_params. */
export const DEFAULT_RULE_PARAMS = {
  // Tăng ngân sách: đã tiêu ≥ spend_ratio ngân sách và ROAS hôm nay ≥ mục tiêu.
  scale_spend_ratio: 0.8,
  scale_step_pct: 20,
  scale_min_step: 50_000,
  // Tạm dừng tới 0h: ROAS khung window_hours giờ gần nhất (đã đủ giờ) quá thấp.
  cut_window_hours: 3,
  cut_min_clicks: 30,
  cut_min_expense: 50_000,
  cut_roas_ratio: 0.4, // ROAS khung < 40% mục tiêu
  cut_roas_floor: 3, // hoặc < 3 khi chiến dịch không có mục tiêu
  cut_day_roas_ratio: 0.6, // và ROAS cả ngày hôm nay < 60% mục tiêu (không dừng chiến dịch cả ngày vẫn tốt)
  // Chung
  cooldown_minutes: 60,
  proposal_ttl_minutes: 90,
  // ROAS mục tiêu hằng ngày (F4)
  roas_low_ratio: 0.8,
  roas_high_ratio: 1.2,
  roas_max_change_pct: 15,
  roas_min_week_expense: 200_000,
};

export type RuleParams = typeof DEFAULT_RULE_PARAMS;

export interface ShopSettings {
  shop_id: number;
  shop_name: string | null;
  mode: "off" | "suggest" | "auto";
  emergency_stop: boolean;
  halt_reason: string | null;
  daily_cap_normal: number | null;
  daily_cap_sale: number | null;
  campaign_cap: number | null;
  max_increase_pct: number;
  max_edits_per_day: number;
  start_budget: number;
  reset_unlimited: boolean;
  sale_dates: string[];
  params: RuleParams;
}

const numOrNull = (v: unknown) => (v == null ? null : Number(v));

export async function loadSettings(shopId: number): Promise<ShopSettings> {
  const { data, error } = await db().from("autopilot_settings").select("*").eq("shop_id", shopId).maybeSingle();
  if (error) throw new Error(error.message);
  const r = data ?? {};
  return {
    shop_id: shopId,
    shop_name: r.shop_name ?? null,
    mode: r.mode ?? "suggest",
    emergency_stop: !!r.emergency_stop,
    halt_reason: r.halt_reason ?? null,
    daily_cap_normal: numOrNull(r.daily_cap_normal),
    daily_cap_sale: numOrNull(r.daily_cap_sale),
    campaign_cap: numOrNull(r.campaign_cap),
    max_increase_pct: Math.min(30, Number(r.max_increase_pct ?? 30)),
    max_edits_per_day: Number(r.max_edits_per_day ?? 6),
    start_budget: Number(r.start_budget ?? 100_000),
    reset_unlimited: !!r.reset_unlimited,
    sale_dates: r.sale_dates ?? [],
    params: { ...DEFAULT_RULE_PARAMS, ...(r.rule_params ?? {}) },
  };
}

/** Ngày sale: ngày trùng tháng (1/1 … 12/12) hoặc ngày khai báo trong sale_dates. */
export function isSaleDay(s: ShopSettings, date = vnDate()): boolean {
  const [, m, d] = date.split("-").map(Number);
  return m === d || s.sale_dates.includes(date);
}

/** Trần tổng ngân sách/ngày đang áp dụng (null = chưa đặt). */
export function dailyCap(s: ShopSettings, date = vnDate()): number | null {
  return isSaleDay(s, date) ? s.daily_cap_sale ?? s.daily_cap_normal : s.daily_cap_normal;
}

/** Tool có được hoạt động (đề xuất/thực thi) không. */
export function automationBlocked(s: ShopSettings): string | null {
  if (s.emergency_stop) return s.halt_reason ? `Đang dừng: ${s.halt_reason}` : "Đang DỪNG KHẨN CẤP";
  if (s.mode === "off") return "Chế độ tắt";
  return null;
}

/** Chế độ auto chỉ được bật khi đã chạy đề xuất ≥ 7 ngày. */
export async function suggestDays(shopId: number): Promise<number> {
  const { data } = await db()
    .from("autopilot_actions")
    .select("created_at")
    .eq("shop_id", shopId)
    .like("source", "rule:%")
    .order("created_at", { ascending: true })
    .limit(1);
  if (!data?.length) return 0;
  return (Date.now() - Date.parse(data[0].created_at)) / 86400_000;
}
