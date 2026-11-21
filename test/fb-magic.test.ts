/** FB Magic Tool, phần đánh giá: đọc mã từ tên, trần, màu, gợi ý, gom theo cấp, đơn bỏ trạng thái 6. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { addDays } from "../src/lib/autopilot/time";
import { ceilingFor, codesFromName, colorOf, evaluate, rangeOf, suggest, type AdRow, type Ceiling } from "../src/lib/facebook/magic";
import { groupByAd } from "../src/lib/facebook/orders";

const C: Ceiling = { profit_ceiling: 0.2, breakeven: 0.36 };

function ad(p: Partial<AdRow>): AdRow {
  return {
    account_id: "1", account_name: "BOSS TUYỀN 2", ad_id: "a1", ad_name: "BD26011-P01-V01", adset_id: "s1", adset_name: "S1",
    campaign_id: "c1", campaign_name: "C1", page_id: "159993608025607", status: "ACTIVE", adset_status: "ACTIVE", campaign_status: "ACTIVE",
    adset_daily: 200_000, campaign_daily: null, spend: 0, messages: 0, orders: 0, revenue: 0, ...p,
  };
}

describe("FB Magic Tool", () => {
  it("đọc mã từ tên quảng cáo", () => {
    assert.deepEqual(codesFromName("BD26011.BD24066-P01-V01"), ["BD26011", "BD24066"]);
    assert.deepEqual(codesFromName("qd26001-P02-V03"), ["QD26001"]);
    assert.deepEqual(codesFromName("Test ADT25002 mới"), ["ADT25002"]);
    assert.deepEqual(codesFromName("Bài viết mới"), []);
  });

  it("trần: lấy dòng riêng chặt nhất, không có thì dùng *", () => {
    const t = new Map<string, Ceiling>([["*", C], ["BD26011", { profit_ceiling: 0.25, breakeven: 0.4 }], ["BD24066", { profit_ceiling: 0.15, breakeven: 0.45 }]]);
    assert.deepEqual(ceilingFor(["BD26011", "BD24066"], t), { profit_ceiling: 0.15, breakeven: 0.4 });
    assert.deepEqual(ceilingFor(["XX11111"], t), C);
  });

  it("màu", () => {
    assert.equal(colorOf(19, 100, C), "green");
    assert.equal(colorOf(30, 100, C), "yellow");
    assert.equal(colorOf(37, 100, C), "red");
    assert.equal(colorOf(50_000, 0, C), "red");
    assert.equal(colorOf(0, 0, C), "none");
  });

  it("gợi ý", () => {
    assert.equal(suggest({ spendReal: 150_000, orders: 0, revenue: 0, stockDays: 10, ceiling: C }).action, "pause");
    assert.equal(suggest({ spendReal: 149_000, orders: 0, revenue: 0, stockDays: 10, ceiling: C }).action, "keep");
    assert.equal(suggest({ spendReal: 100_000, orders: 3, revenue: 1_000_000, stockDays: 10, ceiling: C }).action, "scale");
    const low = suggest({ spendReal: 100_000, orders: 3, revenue: 1_000_000, stockDays: 2.5, ceiling: C });
    assert.equal(low.action, "keep");
    assert.match(low.reason, /không scale/);
    assert.equal(suggest({ spendReal: 400_000, orders: 2, revenue: 1_000_000, stockDays: 10, ceiling: C }).action, "reduce");
  });

  it("gom theo nhóm và chiến dịch, chi thật × 1,111, ngân sách", () => {
    const ads = [
      ad({ ad_id: "a1", spend: 100_000, messages: 10, orders: 2, revenue: 800_000 }),
      ad({ ad_id: "a2", ad_name: "BD24066-P01-V02", spend: 50_000, messages: 5, orders: 1, revenue: 300_000 }),
      ad({ ad_id: "a3", adset_id: "s2", adset_name: "S2", adset_daily: 100_000, spend: 10_000 }),
    ];
    const stock = (c: string) => (c === "BD24066" ? 2 : 20);
    const byAd = evaluate(ads, "ad", new Map([["*", C]]), stock);
    assert.equal(byAd[0].spendReal, 111_100);
    assert.equal(byAd[0].costPerMessage, 11_110);
    const sets = evaluate(ads, "adset", new Map([["*", C]]), stock);
    const s1 = sets.find((r) => r.id === "s1")!;
    assert.equal(s1.orders, 3);
    assert.equal(s1.revenue, 1_100_000);
    assert.equal(s1.budget, 200_000);
    assert.equal(s1.stockDays, 2);
    const camp = evaluate(ads, "campaign", new Map([["*", C]]), stock);
    assert.equal(camp.length, 1);
    assert.equal(camp[0].budget, 300_000); // ABO: tổng ngân sách 2 nhóm
    const cbo = evaluate([ad({ campaign_daily: 500_000, adset_daily: null, spend: 1 })], "ad", new Map(), stock);
    assert.equal(cbo[0].budget, 500_000);
    assert.equal(cbo[0].budget_level, "campaign");
  });

  it("khoảng ngày", () => {
    assert.deepEqual(rangeOf("yesterday", "2026-11-21", addDays), { since: "2026-11-20", until: "2026-11-20" });
    assert.deepEqual(rangeOf("7", "2026-11-21", addDays), { since: "2026-11-15", until: "2026-11-21" });
  });

  it("đơn Pancake: bỏ trạng thái 6 và 7", () => {
    const rows = [
      { ad_id: "x", status: 3, total_price: 100 },
      { ad_id: "x", status: 6, total_price: 200 },
      { ad_id: "x", status: 7, total_price: 300 },
    ];
    assert.equal(groupByAd(rows).get("x")!.revenue, 100);
  });
});
