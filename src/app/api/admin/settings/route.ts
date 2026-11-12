import { adminFromRequest } from "@/lib/autopilot/admin-auth";
import { shopName, shops } from "@/lib/autopilot/config";
import { esc, sendTelegram } from "@/lib/autopilot/telegram";
import { DEFAULT_RULE_PARAMS, parseHours, suggestDays } from "@/lib/autopilot/settings";
import { db } from "@/lib/supabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Form POST từ dashboard:
 *   action=emergency_stop | emergency_release  (toàn bộ shop)
 *   action=save, shop_id, mode, daily_cap_normal, daily_cap_sale, campaign_cap, max_increase_pct,
 *          max_edits_per_day, start_budget
 */
export async function POST(request: Request) {
  if (!adminFromRequest(request)) return new Response("unauthorized", { status: 401 });
  const url = new URL(request.url);
  const origin = request.headers.get("origin");
  if (origin && origin !== url.origin) return new Response("bad origin", { status: 403 });

  const form = await request.formData();
  const action = String(form.get("action") ?? "");
  const now = new Date().toISOString();

  if (action === "emergency_stop" || action === "emergency_release") {
    const stop = action === "emergency_stop";
    const ids = shops().map((s) => s.shopId);
    await db().from("autopilot_settings").update({ emergency_stop: stop, halt_reason: null, updated_at: now }).in("shop_id", ids);
    await log(stop ? "emergency_stop" : "emergency_release", null, null, null);
    await sendTelegram(stop ? "🛑 <b>DỪNG KHẨN CẤP</b> đã bật trên dashboard: tắt toàn bộ tự động." : "✅ Đã gỡ dừng khẩn cấp trên dashboard.");
  } else if (action === "save") {
    const shopId = Number(form.get("shop_id"));
    if (!shops().some((s) => s.shopId === shopId)) return new Response("bad shop", { status: 400 });
    const numOrNull = (k: string) => {
      const v = String(form.get(k) ?? "").replace(/[.,\s]/g, "");
      return v === "" ? null : Number(v);
    };
    const decimal = (k: string) => {
      const v = String(form.get(k) ?? "").trim().replace(",", ".");
      return v === "" ? null : Number(v);
    };
    const wantMode = String(form.get("mode"));
    // Chỉ bật auto khi đã chạy đề xuất ≥ 7 ngày.
    const mode =
      wantMode === "off" ? "off" : wantMode === "auto" && (await suggestDays(shopId)) >= 7 ? "auto" : "suggest";
    const { data: before } = await db().from("autopilot_settings").select("*").eq("shop_id", shopId).maybeSingle();
    const params: Record<string, number> = {};
    for (const key of Object.keys(DEFAULT_RULE_PARAMS) as (keyof typeof DEFAULT_RULE_PARAMS)[]) {
      const v = decimal(`p_${key}`);
      if (v != null && Number.isFinite(v) && v !== DEFAULT_RULE_PARAMS[key]) params[key] = v;
    }
    if (params.cut_window_hours != null) params.cut_window_hours = Math.max(3, params.cut_window_hours);
    if (params.roas_max_change_pct != null) params.roas_max_change_pct = Math.min(15, params.roas_max_change_pct);
    if (params.profit_target_pct != null) params.profit_target_pct = Math.min(60, Math.max(0, params.profit_target_pct));
    if (params.extra_cost_per_unit != null) params.extra_cost_per_unit = Math.max(0, params.extra_cost_per_unit);
    if (params.use_profit_roas != null) params.use_profit_roas = params.use_profit_roas ? 1 : 0;
    if (params.ad_fee_pct != null) params.ad_fee_pct = Math.min(50, Math.max(0, params.ad_fee_pct));
    if (params.peak_max_increase_pct != null) params.peak_max_increase_pct = Math.min(200, Math.max(0, params.peak_max_increase_pct));
    if (params.auto_scale_up != null) params.auto_scale_up = params.auto_scale_up ? 1 : 0;
    if (params.auto_reset != null) params.auto_reset = params.auto_reset ? 1 : 0;
    if (params.auto_roas != null) params.auto_roas = params.auto_roas ? 1 : 0;
    if (params.roas_live != null) params.roas_live = params.roas_live ? 1 : 0;
    if (params.launch_live != null) params.launch_live = params.launch_live ? 1 : 0;
    if (params.fast_max_increase_pct != null) params.fast_max_increase_pct = Math.min(200, Math.max(0, params.fast_max_increase_pct));
    if (params.fast_cooldown_minutes != null) params.fast_cooldown_minutes = Math.max(5, params.fast_cooldown_minutes);
    if (params.start_share_pct != null) params.start_share_pct = Math.min(100, Math.max(0, params.start_share_pct));
    if (params.peak_cooldown_minutes != null) params.peak_cooldown_minutes = Math.max(15, params.peak_cooldown_minutes);
    // Anh chốt 13/11/2026: tự đổi giá tối đa ±5%, tối đa 3 mã.
    if (params.price_test_pct != null) params.price_test_pct = Math.min(5, Math.max(1, params.price_test_pct));
    if (params.price_test_max_running != null) params.price_test_max_running = Math.min(3, Math.max(0, params.price_test_max_running));
    if (params.price_tests_enabled != null) params.price_tests_enabled = params.price_tests_enabled ? 1 : 0;
    if (params.steps_enabled != null)params.steps_enabled = params.steps_enabled ? 1 : 0;
    if (params.steps_roas_pct != null) params.steps_roas_pct = Math.min(15, Math.max(3, params.steps_roas_pct));
    if (params.steps_min_pct != null) params.steps_min_pct = Math.max(0, params.steps_min_pct);
    if (params.steps_test_days != null) params.steps_test_days = Math.max(2, params.steps_test_days);
    if (params.clear_deadline != null && !/^20\d{6}$/.test(String(params.clear_deadline))) params.clear_deadline = 0;
    if (params.return_fee_per_order != null)params.return_fee_per_order = Math.max(0, params.return_fee_per_order);
    const saleDates = String(form.get("sale_dates") ?? "")
      .split(/[\s,;]+/)
      .map((d) => d.trim())
      .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d));
    const after = {
      mode,
      daily_cap_normal: numOrNull("daily_cap_normal"),
      daily_cap_sale: numOrNull("daily_cap_sale"),
      campaign_cap: numOrNull("campaign_cap"),
      max_increase_pct: Math.min(30, numOrNull("max_increase_pct") ?? 30),
      max_edits_per_day: numOrNull("max_edits_per_day") ?? 6,
      start_budget: numOrNull("start_budget") ?? 100000,
      reset_unlimited: form.get("reset_unlimited") === "on",
      sale_dates: saleDates,
      mini_sale_days: [
        ...new Set(
          String(form.get("mini_sale_days") ?? "")
            .split(/[\s,;]+/)
            .map(Number)
            .filter((d) => Number.isInteger(d) && d >= 1 && d <= 31),
        ),
      ].sort((a, b) => a - b),
      pre_sale_days: Math.min(7, Math.max(0, numOrNull("pre_sale_days") ?? 2)),
      good_hours: parseHours(String(form.get("good_hours") ?? "")),
      rule_params: params,
      updated_at: now,
    };
    await db().from("autopilot_settings").update(after).eq("shop_id", shopId);
    await log("settings", shopId, before, after);
    await sendTelegram(`⚙️ Cài đặt autopilot của ${esc(shopName(shopId))} vừa được sửa trên dashboard.`);
  } else {
    return new Response("bad action", { status: 400 });
  }
  return Response.redirect(`${url.origin}/admin/settings?saved=1`, 303);
}

async function log(action: string, shopId: number | null, before: unknown, after: unknown) {
  await db()
    .from("autopilot_actions")
    .insert({
      shop_id: shopId ?? 0,
      action,
      before,
      after,
      reason: "Sửa trên dashboard",
      source: "admin",
      status: "executed",
      executed_at: new Date().toISOString(),
    });
}
