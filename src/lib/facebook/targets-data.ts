/**
 * FB Magic Tool — Mục tiêu quảng cáo: đọc mục tiêu (fb_targets), số từng ngày trong tháng (fb_ad_daily) và ngân sách
 * ngày của quảng cáo đang bật (Meta). Chỉ đọc; không có lệnh ghi lên Meta.
 */
import { db } from "../supabase";
import { buildPlan as buildLaunchPlan, planBudget, type LaunchConfig, type LaunchItem } from "./launch";
import { PAGES } from "./magic-data";
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

/**
 * Đơn chốt và doanh thu KÊNH Facebook theo ngày, lấy từ đơn Pancake đã đồng bộ về (hàm mk_sales, nhóm day_channel).
 * Đơn Pancake đồng bộ mỗi sáng, nên hôm nay thường chưa có.
 */
export async function loadPancakeFbSales(today: string): Promise<Map<string, { orders: number; revenue: number }>> {
  const { data, error } = await db().rpc("mk_sales", { p_agent: "fb_muc_tieu", p_from: `${today.slice(0, 7)}-01`, p_to: today, p_group: "day_channel" });
  if (error) throw new Error(`Doanh thu Pancake: ${error.message}`);
  const out = new Map<string, { orders: number; revenue: number }>();
  for (const r of ((data as any)?.dong ?? []) as { ky: string; kenh: string; don_chot: number | null; doanh_so_giu: number | null }[]) {
    if (r.kenh !== "facebook" || r.doanh_so_giu == null) continue;
    out.set(String(r.ky).slice(0, 10), { orders: Number(r.don_chot ?? 0), revenue: Math.round(Number(r.doanh_so_giu)) });
  }
  return out;
}

/** Ghép chi quảng cáo từng ngày với doanh thu kênh Facebook trên Pancake. Ngày chưa có doanh thu Pancake thì đánh dấu, không coi là 0. */
export function withPancake(days: DayRow[], sales: Map<string, { orders: number; revenue: number }>): DayRow[] {
  const byDay = new Map(days.map((d) => [d.ngay, d]));
  for (const ngay of sales.keys()) if (!byDay.has(ngay)) byDay.set(ngay, { ngay, spendReal: 0, revenue: 0, orders: 0, adRevenue: 0 });
  return [...byDay.values()]
    .map((d) => {
      const s = sales.get(d.ngay);
      return { ...d, adRevenue: d.adRevenue ?? d.revenue, revenue: s?.revenue ?? 0, orders: s?.orders ?? 0, hasRevenue: !!s };
    })
    .sort((a, b) => a.ngay.localeCompare(b.ngay));
}

export type DraftBudget = { id: number; name: string; page: string; items: number; metaDaily: number; start_time: string | null; created_at: string };

/** Các nháp kế hoạch lên camp (mọi page) kèm ngân sách ngày nếu lên đúng như nháp. Chưa có bảng thì coi như không có nháp. */
export async function loadDraftBudgets(): Promise<DraftBudget[]> {
  const { data, error } = await db().from("fb_launch_drafts").select("id, created_at, name, page_id, config, items").order("created_at", { ascending: false }).limit(200);
  if (error) return [];
  return (data ?? []).map((d) => {
    const cfg = (d.config ?? {}) as Partial<LaunchConfig>;
    const items = (Array.isArray(d.items) ? d.items : []) as LaunchItem[];
    const budget = Number(cfg.budget) > 0 ? Number(cfg.budget) : 0;
    const accounts = Array.isArray(cfg.accounts) && cfg.accounts.length ? cfg.accounts.map(String) : ["-"];
    const full = { page_id: String(d.page_id), accounts, budget, structure: cfg.structure === "cbo" ? "cbo" : "abo", age_min: 25, age_max: 45, gender: "all", placement: "auto", shape: cfg.shape } as LaunchConfig;
    return {
      id: Number(d.id),
      name: String(d.name ?? ""),
      page: PAGES[String(d.page_id)] ?? String(d.page_id),
      items: items.length,
      metaDaily: budget && items.length ? planBudget(buildLaunchPlan(full, items)) : 0,
      start_time: typeof cfg.start_time === "string" && cfg.start_time ? cfg.start_time : null,
      created_at: String(d.created_at ?? ""),
    };
  });
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
  drafts: DraftBudget[];
  /** true = doanh thu lấy được từ Pancake; false = Pancake lỗi, đang tạm dùng doanh thu của đơn gắn mã quảng cáo. */
  pancakeOk: boolean;
  plan: Plan;
  errors: string[];
};

export async function loadTargetsView(today: string): Promise<TargetsView> {
  const errors: string[] = [];
  const [t, adDays, active, sales, drafts] = await Promise.all([
    loadTargets(),
    loadMonthDays(today).catch((e) => {
      errors.push(e instanceof Error ? e.message : String(e));
      return [] as DayRow[];
    }),
    loadActiveBudget().catch((e) => {
      errors.push(`Meta: ${scrub(e instanceof Error ? e.message : String(e)).slice(0, 160)}`);
      return null;
    }),
    loadPancakeFbSales(today).catch((e) => {
      errors.push(`${e instanceof Error ? e.message : String(e)}`.slice(0, 200));
      return null;
    }),
    loadDraftBudgets().catch(() => [] as DraftBudget[]),
  ]);
  const days = sales ? withPancake(adDays, sales) : adDays.map((d) => ({ ...d, adRevenue: d.revenue }));
  if (active?.errors.length) errors.push(...active.errors);
  // Có tài khoản đọc lỗi thì tổng dự chi vẫn hiện, kèm cảnh báo là có thể thiếu.
  const draftMeta = drafts.reduce((s, d) => s + d.metaDaily, 0);
  const plan = buildPlan(today, days, active ? active.metaDaily : null, t.targets, draftMeta);
  return { targets: t.targets, missingTable: t.missing, updated_at: t.updated_at, days, active, drafts, pancakeOk: !!sales, plan, errors };
}
