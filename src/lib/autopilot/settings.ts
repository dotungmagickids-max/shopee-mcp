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
  throttle_buffer: 10_000, // siết: ngân sách mới = đã chi hôm nay + khoản này
  good_hours_weeks: 4, // khung giờ tốt tính từ số liệu N tuần gần nhất (bỏ ngày sale)
  // Chung
  cooldown_minutes: 60,
  proposal_ttl_minutes: 90,
  // ROAS mục tiêu hằng ngày (F4)
  roas_low_ratio: 0.8,
  roas_high_ratio: 1.2,
  roas_max_change_pct: 15,
  roas_min_week_expense: 200_000,
  // Lãi (giá vốn từ Pancake): ROAS cần = 1 / (lãi trước QC trên 1đ GMV − lãi mong muốn)
  profit_target_pct: 10, // lãi mong muốn sau quảng cáo, % giá bán
  extra_cost_per_unit: 0, // chi phí khác mỗi sản phẩm bán ra (đóng gói, nhân công…), đ
  use_profit_roas: 1, // 1 = luật dùng ROAS theo lãi thay cho ROAS mục tiêu đang đặt; 0 = tắt
  ad_fee_pct: 8, // phí nạp ví quảng cáo: chi QC thật = chi Shopee báo × (1 + %)
  return_fee_per_order: 2_700, // phí mỗi đơn hoàn / giao thất bại (đ)
  // Nhóm hàng: mục tiêu riêng (nhóm Thường dùng profit_target_pct)
  profit_core_pct: 8, // Chủ lực: lãi mong muốn thấp hơn để mở rộng, tối đa tổng lãi
  profit_new_pct: 0, // Mới: chạy ở mức hòa vốn để học
  clear_ads_share_pct: 60, // Xả kho: quảng cáo được dùng tối đa % tiền mặt thu về
  // Ngưỡng tự phân nhóm
  new_days: 30, // Mới: sản phẩm tạo trên Pancake chưa tới N ngày
  clear_stock_days: 120, // Xả kho: tồn đủ bán ≥ N ngày
  clear_min_stock: 20, // …và còn ≥ N cái (cả khi trái mùa)
  core_min_units: 60, // Chủ lực: bán ≥ N cái / 30 ngày trên Shopee
  core_max_cost_pct: 36, // …giá vốn ≤ % giá bán
  core_min_stock_days: 14, // …tồn đủ bán ≥ N ngày
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
  good_hours: number[]; // rỗng = tự tính
  params: RuleParams;
}

/** "0, 8-12, 20-22" → [0,8,9,10,11,12,20,21,22] */
export function parseHours(text: string): number[] {
  const out = new Set<number>();
  for (const part of text.split(/[,;\s]+/).filter(Boolean)) {
    const m = /^(\d{1,2})h?(?:-(\d{1,2})h?)?$/i.exec(part);
    if (!m) continue;
    const a = Number(m[1]);
    const b = m[2] == null ? a : Number(m[2]);
    for (let h = Math.min(a, b); h <= Math.max(a, b); h++) if (h >= 0 && h <= 23) out.add(h);
  }
  return [...out].sort((x, y) => x - y);
}

/** [0,8,9,10,11,12,20,21,22] → "0h, 8h–12h, 20h–22h" */
export function formatHours(hours: number[]): string {
  const s = [...hours].sort((a, b) => a - b);
  const parts: string[] = [];
  for (let i = 0; i < s.length; i++) {
    let j = i;
    while (j + 1 < s.length && s[j + 1] === s[j] + 1) j++;
    parts.push(i === j ? `${s[i]}h` : `${s[i]}h–${s[j]}h`);
    i = j;
  }
  return parts.join(", ");
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
    good_hours: (r.good_hours ?? []).map(Number),
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
