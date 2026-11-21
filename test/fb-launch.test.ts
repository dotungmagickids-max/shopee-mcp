/** FB Magic Tool, phần lên camp: đọc mã trong bài, đặt tên, chia tài khoản, tham số gửi Meta luôn tạm dừng. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { adParams, adsetParams, buildPlan, campaignParams, codesFromText, nextName, planBudget, validate, type LaunchConfig } from "../src/lib/facebook/launch";

const cfg = (p: Partial<LaunchConfig> = {}): LaunchConfig => ({
  page_id: "159993608025607", accounts: ["111111", "222222"], budget: 200_000, structure: "abo",
  age_min: 25, age_max: 65, gender: "all", placement: "auto", ...p,
});
const items = [
  { post_id: "159993608025607_1", name: "BD26011-P01-V01" },
  { post_id: "159993608025607_2", name: "BD24066-P02-V01" },
  { post_id: "159993608025607_3", name: "QD26001-P01-V01" },
];

describe("FB Magic Tool: lên camp", () => {
  it("đọc mã trong bài và đặt tên kế tiếp", () => {
    assert.deepEqual(codesFromText("Set bd26011 và BD24066 về hàng. SĐT 0912345678"), ["BD26011", "BD24066"]);
    assert.equal(nextName(["BD26011"], []), "BD26011-P01-V01");
    assert.equal(nextName(["BD26011"], ["BD26011-P01-V01", "bd26011-P03-V02", "BD26011.BD24066-P07-V01"]), "BD26011-P04-V01");
    assert.equal(nextName(["BD26011", "BD24066"], ["BD26011.BD24066-P07-V01"]), "BD26011.BD24066-P08-V01");
  });

  it("ABO: mỗi bài một chiến dịch, chia đều tài khoản, ngân sách ở nhóm", () => {
    const plan = buildPlan(cfg(), items);
    assert.equal(plan.length, 3);
    assert.deepEqual(plan.map((c) => c.account_id), ["111111", "222222", "111111"]);
    assert.equal(plan[0].daily_budget, null);
    assert.equal(plan[0].adsets[0].daily_budget, 200_000);
    assert.equal(planBudget(plan), 600_000);
  });

  it("CBO: mỗi tài khoản một chiến dịch, ngân sách ở chiến dịch", () => {
    const plan = buildPlan(cfg({ structure: "cbo", cbo_name: "CBO test" }), items);
    assert.equal(plan.length, 2);
    assert.equal(plan[0].adsets.length, 2);
    assert.equal(plan[0].adsets[0].daily_budget, null);
    assert.equal(planBudget(plan), 400_000);
    assert.equal(campaignParams(plan[0]).daily_budget, "200000");
  });

  it("mọi thứ gửi Meta đều tạm dừng, đúng mục tiêu tin nhắn", () => {
    const plan = buildPlan(cfg({ gender: "female" }), items);
    const c = campaignParams(plan[0]);
    assert.equal(c.status, "PAUSED");
    assert.equal(c.objective, "OUTCOME_ENGAGEMENT");
    assert.equal(c.daily_budget, undefined);
    const s = adsetParams(cfg({ gender: "female" }), "c1", plan[0].adsets[0]);
    assert.equal(s.status, "PAUSED");
    assert.equal(s.destination_type, "MESSENGER");
    assert.equal(s.daily_budget, "200000");
    const t = JSON.parse(s.targeting);
    assert.equal(t.age_min, 25);
    assert.deepEqual(t.genders, [2]);
    assert.equal(adParams("x", "s1", "cr1").status, "PAUSED");
  });

  it("chặn cấu hình sai", () => {
    assert.equal(validate(cfg(), items), null);
    assert.match(validate(cfg({ budget: 10_000 }), items)!, /Ngân sách/);
    assert.match(validate(cfg({ accounts: [] }), items)!, /tài khoản/);
    assert.match(validate(cfg(), [{ post_id: "999_1", name: "A" }])!, /không thuộc page/);
    assert.match(validate(cfg(), [items[0], items[0]])!, /trùng/);
    assert.match(validate(cfg({ age_min: 13 }), items)!, /Tuổi/);
  });
});
