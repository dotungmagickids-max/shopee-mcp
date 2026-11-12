import { db } from "../supabase";
import { addDays, vnDate } from "./time";

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
  clear_profit_pct: -5, // Xả kho: lãi mong muốn (âm = chấp nhận lỗ tối đa N% để đẩy hàng)
  // Sàn lãi toàn hệ thống (hôm nay + hôm qua, đơn từ quảng cáo): gần sàn thì dừng tăng nhóm lãi mỏng trước
  system_profit_floor_pct: 12,
  clear_max_spend_share_pct: 20, // Xả kho: tối đa % tổng chi quảng cáo hôm nay
  new_max_spend_share_pct: 10, // Mới: tối đa % tổng chi quảng cáo hôm nay
  // Ngưỡng tự phân nhóm
  new_days: 30, // Mới: sản phẩm tạo trên Pancake chưa tới N ngày
  clear_stock_days: 120, // Xả kho: tồn đủ bán ≥ N ngày
  clear_min_stock: 20, // …và còn ≥ N cái (cả khi trái mùa)
  core_min_units: 60, // Chủ lực: bán ≥ N cái / 30 ngày trên Shopee
  core_max_cost_pct: 36, // …giá vốn ≤ % giá bán
  core_min_stock_days: 14, // …tồn đủ bán ≥ N ngày
  // Ngày cao điểm (ngày đôi, ngày khai báo, và N ngày trước đó): chạy theo lãi, ít cản
  peak_scale_spend_ratio: 0.6, // tăng khi đã tiêu ≥ tỉ lệ ngân sách
  peak_scale_step_pct: 50, // mỗi lần tăng (%)
  peak_max_increase_pct: 100, // trần mỗi lần tăng (%) — thay cho trần 30% ngày thường
  peak_cooldown_minutes: 30,
  peak_max_edits_per_day: 12,
  // Ngôi sao (Chủ lực): bán nhanh, bán nhiều VÀ lãi tốt → tăng nhanh nhưng chỉ khi còn lãi ≥ N% (anh chốt 12/11: không hạ lãi).
  // Các nhóm khác tăng khi đạt đúng mục tiêu nhóm. Siết vẫn theo mục tiêu nhóm.
  scale_core_profit_pct: 10,
  // Phanh: ROAS hôm nay tụt dưới N% ROAS 7 ngày thì thôi tăng (tăng thêm đang mua lượt kém hiệu quả). 0 = tắt.
  scale_decay_pct: 80,
  scale_decay_min_spend: 100_000, // chỉ xét phanh khi hôm nay đã tiêu ≥ khoản này
  scale_core_spend_ratio: 0.6,
  scale_core_step_pct: 50,
  // Ngân sách khởi điểm 0h riêng từng chiến dịch = % chi trung bình 7 ngày thường (thấp nhất = start_budget).
  // 0 = tắt: mọi chiến dịch về start_budget (anh chốt 12/11: về 100k, tăng nhanh trong ngày).
  start_share_pct: 0,
  // Tăng theo tốc độ tiêu: sắp hết tiền trong N phút thì tăng ngay, đủ tiêu thêm M giờ
  burn_trigger_minutes: 30,
  burn_cover_hours: 2,
  fast_max_increase_pct: 100, // trần mỗi lần tăng khi đang tiêu nhanh (%)
  fast_cooldown_minutes: 10,
  fast_max_edits_per_day: 24,
  // Đầu ngày (đã tiêu < N% mức chi ngày bình thường): xét ROAS 3 ngày gần nhất thay vì chỉ ROAS hôm nay
  early_spend_pct: 50,
  // Lên quảng cáo mã chưa chạy (đề xuất hằng tuần, luôn chờ duyệt)
  launch_max_per_week: 5,
  launch_min_stock: 30, // tồn tối thiểu (cái)
  launch_min_stock_days: 21, // tồn đủ bán tối thiểu (ngày)
  launch_max_breakeven: 8, // bỏ mã có ROAS hòa vốn cao hơn (lãi quá mỏng để chạy quảng cáo)
  launch_cooldown_days: 21, // mã đã đề xuất (kể cả anh bỏ qua) thì N ngày sau mới đề xuất lại
  launch_live: 0, // 1 = duyệt là tạo chiến dịch thật trên Shopee; 0 = chỉ ghi nhận (dry-run)
  // Đánh giá hàng Mới sau 14 ngày chạy
  new_promote_orders: 20, // đủ N đơn và ROAS ≥ mức lãi 10% → đề xuất lên Thường/Chủ lực
  new_stop_min_spend: 300_000, // đã chi ≥ N mà < 3 đơn hoặc ROAS < 80% hòa vốn → báo nên dừng
  // 1 = tự chạy việc TĂNG ngân sách (tăng do luật + nới lại sau siết) không chờ duyệt; siết/dừng vẫn chờ duyệt
  auto_scale_up: 1,
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
  mini_sale_days: number[]; // ngày sale nhỏ hằng tháng
  pre_sale_days: number; // số ngày trước ngày sale lớn cũng tính là cao điểm
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
    mini_sale_days: (r.mini_sale_days ?? [1, 15, 20, 25]).map(Number),
    pre_sale_days: Number(r.pre_sale_days ?? 2),
    good_hours: (r.good_hours ?? []).map(Number),
    params: { ...DEFAULT_RULE_PARAMS, ...(r.rule_params ?? {}) },
  };
}

