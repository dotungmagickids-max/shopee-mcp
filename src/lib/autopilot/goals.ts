import { db } from "../supabase";
import { periodReport } from "./report";
import type { ShopSettings } from "./settings";
import { esc, vnd } from "./telegram";
import { addDays } from "./time";

/**
 * Mục tiêu của shop (anh chốt 13/11/2026): doanh số tháng, lãi % cả tháng, hạn bán hết hàng xả.
 * Dùng cho báo cáo sáng và để thử bậc biết đang thiếu doanh số hay đang dư.
 */

const n = (v: unknown) => Number(v ?? 0) || 0;

export function daysInMonth(date: string): number {
  const [y, m] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** 20270117 → "2027-01-17" (0 / sai → null). */
export function deadlineDate(v: number): string | null {
  const s = String(Math.round(v || 0));
  if (!/^20\d{6}$/.test(s)) return null;
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
}

export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400_000);
}

export interface MonthPace {
  goal: number;
  revenue: number; // doanh số từ đầu tháng tới hết hôm qua
  profit: number | null;
  profitPct: number | null;
  goalPct: number;
  daysDone: number;
  daysLeft: number; // gồm hôm nay
  needPerDay: number; // doanh số cần mỗi ngày còn lại để đạt mục tiêu
  pace: number; // tỉ lệ đã đạt so với tiến độ đều (1 = đúng tiến độ)
}

/** Tiến độ tháng tính tới hết hôm qua. Chưa đặt mục tiêu doanh số → null. */
export async function monthPace(shopId: number, s: ShopSettings, today: string): Promise<MonthPace | null> {
  const goal = n(s.params.goal_month_revenue);
  if (!(goal > 0)) return null;
  const first = `${today.slice(0, 8)}01`;
  const dim = daysInMonth(today);
  const daysDone = daysBetween(first, today);
  const r = daysDone > 0 ? await periodReport(shopId, first, today) : { revenue: 0, profit: null as number | null };
  const daysLeft = dim - daysDone;
  return {
    goal,
    revenue: r.revenue,
    profit: r.profit,
    profitPct: r.profit != null && r.revenue > 0 ? (100 * r.profit) / r.revenue : null,
    goalPct: n(s.params.goal_profit_pct),
    daysDone,
    daysLeft,
    needPerDay: daysLeft > 0 ? Math.max(0, goal - r.revenue) / daysLeft : 0,
    pace: daysDone > 0 ? r.revenue / ((goal * daysDone) / dim) : 1,
  };
}

/** Thiếu doanh số so với tiến độ (dưới 95% tiến độ đều). */
export function behindRevenue(p: MonthPace | null): boolean {
  return !!p && p.daysLeft > 0 && p.pace < 0.95;
}

export function paceLines(p: MonthPace): { lines: string[]; todo: string[] } {
  const lines: string[] = [];
  const todo: string[] = [];
  const pct = Math.round((100 * p.revenue) / p.goal);
  lines.push(
    `• Doanh số tháng: <b>${vnd(p.revenue)}</b> / ${vnd(p.goal)} (${pct}%, sau ${p.daysDone} ngày) · ${
      p.pace >= 1 ? `vượt tiến độ ${Math.round(100 * p.pace - 100)}%` : `<b>chậm ${Math.round(100 - 100 * p.pace)}%</b> so với tiến độ`
    }`
  );
  if (p.daysLeft > 0 && p.revenue < p.goal) lines.push(`• Cần <b>${vnd(Math.round(p.needPerDay))}</b>/ngày trong ${p.daysLeft} ngày còn lại`);
  if (p.profitPct != null) {
    const ok = p.profitPct >= p.goalPct;
    lines.push(`• Lãi tháng (ước): <b>${vnd(Math.round(p.profit!))}</b> = ${ok ? "" : "<b>"}${p.profitPct.toFixed(1)}%${ok ? "" : "</b>"} (mục tiêu ${p.goalPct}%)`);
    if (!ok) todo.push(`Lãi tháng ${p.profitPct.toFixed(1)}% dưới mục tiêu ${p.goalPct}%: tool đang giữ sàn lãi, xem mã lỗ trên dashboard`);
  }
  return { lines, todo };
}

export interface ClearItem {
  name: string;
  stock: number;
  daysOfStock: number | null;
  needPerDay: number;
  nowPerDay: number;
}

/** Hàng xả: còn bao nhiêu, theo tốc độ hiện tại có bán hết trước hạn không. */
export async function clearancePace(shopId: number, s: ShopSettings, today: string) {
  const deadline = deadlineDate(n(s.params.clear_deadline));
  if (!deadline) return null;
  const daysLeft = daysBetween(today, deadline);
  const { data } = await db()
    .from("product_lifecycle")
    .select("name, stock, days_of_stock, units30")
    .eq("shop_id", shopId)
    .eq("cls", "xa_kho")
    .gt("stock", 0);
  const items: ClearItem[] = (data ?? []).map((x: any) => {
    const stock = n(x.stock);
    const dos = x.days_of_stock == null ? null : n(x.days_of_stock);
    return {
      name: String(x.name ?? ""),
      stock,
      daysOfStock: dos,
      needPerDay: daysLeft > 0 ? stock / daysLeft : stock,
      nowPerDay: dos && dos > 0 ? stock / dos : n(x.units30) / 30,
    };
  });
  const behind = items.filter((i) => i.nowPerDay < i.needPerDay * 0.95).sort((a, b) => b.stock - a.stock);
  return {
    deadline,
    daysLeft,
    items: items.length,
    stock: items.reduce((t, i) => t + i.stock, 0),
    needPerDay: items.reduce((t, i) => t + i.needPerDay, 0),
    nowPerDay: items.reduce((t, i) => t + i.nowPerDay, 0),
    behind,
  };
}

export function clearanceLines(c: NonNullable<Awaited<ReturnType<typeof clearancePace>>>): { lines: string[]; todo: string[] } {
  const d = c.deadline.split("-").reverse().join("/");
  const lines = [
    `• Hàng xả: <b>${c.stock}</b> cái / ${c.items} mã, hạn bán hết ${d} (còn ${c.daysLeft} ngày) · cần ~${Math.ceil(c.needPerDay)} cái/ngày, đang bán ~${Math.round(c.nowPerDay)}`,
  ];
  const todo: string[] = [];
  if (c.behind.length) {
    lines.push(
      `• Chậm so với hạn: <b>${c.behind.length}</b> mã — ${c.behind
        .slice(0, 3)
        .map((i) => `${esc(i.name.slice(0, 26))} (tồn ${i.stock}, cần ${i.needPerDay.toFixed(1)}/ngày, đang ${i.nowPerDay.toFixed(1)})`)
        .join("; ")}`
    );
    todo.push(`${c.behind.length} mã xả kho bán chậm so với hạn ${d}: cân nhắc giảm giá / flash sale (quảng cáo đã chạy ở mức lỗ tối đa cho phép)`);
  }
  return { lines, todo };
}

/** Ngày đầu tháng của tháng chứa `date`, và ngày đầu tháng sau. */
export function monthRange(date: string): [string, string] {
  const first = `${date.slice(0, 8)}01`;
  return [first, addDays(first, daysInMonth(date))];
}
