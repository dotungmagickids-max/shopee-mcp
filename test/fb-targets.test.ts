/** FB Magic Tool, màn Mục tiêu: dự chi hôm nay, còn thiếu bao nhiêu quảng cáo, so mục tiêu tháng và tỉ lệ. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { withPancake } from "../src/lib/facebook/targets-data";
import { draftCountsOn, isRunning, missingSpendDays, overlaps, targetsForDay } from "../src/lib/facebook/targets";
import { buildPlan, daysInMonth, DEFAULT_TARGETS, parseMoney, parseRatio, sumActiveBudgets, type DayRow } from "../src/lib/facebook/targets";

const day = (ngay: string, spendReal: number, revenue: number, orders = 1): DayRow => ({ ngay, spendReal, revenue, orders });
// 20 ngày đầu tháng 11, mỗi ngày chi thật 1.000.000đ, doanh thu 6.000.000đ; hôm nay 21/11 đã chi 300.000đ.
const days = [
  ...Array.from({ length: 20 }, (_, i) => day(`2026-11-${String(i + 1).padStart(2, "0")}`, 1_000_000, 6_000_000, 10)),
  day("2026-11-21", 300_000, 1_000_000, 2),
  day("2026-10-31", 9_999_999, 1, 1), // tháng trước: không tính
];

describe("FB Magic Tool: mục tiêu quảng cáo", () => {
  it("tháng: đã chi, còn lại, mỗi ngày cần bao nhiêu, tỉ lệ so mục tiêu", () => {
    const p = buildPlan("2026-11-21", days, 900_000, { ...DEFAULT_TARGETS, month_budget: 40_000_000 });
    assert.equal(daysInMonth("2026-11-21"), 30);
    assert.equal(p.month.spent, 20_300_000);
    assert.equal(p.month.revenue, 121_000_000);
    assert.equal(p.month.orders, 202);
    assert.equal(p.month.left, 19_700_000);
    assert.equal(p.month.daysLeft, 10); // 21 → 30/11, tính cả hôm nay
    assert.equal(p.month.needPerDay, 2_000_000); // (40tr − 20tr đã chi tới hôm qua) / 10 ngày
    assert.equal(p.ratioOk, true);
    assert.ok(Math.abs(p.month.ratio! - 20_300_000 / 121_000_000) < 1e-9);
    assert.deepEqual(p.yesterday, { ngay: "2026-11-20", spent: 1_000_000, revenue: 6_000_000, ratio: 1 / 6 });
  });

  it("hôm nay: dự chi = ngân sách đang bật × 1,111; thiếu thì đổi ra số quảng cáo cần lên", () => {
    const p = buildPlan("2026-11-21", days, 900_000, { ...DEFAULT_TARGETS, month_budget: 40_000_000 });
    assert.equal(p.today.planned, 999_900);
    assert.equal(p.today.spentSoFar, 300_000);
    assert.equal(p.today.target, 2_000_000);
    assert.equal(p.today.targetFrom, "month");
    assert.equal(p.today.gap, 1_000_100);
    assert.equal(p.today.adsNeeded, 14); // mỗi quảng cáo 65.000 × 1,111 = 72.215đ → 1.000.100 / 72.215 = 13,85
    assert.equal(p.today.revenueNeeded, 4_999_500); // 999.900 / 20%
    assert.equal(p.month.forecast, 20_000_000 + 999_900 * 10);
  });

  it("mục tiêu ngày anh đặt riêng thắng mục tiêu chia từ tháng; dự chi vượt thì không cần lên thêm", () => {
    const p = buildPlan("2026-11-21", days, 900_000, { ...DEFAULT_TARGETS, month_budget: 40_000_000, day_budget: 800_000 });
    assert.equal(p.today.target, 800_000);
    assert.equal(p.today.targetFrom, "day");
    assert.equal(p.today.gap, -199_900);
    assert.equal(p.today.adsNeeded, 0);
  });

  it("thiếu dữ liệu thì không bịa số", () => {
    const none = buildPlan("2026-11-21", days, null, DEFAULT_TARGETS);
    assert.equal(none.today.planned, null);
    assert.equal(none.today.target, null);
    assert.equal(none.today.adsNeeded, null);
    assert.equal(none.month.target, null);
    assert.equal(none.month.needPerDay, null);
    const empty = buildPlan("2026-11-21", [], 0, { ...DEFAULT_TARGETS, month_budget: 30_000_000 });
    assert.equal(empty.month.ratio, null);
    assert.equal(empty.ratioOk, null);
    assert.equal(empty.yesterday, null);
    assert.equal(empty.today.planned, 0);
    assert.equal(empty.today.adsNeeded, Math.ceil(3_000_000 / 72_215));
    const overMonth = buildPlan("2026-11-21", days, 0, { ...DEFAULT_TARGETS, month_budget: 15_000_000, ratio: 0.1 });
    assert.equal(overMonth.month.left, -5_300_000);
    assert.equal(overMonth.today.target, 0); // đã vượt tháng: mục tiêu ngày về 0, không âm
    assert.equal(overMonth.ratioOk, false);
  });

  it("ngân sách đang bật: CBO tính một lần, ABO cộng từng nhóm, nhóm không có ngân sách ngày thì báo riêng", () => {
    assert.deepEqual(
      sumActiveBudgets([
        { adset_daily: 65_000, campaign_id: "c1", campaign_daily: null },
        { adset_daily: 100_000, campaign_id: "c1", campaign_daily: null },
        { adset_daily: null, campaign_id: "c2", campaign_daily: 300_000 },
        { adset_daily: null, campaign_id: "c2", campaign_daily: 300_000 },
        { adset_daily: null, campaign_id: "c3", campaign_daily: null },
      ]),
      { metaDaily: 465_000, adsets: 5, skipped: 1 }
    );
    assert.deepEqual(sumActiveBudgets([]), { metaDaily: 0, adsets: 0, skipped: 0 });
  });

  it("doanh thu lấy từ Pancake cả kênh Facebook; ngày Pancake chưa về không đưa vào tỉ lệ", () => {
    const ad = [day("2026-11-19", 1_000_000, 2_000_000), day("2026-11-20", 1_000_000, 3_000_000), day("2026-11-21", 400_000, 500_000)];
    const merged = withPancake(ad, new Map([["2026-11-19", { orders: 30, revenue: 10_000_000 }], ["2026-11-20", { orders: 20, revenue: 5_000_000 }], ["2026-11-18", { orders: 5, revenue: 1_000_000 }]]));
    assert.deepEqual(merged.map((d) => [d.ngay, d.revenue, d.adRevenue, d.hasRevenue]), [
      ["2026-11-18", 1_000_000, 0, true], // có đơn Pancake dù không chạy quảng cáo
      ["2026-11-19", 10_000_000, 2_000_000, true],
      ["2026-11-20", 5_000_000, 3_000_000, true],
      ["2026-11-21", 0, 500_000, false], // hôm nay: Pancake chưa đồng bộ
    ]);
    const p = buildPlan("2026-11-21", merged, 0, DEFAULT_TARGETS);
    assert.equal(p.month.spent, 2_400_000);
    assert.equal(p.month.revenue, 16_000_000);
    assert.equal(p.month.spentWithRevenue, 2_000_000); // không tính 400k của hôm nay
    assert.equal(p.month.ratio, 2_000_000 / 16_000_000);
    assert.equal(p.month.revenueThrough, "2026-11-20");
    assert.equal(p.month.adRevenue, 5_500_000);
    assert.equal(p.month.orders, 55);
    const late = buildPlan("2026-11-22", merged, 0, DEFAULT_TARGETS);
    assert.deepEqual(late.yesterday, { ngay: "2026-11-21", spent: 400_000, revenue: null, ratio: null });
  });

  it("dự chi = đang thực chạy + kế hoạch (nháp chưa lên)", () => {
    const p = buildPlan("2026-11-21", days, 900_000, { ...DEFAULT_TARGETS, month_budget: 40_000_000 }, 500_000);
    assert.equal(p.today.running, 999_900);
    assert.equal(p.today.drafts, 555_500);
    assert.equal(p.today.planned, 1_555_400);
    assert.equal(p.today.plannedMeta, 1_400_000);
    assert.equal(p.today.gap, 2_000_000 - 1_555_400);
    assert.equal(p.today.adsNeeded, 7); // 444.600 / 72.215 = 6,16
    const unknown = buildPlan("2026-11-21", days, null, DEFAULT_TARGETS, 500_000);
    assert.equal(unknown.today.planned, null); // chưa đọc được phần đang chạy thì không báo tổng
    assert.equal(unknown.today.drafts, 555_500);
  });

  it("ngày thiếu số chi: từ ngày 1 tới hôm qua, bỏ hôm nay và ngày đã có chi", () => {
    const have = [day("2026-11-03", 500_000, 0), day("2026-11-04", 0, 0), day("2026-11-06", 700_000, 0), day("2026-10-31", 1, 0)];
    assert.deepEqual(missingSpendDays("2026-11-07", have), ["2026-11-01", "2026-11-02", "2026-11-04", "2026-11-05"]);
    assert.deepEqual(missingSpendDays("2026-11-01", have), []); // ngày 1: chưa có ngày nào để thiếu
    assert.equal(missingSpendDays("2026-11-21", days).length, 0);
  });

  it("chỉ tính nhóm thực sự đang chạy: nhóm và chiến dịch đều bật", () => {
    assert.equal(isRunning({ adset_status: "ACTIVE", campaign_status: "ACTIVE" }), true);
    assert.equal(isRunning({ adset_status: "ACTIVE", campaign_status: "PAUSED" }), false); // chiến dịch tắt nghỉ lễ
    assert.equal(isRunning({ adset_status: "PAUSED", campaign_status: "ACTIVE" }), false);
    assert.equal(isRunning({ adset_status: "ARCHIVED", campaign_status: "ACTIVE" }), false);
    assert.equal(isRunning({}), false);
  });

  it("mục tiêu theo khoảng ngày thắng mục tiêu chung; khoảng nhập sau thắng khi trùng; 0 = nghỉ", () => {
    const base = { ...DEFAULT_TARGETS, month_budget: 40_000_000, day_budget: 1_500_000 };
    const periods = [
      { id: 1, tu: "2026-12-10", den: "2026-12-14", day_budget: 4_000_000, ratio: 0.25, note: "Sale 12.12" },
      { id: 2, tu: "2026-12-12", den: "2026-12-12", day_budget: 6_000_000, ratio: null, note: null },
      { id: 3, tu: "2026-11-24", den: "2026-11-24", day_budget: 0, ratio: null, note: "Nghỉ lễ" },
    ];
    assert.equal(targetsForDay("2026-12-09", base, periods).period, null);
    assert.equal(targetsForDay("2026-12-09", base, periods).targets.day_budget, 1_500_000);
    const sale = targetsForDay("2026-12-11", base, periods);
    assert.equal(sale.period?.id, 1);
    assert.deepEqual([sale.targets.day_budget, sale.targets.ratio], [4_000_000, 0.25]);
    const peak = targetsForDay("2026-12-12", base, periods);
    assert.deepEqual([peak.period?.id, peak.targets.day_budget, peak.targets.ratio], [2, 6_000_000, 0.2]); // tỉ lệ trống: dùng chung
    const off = targetsForDay("2026-11-24", base, periods);
    const p = buildPlan("2026-11-24", days, 0, off.targets);
    assert.deepEqual([p.today.target, p.today.targetFrom, p.today.adsNeeded], [0, "day", 0]); // nghỉ: mục tiêu 0, không cần lên thêm
    assert.deepEqual(overlaps(periods), [[1, 2]]);
  });

  it("nháp tính vào ngày nào: có hẹn giờ thì từ ngày hẹn, không hẹn thì từ hôm nay", () => {
    assert.equal(draftCountsOn("2026-11-24", "2026-11-24", null), true);
    assert.equal(draftCountsOn("2026-11-26", "2026-11-24", null), true);
    assert.equal(draftCountsOn("2026-11-24", "2026-11-24", "2026-11-25T08:00"), false);
    assert.equal(draftCountsOn("2026-11-25", "2026-11-24", "2026-11-25T08:00"), true);
    assert.equal(draftCountsOn("2026-11-27", "2026-11-24", "2026-11-25T08:00"), true);
  });

  it("đọc ô nhập tiền và phần trăm", () => {
    assert.equal(parseMoney("200tr"), 200_000_000);
    assert.equal(parseMoney("6,5 triệu"), 6_500_000);
    assert.equal(parseMoney("65k"), 65_000);
    assert.equal(parseMoney("65.000đ"), 65_000);
    assert.equal(parseMoney("2,000,000"), 2_000_000);
    assert.equal(parseMoney(""), null);
    assert.equal(parseMoney("abc"), null);
    assert.equal(parseMoney("0"), null);
    assert.equal(parseRatio("20%"), 0.2);
    assert.equal(parseRatio("17,5"), 0.175);
    assert.equal(parseRatio("0,2"), 0.2);
    assert.equal(parseRatio("0"), null);
    assert.equal(parseRatio("150"), null);
  });
});
