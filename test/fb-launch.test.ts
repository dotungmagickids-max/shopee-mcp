/** FB Magic Tool, phần lên camp: đọc mã trong bài, đặt tên, chia tài khoản, tham số gửi Meta luôn tạm dừng. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { adParams, adsetParams, buildPlan, campaignParams, codesFromText, nextName, pageShort, planBudget, suggestAdsetName, suggestCampaignName, validate, type LaunchConfig } from "../src/lib/facebook/launch";

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

  it("1-1-N (test): một chiến dịch, một nhóm, mỗi bài một quảng cáo; ngân sách ABO ở nhóm", () => {
    const plan = buildPlan(cfg({ accounts: ["111111"], shape: "1-1-n", cbo_name: "TT-MG-BD26011-01", adset_name: "TN-NU2540-AUTO" }), items);
    assert.equal(plan.length, 1);
    assert.equal(plan[0].name, "TT-MG-BD26011-01");
    assert.equal(plan[0].daily_budget, null);
    assert.equal(plan[0].adsets.length, 1);
    assert.deepEqual(plan[0].adsets[0].ads.map((a) => a.ad_name), items.map((i) => i.name));
    assert.equal(plan[0].adsets[0].name, "TN-NU2540-AUTO");
    assert.equal(plan[0].adsets[0].daily_budget, 200_000);
    assert.equal(planBudget(plan), 200_000);
    assert.equal(campaignParams(plan[0]).daily_budget, undefined);
  });

  it("1-N-1 (scale): một chiến dịch, mỗi bài một nhóm; ABO thì mỗi nhóm một ngân sách, CBO thì ngân sách ở chiến dịch", () => {
    const abo = buildPlan(cfg({ accounts: ["111111"], shape: "1-n-1", cbo_name: "TT-MG-GOM-02", adset_name: "TN-NU2540-AUTO" }), items);
    assert.equal(abo.length, 1);
    assert.deepEqual(abo[0].adsets.map((s) => s.name), ["TN-NU2540-AUTO-01", "TN-NU2540-AUTO-02", "TN-NU2540-AUTO-03"]);
    assert.deepEqual(abo[0].adsets.map((s) => s.ads.length), [1, 1, 1]);
    assert.equal(planBudget(abo), 600_000);
    const cbo = buildPlan(cfg({ accounts: ["111111"], shape: "1-n-1", structure: "cbo", cbo_name: "X" }), items);
    assert.equal(cbo[0].daily_budget, 200_000);
    assert.equal(cbo[0].adsets[0].daily_budget, null);
    assert.equal(planBudget(cbo), 200_000);
    // Hai tài khoản: mỗi tài khoản một chiến dịch, bài chia lần lượt.
    const two = buildPlan(cfg({ shape: "1-1-n", cbo_name: "X" }), items);
    assert.deepEqual(two.map((c) => c.adsets[0].ads.length), [2, 1]);
  });

  it("gợi ý tên chiến dịch và tên nhóm theo quy ước", () => {
    assert.deepEqual(["Magic Kids", "Magickids.Official", "Magickids Store", "Annie Baby"].map(pageShort), ["MG", "MGO", "MGS", "AB"]);
    assert.equal(suggestCampaignName("MG", ["ADT25003"], []), "TT-MG-ADT25003-01");
    assert.equal(suggestCampaignName("MG", ["ADT25003"], ["TT-MG-ADT25003-01", "tt-mg-adt25003-04", "TT-MG-ADT25002-09"]), "TT-MG-ADT25003-05");
    assert.equal(suggestCampaignName("MG", ["ADT26001", "ADT26002", "ADT26001"], []), "TT-MG-ADT26001.ADT26002-01");
    assert.equal(suggestCampaignName("MGO", ["A1", "B2", "C3"], ["TT-MGO-GOM-02"]), "TT-MGO-GOM-03");
    assert.equal(suggestCampaignName("AB", [], []), "TT-AB-GOM-01");
    assert.equal(suggestAdsetName({ gender: "female", age_min: 25, age_max: 40, placement: "auto" }), "TN-NU2540-AUTO");
    assert.equal(suggestAdsetName({ gender: "all", age_min: 25, age_max: 65, placement: "facebook" }), "TN-ALL2565-FB");
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

it("creative có nút nhắn tin dùng khi Meta báo bài không hợp mục tiêu", async () => {
  const { creativeParamsWithCta, isCreativeIncompatible } = await import("../src/lib/facebook/launch");
  const p = creativeParamsWithCta("111_222", "BD26005-P01-V01");
  assert.equal(p.object_story_id, "111_222");
  assert.deepEqual(JSON.parse(p.call_to_action), { type: "MESSAGE_PAGE", value: { app_destination: "MESSENGER" } });
  assert.equal(isCreativeIncompatible("Meta API 400: The ad's creative is incompatible with the objective of the campaign that the ad belongs to. (mã 100)"), true);
  assert.equal(isCreativeIncompatible("Meta API 400: Invalid parameter (mã 100)"), false);
});
