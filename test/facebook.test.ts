/** Nhân viên Facebook: luật đề xuất, gom đơn theo quảng cáo, đọc số mua Meta, nội dung báo sáng. */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { morningText } from "../src/lib/facebook/jobs";
import { EXCLUDED_ACCOUNTS, pickPurchase } from "../src/lib/facebook/meta";
import { groupByAd } from "../src/lib/facebook/orders";
import { DEFAULT_RULES, loadRules, pauseCandidates, rankAds, ratio, scaleCandidates, sumByAccount, type AdDay } from "../src/lib/facebook/rules";
import { fbSend } from "../src/lib/facebook/telegram";

function ad(p: Partial<AdDay>): AdDay {
  return {
    ngay: "2026-11-12",
    ad_id: "1",
    account_id: "acc",
    account_name: "BOSS TUYỀN 2",
    campaign_name: "C",
    adset_name: "S",
    ad_name: "A",
    spend: 0,
    orders: 0,
    revenue: 0,
    cpas: false,
    meta_purchases: 0,
    meta_purchase_value: 0,
    ...p,
  };
}

describe("đề xuất tắt", () => {
  it("chi ≥ 140k mà 0 đơn thì đề xuất; có đơn hoặc chi ít thì không", () => {
    const r = pauseCandidates([
      ad({ ad_id: "a", spend: 150_000 }),
      ad({ ad_id: "b", spend: 150_000, orders: 1, revenue: 300_000 }),
      ad({ ad_id: "c", spend: 100_000 }),
    ]);
    assert.deepEqual(r.map((p) => p.ad.ad_id), ["a"]);
  });
  it("CPAS tính đơn theo số mua Meta, không theo Pancake", () => {
    const r = pauseCandidates([
      ad({ ad_id: "x", spend: 200_000, cpas: true, meta_purchases: 2, meta_purchase_value: 600_000 }),
      ad({ ad_id: "y", spend: 200_000, cpas: true, orders: 3 }),
    ]);
    assert.deepEqual(r.map((p) => p.ad.ad_id), ["y"]);
  });
});

describe("đề xuất tăng", () => {
  it("2 ngày liền ≤ 18% và ≥ 2 đơn mỗi ngày", () => {
    const h = [
      ad({ ad_id: "g", ngay: "2026-11-11", spend: 100_000, orders: 3, revenue: 900_000 }), // 12%
      ad({ ad_id: "g", ngay: "2026-11-12", spend: 120_000, orders: 4, revenue: 1_000_000 }), // 13%
      ad({ ad_id: "h", ngay: "2026-11-11", spend: 100_000, orders: 3, revenue: 900_000 }),
      ad({ ad_id: "h", ngay: "2026-11-12", spend: 300_000, orders: 3, revenue: 1_000_000 }), // 33%
      ad({ ad_id: "k", ngay: "2026-11-12", spend: 50_000, orders: 5, revenue: 2_000_000 }), // thiếu ngày 11
    ];
    const r = scaleCandidates(h, "2026-11-12");
    assert.deepEqual(r.map((p) => p.ad.ad_id), ["g"]);
    assert.match(r[0].reason, /12%, 13%/);
  });
});

describe("tỉ lệ và tổng theo tài khoản", () => {
  it("chi thật nhân 1,111", () => {
    assert.equal(Math.round(ratio(ad({ spend: 1_000_000, orders: 5, revenue: 5_555_000 }))! * 100), 20);
    assert.equal(ratio(ad({ spend: 1000 })), null);
  });
  it("cộng theo tài khoản", () => {
    const s = sumByAccount([
      ad({ ad_id: "1", spend: 100_000, orders: 1, revenue: 500_000 }),
      ad({ ad_id: "2", spend: 100_000, orders: 1, revenue: 500_000 }),
    ]);
    assert.equal(s.length, 1);
    assert.equal(s[0].spendReal, 222_200);
    assert.equal(s[0].orders, 2);
  });
  it("tốt/kém chỉ xét quảng cáo chi đủ nhiều", () => {
    const { best, worst } = rankAds([
      ad({ ad_id: "good", spend: 300_000, orders: 5, revenue: 3_000_000 }),
      ad({ ad_id: "bad", spend: 400_000, orders: 1, revenue: 400_000 }),
      ad({ ad_id: "tiny", spend: 10_000 }),
    ]);
    assert.deepEqual(best.map((a) => a.ad_id), ["good"]);
    assert.deepEqual(worst.map((a) => a.ad_id), ["bad"]);
  });
});

