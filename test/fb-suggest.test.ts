/** FB Magic Tool, màn Đề xuất chạy: xếp nhãn theo mã và theo bài. Số trong test là số giả. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_CEILING, type Ceiling } from "../src/lib/facebook/magic";
import { buildSuggestions, codeLabel, launchGroups, postVerdict, type AdStat, type StockMap, type SuggestPost } from "../src/lib/facebook/suggest-run";

const C: Ceiling = DEFAULT_CEILING; // trần lãi 20%, hòa vốn 36%
const ceilings = new Map<string, Ceiling>([["*", C]]);
const post = (id: string, codes: string[], day = "2026-11-20", offWall = false): SuggestPost => ({ id, page_id: id.split("_")[0], day, picture: null, permalink: null, message: "", codes, offWall });
const ad = (ad_id: string, story_id: string | null, spendReal: number, orders: number, revenue: number, running = true, codes: string[] = []): AdStat => ({
  ad_id,
  ad_name: `${codes[0] ?? "X"}-P01-V01`,
  story_id,
  codes,
  running,
  spendReal,
  orders,
  revenue,
});

describe("FB Magic Tool: đề xuất chạy", () => {
  it("nhãn bài: thắng, từng tốt đang tắt, chưa chạy, lỗ, theo dõi", () => {
    assert.equal(postVerdict({ spendReal: 0, orders: 0, revenue: 0, running: 0 }, C), "new");
    assert.equal(postVerdict({ spendReal: 300_000, orders: 3, revenue: 2_000_000, running: 1 }, C), "winner");
    assert.equal(postVerdict({ spendReal: 300_000, orders: 3, revenue: 2_000_000, running: 0 }, C), "rerun");
    assert.equal(postVerdict({ spendReal: 200_000, orders: 0, revenue: 0, running: 1 }, C), "loser");
    assert.equal(postVerdict({ spendReal: 400_000, orders: 2, revenue: 1_000_000, running: 1 }, C), "loser"); // 40% > hòa vốn
    assert.equal(postVerdict({ spendReal: 100_000, orders: 0, revenue: 0, running: 1 }, C), "watch"); // chưa tới 150k
    assert.equal(postVerdict({ spendReal: 100_000, orders: 1, revenue: 800_000, running: 1 }, C), "watch"); // mới 1 đơn
  });

  it("nhãn mã theo ngưỡng mặc định", () => {
    const base = { spendReal: 500_000, orders: 5, revenue: 4_000_000, postsRun: 3, postsNew: 0 };
    assert.equal(codeLabel(base, { stock: 100, days: 12 }, C).label, "scale");
    assert.equal(codeLabel(base, null, C).label, "scale"); // chưa có số tồn: không chặn
    assert.equal(codeLabel({ ...base, postsRun: 1, postsNew: 2 }, { stock: 100, days: 12 }, C).label, "test");
    assert.equal(codeLabel(base, { stock: 5, days: 2 }, C).label, "stop"); // dưới 3 ngày hàng
    assert.equal(codeLabel(base, { stock: 0, days: null }, C).label, "stop");
    assert.equal(codeLabel({ ...base, orders: 0, revenue: 0, spendReal: 160_000 }, { stock: 100, days: 50 }, C).label, "stop");
    assert.equal(codeLabel({ ...base, revenue: 1_000_000 }, { stock: 100, days: 12 }, C).label, "stop"); // 50%
    assert.equal(codeLabel({ spendReal: 0, orders: 0, revenue: 0, postsRun: 0, postsNew: 2 }, { stock: 80, days: 45 }, C).label, "try");
    assert.equal(codeLabel({ spendReal: 0, orders: 0, revenue: 0, postsRun: 0, postsNew: 2 }, { stock: 80, days: null }, C).label, "try"); // tồn mà chưa bán
    assert.equal(codeLabel({ spendReal: 0, orders: 0, revenue: 0, postsRun: 0, postsNew: 2 }, { stock: 80, days: 10 }, C).label, "watch");
    assert.equal(codeLabel({ ...base, revenue: 2_000_000 }, { stock: 100, days: 12 }, C).label, "watch"); // 25%: giữa trần và hòa vốn
    assert.match(codeLabel(base, { stock: 100, days: 12 }, C).reason, /chi 500k, 5 đơn, 13%/);
  });

  it("gom quảng cáo theo bài, bài theo mã; nút lên camp theo page", () => {
    const posts = [post("1_10", ["AA26001"]), post("1_11", ["AA26001"]), post("2_12", ["AA26001"]), post("1_13", ["BB26002"]), post("1_14", ["BB26002"], "2026-11-20", true), post("1_15", [])];
    const ads = [
      ad("a1", "1_10", 200_000, 3, 2_000_000, true),
      ad("a2", "1_10", 100_000, 1, 500_000, false),
      ad("a3", "9_99", 50_000, 0, 0, false, ["AA26001"]), // bài cũ, không đọc được: lấy mã từ tên quảng cáo
      ad("a4", null, 30_000, 0, 0, true, ["BB26002"]),
    ];
    const stock: StockMap = new Map([["AA26001", { stock: 200, days: 20 }], ["BB26002", { stock: 90, days: 60 }]]);
    const rows = buildSuggestions({ ads, posts, stock, ceilings });
    assert.deepEqual(rows.map((r) => [r.code, r.label]), [["AA26001", "test"], ["BB26002", "try"]]);
    const aa = rows[0];
    assert.equal(aa.spendReal, 350_000);
    assert.equal(aa.orders, 4);
    assert.equal(aa.adsRunning, 1);
    assert.equal(aa.postsRun, 2);
    assert.equal(aa.postsNew, 2);
    assert.deepEqual(aa.posts.map((p) => [p.story_id, p.verdict]), [["1_10", "winner"], ["1_11", "new"], ["2_12", "new"], ["9_99", "watch"]]);
    assert.deepEqual(launchGroups(aa), [
      { kind: "scale", page_id: "1", posts: ["1_10"] },
      { kind: "test", page_id: "1", posts: ["1_11"] },
      { kind: "test", page_id: "2", posts: ["2_12"] },
    ]);
    const bb = rows[1];
    assert.equal(bb.spendReal, 30_000); // quảng cáo không rõ bài vẫn tính vào mã
    assert.deepEqual(bb.posts.map((p) => p.story_id), ["1_13"]); // bài ngoài tường chưa chạy không đưa vào
    assert.deepEqual(launchGroups({ ...aa, label: "stop" }), []);
  });
});
