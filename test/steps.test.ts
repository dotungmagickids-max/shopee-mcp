/**
 * Thử bậc lãi (cải tiến liên tục) và mục tiêu tháng: các hàm tính thuần, không gọi mạng.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_RULE_PARAMS } from "../src/lib/autopilot/settings";
import { profitTarget, scaleTargetFor } from "../src/lib/autopilot/classes";
import { average, judge, nextLevel, type Avg } from "../src/lib/autopilot/steps";
import { behindRevenue, daysBetween, daysInMonth, deadlineDate, paceLines } from "../src/lib/autopilot/goals";

const p = { ...DEFAULT_RULE_PARAMS };
const econ: any = { margin: 0.26, cancel_rate: 0.05, return_rate: 0.08, payout: 0.8, ad_fee_pct: 8, class: "chu_luc" };
const avg = (profit: number, revenue: number, control: number): Avg => ({ profit, revenue, expense: 100_000, control, days: ["2026-11-03"] });

describe("thử bậc lãi", () => {
  it("bậc kế tiếp đổi ROAS khoảng 12% và nằm trong biên", () => {
    const cur = profitTarget(econ, 10, "").target!;
    const down = nextLevel(econ, 10, "down", p)!;
    const up = nextLevel(econ, 10, "up", p)!;
    assert.ok(down < 10 && up > 10);
    const tDown = profitTarget(econ, down, "").target!;
    const tUp = profitTarget(econ, up, "").target!;
    assert.ok(Math.abs(tDown / cur - 0.88) < 0.06, `ROAS xuống ${cur} → ${tDown}`);
    assert.ok(Math.abs(tUp / cur - 1.12) < 0.06, `ROAS lên ${cur} → ${tUp}`);
    assert.equal(nextLevel(econ, p.steps_min_pct, "down", p), null);
  });

  it("lãi/ngày tăng rõ thì giữ, giảm rõ thì quay lại và đổi hướng", () => {
    const base = avg(500_000, 5_000_000, 50_000_000);
    const good = judge("down", base, avg(600_000, 7_000_000, 50_000_000), 5, false);
    assert.equal(good.status, "kept");
    assert.equal(good.next_dir, "down");
    const bad = judge("down", base, avg(400_000, 7_000_000, 50_000_000), 5, false);
    assert.equal(bad.status, "reverted");
    assert.equal(bad.next_dir, "up");
  });

  it("hiệu chỉnh theo sức mua chung của shop", () => {
    // Cả shop đông hơn 30%: lãi 600k chỉ tương đương 462k ngày thường → không phải nhờ bậc mới.
    const v = judge("down", avg(500_000, 5_000_000, 50_000_000), avg(600_000, 6_500_000, 65_000_000), 5, false);
    assert.equal(v.status, "reverted");
    assert.ok(Math.abs(v.ctrl - 1.3) < 1e-9);
  });

  it("ngang nhau: thiếu doanh số thì giữ bậc bán nhiều, đủ thì giữ bậc lãi % cao", () => {
    const base = avg(500_000, 5_000_000, 50_000_000);
    const test = avg(510_000, 6_000_000, 50_000_000);
    assert.equal(judge("down", base, test, 5, true).status, "kept");
    assert.equal(judge("down", base, test, 5, false).status, "reverted");
    assert.equal(judge("up", base, avg(505_000, 4_500_000, 50_000_000), 5, false).status, "kept");
    assert.equal(judge("up", base, avg(505_000, 4_500_000, 50_000_000), 5, true).status, "reverted");
  });

  it("trung bình theo ngày", () => {
    const a = average(["a", "b"], (d) => (d === "a" ? { profit: 100, revenue: 1000, expense: 10, control: 5 } : { profit: 300, revenue: 3000, expense: 30, control: 15 }));
    assert.deepEqual({ ...a, days: undefined }, { profit: 200, revenue: 2000, expense: 20, control: 10, days: undefined });
  });

  it("ngưỡng tăng ngân sách theo bậc lãi riêng khi có", () => {
    const own = scaleTargetFor({ ...econ, level_pct: 6 }, p)!;
    assert.equal(own.target, profitTarget(econ, 6, "").target);
    assert.match(own.label, /bậc lãi 6%/);
    const cls = scaleTargetFor({ ...econ, class: "xa_kho", level_pct: 6 }, p)!;
    assert.doesNotMatch(cls.label, /bậc lãi/);
  });
});

describe("mục tiêu tháng", () => {
  it("ngày và hạn", () => {
    assert.equal(daysInMonth("2026-11-13"), 30);
    assert.equal(daysInMonth("2027-02-01"), 28);
    assert.equal(deadlineDate(20270117), "2027-01-17");
    assert.equal(deadlineDate(0), null);
    assert.equal(daysBetween("2026-11-13", "2027-01-17"), 65);
  });

  it("tiến độ doanh số và lãi", () => {
    const pace = { goal: 1e9, revenue: 400e6, profit: 40e6, profitPct: 10, goalPct: 12, daysDone: 12, daysLeft: 18, needPerDay: 600e6 / 18, pace: 400e6 / 400e6 };
    assert.equal(behindRevenue(pace), false);
    assert.equal(behindRevenue({ ...pace, pace: 0.8 }), true);
    const g = paceLines(pace);
    assert.ok(g.lines.some((l) => l.includes("Cần")));
    assert.equal(g.todo.length, 1);
    for (const l of g.lines) assert.doesNotMatch(l.replace(/<\/?[bi]>/g, ""), /</);
  });
});