describe("đầu vào", () => {
  it("gom đơn Pancake theo ad_id, bỏ đơn hủy và đơn không có quảng cáo", () => {
    const it = (code: string, qty: number, cost: number) => ({ quantity: qty, variation_info: { last_imported_price: cost, product_display_id: code } });
    const m = groupByAd([
      { ad_id: "120", status: 0, total_price: 298000, items: [it("ADT25002", 2, 75000)] },
      { ad_id: "120", status: 3, total_price: 200000, items: [it("ADT25002", 1, 75000), it("QD26001", 1, 60000)] },
      { ad_id: "120", status: 6, total_price: 999999, items: [it("BD24066", 5, 1)] },
      { ad_id: null, status: 1, total_price: 100 },
    ]);
    assert.deepEqual(m.get("120"), { orders: 2, revenue: 498000, cogs: 285000, product_code: "ADT25002" });
    assert.equal(m.size, 1);
  });
  it("số mua Meta: lấy một loại, không cộng trùng", () => {
    assert.equal(pickPurchase([{ action_type: "purchase", value: "3" }, { action_type: "omni_purchase", value: "3" }]), 3);
    assert.equal(pickPurchase([{ action_type: "link_click", value: "9" }]), 0);
    assert.equal(pickPurchase(undefined), 0);
  });
  it("bỏ BOSS TUYỀN 3/4/5/6", () => {
    assert.equal(EXCLUDED_ACCOUNTS.size, 4);
    assert.ok(EXCLUDED_ACCOUNTS.has("263854262635122"));
  });
  it("FB_RULES ghi đè ngưỡng, giá trị sai thì giữ mặc định", () => {
    const r = loadRules('{"pauseSpendNoOrder":200000,"scaleMaxRatio":"x"}');
    assert.equal(r.pauseSpendNoOrder, 200000);
    assert.equal(r.scaleMaxRatio, DEFAULT_RULES.scaleMaxRatio);
    assert.deepEqual(loadRules("không phải json"), DEFAULT_RULES);
  });
});

describe("báo sáng", () => {
  it("tách CPAS khỏi tổng bán qua Pancake, ghi tên tài khoản", () => {
    const t = morningText("2026-11-12", [
      ad({ ad_id: "1", spend: 1_000_000, orders: 10, revenue: 5_000_000 }),
      ad({ ad_id: "2", account_id: "cp", account_name: "CPAS SHOPEE MAGICKIDS", cpas: true, spend: 500_000, meta_purchases: 4, meta_purchase_value: 2_000_000 }),
    ]);
    assert.match(t, /12\/11\/2026/);
    assert.match(t, /Chi thật 1,1tr — 10 đơn — 5tr → <b>22%<\/b>/);
    assert.match(t, /CPAS → Shopee.*4 đơn/);
    assert.match(t, /BOSS TUYỀN 2 \(acc\)/);
  });
});

describe("gửi tin", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
    delete process.env.FB_TELEGRAM_BOT_TOKEN;
    delete process.env.FB_TELEGRAM_THREAD_ID;
  });
  it("vào chủ đề Facebook, bằng token bot Facebook", async () => {
    const calls: { url: string; body: any }[] = [];
    globalThis.fetch = (async (u: string, init: any) => {
      calls.push({ url: String(u), body: JSON.parse(init.body) });
      return new Response(JSON.stringify({ ok: true, result: { message_id: 9 } }));
    }) as any;
    process.env.FB_TELEGRAM_BOT_TOKEN = "FBTOKEN";
    process.env.FB_TELEGRAM_THREAD_ID = "33";
    process.env.TELEGRAM_CHAT_ID = "-100500";
    assert.equal(await fbSend("x"), 9);
    assert.match(calls[0].url, /botFBTOKEN\/sendMessage/);
    assert.equal(calls[0].body.message_thread_id, 33);
  });
  it("chưa có token thì không gửi", async () => {
    process.env.TELEGRAM_CHAT_ID = "-100500";
    assert.equal(await fbSend("x"), null);
  });
});

describe("thao tác Meta", () => {
  it("ngân sách: nhóm (ABO) trước, rồi chiến dịch (CBO), trọn đời thì không", async () => {
    const { budgetTarget } = await import("../src/lib/facebook/meta");
    const base = { ad_id: "1", effective_status: "ACTIVE" };
    assert.deepEqual(
      budgetTarget({ ...base, adset: { id: "s", daily_budget: 300000, lifetime_budget: null }, campaign: { id: "c", daily_budget: null, lifetime_budget: null } }),
      { level: "adset", id: "s", daily: 300000 }
    );
    assert.equal(
      budgetTarget({ ...base, adset: { id: "s", daily_budget: null, lifetime_budget: null }, campaign: { id: "c", daily_budget: 1000000, lifetime_budget: null } })?.level,
      "campaign"
    );
    assert.equal(budgetTarget({ ...base, adset: { id: "s", daily_budget: null, lifetime_budget: 5e6 }, campaign: { id: "c", daily_budget: null, lifetime_budget: null } }), null);
  });
  it("tăng 20%, làm tròn nghìn, không quá trần mỗi lần", async () => {
    const { scaledBudget } = await import("../src/lib/facebook/meta");
    assert.equal(scaledBudget(300_000, 0.2, 500_000), 360_000);
    assert.equal(scaledBudget(333_333, 0.2, 500_000), 400_000);
    assert.equal(scaledBudget(5_000_000, 0.2, 500_000), 5_500_000);
  });
});