/** Ngày sale lớn: ngày trùng tháng (1/1 … 12/12) hoặc ngày khai báo trong sale_dates (vd 27/11 Black Friday). */
export function isSaleDay(s: ShopSettings, date = vnDate()): boolean {
  const [, m, d] = date.split("-").map(Number);
  return m === d || s.sale_dates.includes(date);
}

/**
 * Loại ngày theo lịch sale Shopee (số thật Magickids 9–11/2026):
 *   "lon"   ngày đôi / ngày khai báo — 11/11 chi 37tr, 1.229 đơn
 *   "truoc" N ngày trước ngày sale lớn — 10/11 chi 16tr, 9/11 7,5tr
 *   "nho"   ngày 1, 15, 20, 25 hằng tháng — chi và đơn gấp ~2 ngày thường
 *   "thuong"
 */
export type SaleTier = "lon" | "truoc" | "nho" | "thuong";

export function saleTier(s: ShopSettings, date = vnDate()): SaleTier {
  if (isSaleDay(s, date)) return "lon";
  for (let k = 1; k <= s.pre_sale_days; k++) if (isSaleDay(s, addDays(date, k))) return "truoc";
  if (s.mini_sale_days.includes(Number(date.slice(8, 10)))) return "nho";
  return "thuong";
}

export const SALE_TIER_VI: Record<SaleTier, string> = {
  lon: "ngày sale lớn",
  truoc: "ngày trước sale lớn",
  nho: "ngày sale nhỏ",
  thuong: "ngày thường",
};

/** Ngày cao điểm: sale lớn và các ngày ngay trước đó — luật chạy theo lãi, ít cản. */
export function isPeakDay(s: ShopSettings, date = vnDate()): boolean {
  const t = saleTier(s, date);
  return t === "lon" || t === "truoc";
}

/** Cầu chì tổng ngân sách/ngày đang áp dụng (null = chưa đặt). Chỉ để chặn lỗi, không phải mục tiêu chi. */
export function dailyCap(s: ShopSettings, date = vnDate()): number | null {
  return isPeakDay(s, date) ? s.daily_cap_sale ?? s.daily_cap_normal : s.daily_cap_normal;
}

/** Mức tăng tối đa mỗi lần và số lần chỉnh/ngày theo loại ngày. */
export function increaseLimit(s: ShopSettings, date = vnDate(), fast = false): number {
  const base = isPeakDay(s, date) ? Math.max(s.max_increase_pct, s.params.peak_max_increase_pct) : s.max_increase_pct;
  return fast ? Math.max(base, s.params.fast_max_increase_pct) : base;
}

/** Việc tăng ngân sách được tự chạy không chờ duyệt (tăng theo luật, nới lại sau siết). */
export function autoRunnable(s: ShopSettings, source: string, action: string, before: any, after: any): boolean {
  if (!s.params.auto_scale_up || action !== "change_budget") return false;
  if (source !== "rule:scale_up" && source !== "rule:restore") return false;
  const b = Number(before?.budget ?? 0);
  return b > 0 && Number(after?.budget ?? 0) > b;
}

export function editsLimit(s: ShopSettings, date = vnDate()): number {
  return isPeakDay(s, date) ? Math.max(s.max_edits_per_day, s.params.peak_max_edits_per_day) : s.max_edits_per_day;
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
