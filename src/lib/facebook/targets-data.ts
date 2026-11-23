/**
 * FB Magic Tool — Mục tiêu quảng cáo: đọc mục tiêu (fb_targets), số từng ngày trong tháng (fb_ad_daily) và ngân sách
 * ngày của quảng cáo đang bật (Meta). Chỉ đọc; không có lệnh ghi lên Meta.
 */
import { db } from "../supabase";
import { activeAdsets, listAccounts, scrub } from "./meta";
import { buildPlan, DEFAULT_TARGETS, realOf, sumActiveBudgets, type DayRow, type Plan, type Targets } from "./targets";

/** Mục tiêu đã lưu. Chưa có bảng (chưa áp migration) thì dùng mặc định và báo `missing`. */
export async function loadTargets(): Promise<{ targets: Targets; missing: boolean; updated_at: string | null }> {
  const { data, error } = await db().from("fb_targets").select("month_budget, day_budget, ratio, ad_budget, updated_at").eq("id", 1).maybeSingle();
  if (error) return { targets: DEFAULT_TARGETS, missing: true, updated_at: null };
  if (!data) return { targets: DEFAULT_TARGETS, missing: false, updated_at: null };
  return {
    targets: {
      month_budget: data.month_budget == null ? null : Number(data.month_budget),
      day_budget: data.day_budget == null ? null : Number(data.day_budget),
      ratio: Number(data.ratio) > 0 ? Number(data.ratio) : DEFAULT_TARGETS.ratio,
      ad_budget: Number(data.ad_budget) > 0 ? Number(data.ad_budget) : DEFAULT_TARGETS.ad_budget,
    },
    missing: false,
    updated_at: data.updated_at ?? null,
  };
}

/** Cộng fb_ad_daily theo ngày, từ ngày 1 của tháng tới hôm nay. */
export async function loadMonthDays(today: string): Promise<DayRow[]> {
  const from = `${today.slice(0, 7)}-01`;
  const byDay = new Map<string, DayRow>();
  for (let page = 0; page < 40; page++) {
    const { data, error } = await db()
      .from("fb_ad_daily")
      .select("ngay, ad_id, spend, revenue, orders")
      .gte("ngay", from)
      .lte("ngay", today)
      .order("ngay")
      .order("ad_id")
      .range(page * 1000, page * 1000 + 999);
    if (error) throw new Error(`fb_ad_daily: ${error.message}`);
    for (const r of data ?? []) {
      const d = byDay.get(r.ngay) ?? { ngay: r.ngay, spendReal: 0, revenue: 0, orders: 0 };
      d.spendReal += Number(r.spend ?? 0);
      d.revenue += Number(r.revenue ?? 0);
      d.orders += Number(r.orders ?? 0);
      byDay.set(r.ngay, d);
    }
    if (!data || data.length < 1000) break;
  }
  // Cộng số Meta trước rồi mới nhân phí một lần cho mỗi ngày.
  return [...byDay.values()].map((d) => ({ ...d, spendReal: realOf(d.spendReal), revenue: Math.round(d.revenue) })).sort((a, b) => a.ngay.localeCompare(b.ngay));
}

export type ActiveBudget = { metaDaily: number; byAccount: { id: string; name: string; metaDaily: number; adsets: number; skipped: number }[]; errors: string[] };

/** Tổng ngân sách ngày của nhóm/chiến dịch đang bật ở mọi tài khoản theo dõi (đã bỏ BOSS TUYỀN 3/4/5/6). */
export async function loadActiveBudget(): Promise<ActiveBudget> {
  const accounts = await listAccounts();
  const errors: string[] = [];
  const byAccount = await Promise.all(
    accounts.map(async (a) => {
      try {
        const s = sumActiveBudgets(await activeAdsets(a.id));
        return { id: a.id, name: a.name, ...s };
      } catch (e) {
        errors.push(`${a.name}: ${scrub(e instanceof Error ? e.message : String(e)).slice(0, 120)}`);
        return { id: a.id, name: a.name, metaDaily: 0, adsets: 0, skipped: 0 };
      }
    })
  );
  return { metaDaily: byAccount.reduce((s, a) => s + a.metaDaily, 0), byAccount: byAccount.filter((a) => a.adsets > 0), errors };
}

export type TargetsView = {
  targets: Targets;
  missingTable: boolean;
  updated_at: string | null;
  days: DayRow[];
  active: ActiveBudget | null;
  plan: Plan;
  errors: string[];
};

export async function loadTargetsView(today: string): Promise<TargetsView> {
  const errors: string[] = [];
  const [t, days, active] = await Promise.all([
    loadTargets(),
    loadMonthDays(today).catch((e) => {
      errors.push(e instanceof Error ? e.message : String(e));
      return [] as DayRow[];
    }),
    loadActiveBudget().catch((e) => {
      errors.push(`Meta: ${scrub(e instanceof Error ? e.message : String(e)).slice(0, 160)}`);
      return null;
    }),
  ]);
  if (active?.errors.length) errors.push(...active.errors);
  // Có tài khoản đọc lỗi thì tổng dự chi vẫn hiện, kèm cảnh báo là có thể thiếu.
  const plan = buildPlan(today, days, active ? active.metaDaily : null, t.targets);
  return { targets: t.targets, missingTable: t.missing, updated_at: t.updated_at, days, active, plan, errors };
}