describe("bảo mật Meta", () => {
  it("appsecret_proof = HMAC-SHA256(token, app secret)", async () => {
    const { appSecretProof } = await import("../src/lib/facebook/meta");
    const { createHmac } = await import("node:crypto");
    assert.equal(appSecretProof("tok", "sec"), createHmac("sha256", "sec").update("tok").digest("hex"));
    assert.match(appSecretProof("tok", "sec"), /^[0-9a-f]{64}$/);
    assert.notEqual(appSecretProof("tok", "sec"), appSecretProof("tok", "khac"));
  });
  it("lỗi không lộ token", async () => {
    const { scrub } = await import("../src/lib/facebook/meta");
    assert.equal(scrub("https://x/?access_token=EAAB123&appsecret_proof=abc&limit=5"), "https://x/?access_token=***&appsecret_proof=***&limit=5");
  });
  it("mọi request gửi kèm appsecret_proof, lỗi trả về không chứa token", async () => {
    const { adInsights } = await import("../src/lib/facebook/meta");
    const real = globalThis.fetch;
    const urls: string[] = [];
    process.env.META_SYSTEM_TOKEN = "EAABsecret";
    process.env.META_APP_SECRET = "appsec";
    globalThis.fetch = (async (u: any) => {
      urls.push(String(u));
      return new Response(JSON.stringify({ error: { message: "Invalid token access_token=EAABsecret", code: 190 } }), { status: 400 });
    }) as any;
    try {
      await assert.rejects(adInsights("123", "2026-11-12"), (e: Error) => !e.message.includes("EAABsecret"));
      assert.match(urls[0], /appsecret_proof=[0-9a-f]{64}/);
      assert.match(urls[0], /\/v27\.0\//);
    } finally {
      globalThis.fetch = real;
      delete process.env.META_SYSTEM_TOKEN;
      delete process.env.META_APP_SECRET;
    }
  });
});

describe("lãi / lỗ và content", () => {
  it("lãi = doanh thu − giá vốn − QC thật − thuế 1,5% − đóng gói 5k/đơn; CPAS không tính", async () => {
    const { profit, codeFromName } = await import("../src/lib/facebook/rules");
    // 1.000.000 − 400.000 − 222.200 − 15.000 − 4×5.000 = 342.800
    assert.equal(profit({ cpas: false, spend: 200_000, orders: 4, revenue: 1_000_000, cogs: 400_000 }), 342_800);
    assert.equal(profit({ cpas: true, spend: 1, orders: 1, revenue: 1, cogs: 0 }), null);
    assert.equal(codeFromName("ADT25002-P01-A01-L5"), "ADT25002");
    assert.equal(codeFromName(null, "TT-MG-ADT26001.ADT26002-01"), "ADT26001");
    assert.equal(codeFromName("Bài mới"), null);
  });
  it("báo sáng có lãi/lỗ, mã sắp hết hàng, content thắng/thua 7 ngày, đề xuất thêm", () => {
    const yesterday = [
      ad({ ad_id: "w", ad_name: "ADT25002-P01-A01", product_code: "ADT25002", spend: 300_000, orders: 8, revenue: 2_400_000, cogs: 900_000 }),
      ad({ ad_id: "l", ad_name: "QD26001-P02-V01", product_code: "QD26001", spend: 400_000, orders: 1, revenue: 300_000, cogs: 120_000 }),
    ];
    const week = [...yesterday, { ...yesterday[0], ngay: "2026-11-11" }, { ...yesterday[1], ngay: "2026-11-11" }];
    const t = morningText("2026-11-12", yesterday, [], week, new Map([["ADT25002", { stock: 100, days: 4 }]]));
    assert.match(t, /Lãi ước tính/);
    assert.match(t, /ADT25002: chi .*lãi .*⚠️ tồn 100, đủ ~4 ngày/);
    assert.match(t, /QD26001: chi .*<b>lỗ<\/b>/);
    assert.match(t, /Content 7 ngày[\s\S]*🟢 ADT25002-P01-A01[\s\S]*🔴 QD26001-P02-V01/);
    assert.match(t, /Nhân bản content thắng ADT25002-P01-A01/);
    assert.match(t, /ADT25002 sắp hết hàng/);
  });
});
