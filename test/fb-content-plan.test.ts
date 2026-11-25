/** Lịch content đa kênh và mục Thiếu content gì. Số trong test là số giả. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { contentGaps, matchPosted, parsePlanForm, taskOf, weekStart, type PlanItem } from "../src/lib/facebook/content-plan";
import { DEFAULT_CEILING } from "../src/lib/facebook/magic";
import type { CodeRow, StockMap, SuggestPost } from "../src/lib/facebook/suggest-run";

const PAGES = { "1": "Page A", "2": "Page B", "9": "Page khác hãng" };
const form = (o: Record<string, string>) => (k: string) => o[k] ?? "";
const post = (id: string, codes: string[], kind: SuggestPost["kind"], day = "2026-11-20"): SuggestPost => ({ id, page_id: id.split("_")[0], day, picture: null, permalink: `https://fb.test/${id}`, message: "", codes, offWall: false, kind });
const row = (code: string, label: CodeRow["label"], postsNew = 1): CodeRow => ({ code, label, reason: "", spendReal: 0, orders: 3, revenue: 0, ratio: null, ceiling: DEFAULT_CEILING, stock: 100, stockDays: 20, adsRunning: 0, postsRun: 1, postsNew, posts: [] });
const item = (o: Partial<PlanItem>): PlanItem => ({ id: 1, ngay: null, kenh: "facebook", noi_dang: "1", ma: ["AA26001"], dang: "anh", tieu_de: "", ghi_chu: "", ly_do: "", nguoi: "", trang_thai: "can_lam", link: "", task_id: null, nguon: "tay", created_at: "2026-11-18T03:00:00Z", ...o });

describe("Lịch content", () => {
  it("đọc form: kênh|nơi đăng, mã, dạng, báo lỗi rõ", () => {
    const ok = parsePlanForm(form({ ngay: "2026-11-27", noi: "facebook|1", dang: "video", ma: "aa26001, bb26002", tieu_de: "phối đồ" }), PAGES);
    assert.ok(ok.ok);
    assert.deepEqual([ok.row.kenh, ok.row.noi_dang, ok.row.dang, ok.row.ma, ok.row.trang_thai, ok.row.nguon], ["facebook", "1", "video", ["AA26001", "BB26002"], "can_lam", "tay"]);
    const shopee = parsePlanForm(form({ noi: "shopee|Shopee Magickids", tieu_de: "video shop" }), PAGES);
    assert.ok(shopee.ok && shopee.row.ngay === null && shopee.row.kenh === "shopee" && shopee.row.noi_dang === "Shopee Magickids");
    assert.deepEqual(parsePlanForm(form({ noi: "facebook|777", ma: "AA26001" }), PAGES), { ok: false, error: "Chọn page Facebook trong danh sách." });
    assert.equal(parsePlanForm(form({ noi: "facebook|1" }), PAGES).ok, false); // không mã, không ý tưởng
    assert.equal(parsePlanForm(form({ noi: "facebook|1", ma: "???" }), PAGES).ok, false);
    assert.equal(parsePlanForm(form({ noi: "facebook|1", ma: "AA26001", ngay: "27/11" }), PAGES).ok, false);
    assert.equal(parsePlanForm(form({ noi: "facebook|1", ma: "AA26001", link: "fb.com/x" }), PAGES).ok, false);
  });

  it("tuần bắt đầu từ thứ Hai", () => {
    assert.equal(weekStart("2026-11-25"), "2026-11-23"); // thứ Tư → thứ Hai
    assert.equal(weekStart("2026-11-29"), "2026-11-23"); // Chủ nhật
    assert.equal(weekStart("2026-11-23"), "2026-11-23");
  });

  it("việc giao: có page, mã, dạng bài, ngày đăng, cần gửi lại gì", () => {
    const t = taskOf(item({ id: 7, ngay: "2026-11-27", tieu_de: "phối đồ", ly_do: "Thiếu bài ảnh" }), PAGES);
    assert.equal(t.title, "Làm content ảnh mã AA26001 cho page Page A, đăng 27/11. Gửi lại link bài hoặc thư mục ảnh/video.");
    assert.match(t.detail, /Ý tưởng: phối đồ\nLý do: Thiếu bài ảnh\nDòng lịch content số 7\./);
    assert.match(taskOf(item({ kenh: "shopee", noi_dang: "Shopee Magickids", dang: "video" }), PAGES).title, /^Làm content video mã AA26001 cho Shopee Magickids\./);
  });

  it("khớp bài đã đăng: đúng page, đúng mã, đúng dạng, từ ngày tạo dòng", () => {
    const posts = [post("1_1", ["AA26001"], "photo", "2026-11-10"), post("1_2", ["AA26001"], "reel", "2026-11-21"), post("2_3", ["AA26001"], "photo", "2026-11-21"), post("1_4", ["AA26001"], "photo", "2026-11-22")];
    assert.equal(matchPosted(item({}), posts)?.id, "1_4"); // bài 10/11 đăng trước khi tạo dòng; reel không phải ảnh; page 2 sai page
    assert.equal(matchPosted(item({ dang: "video" }), posts)?.id, "1_2");
    assert.equal(matchPosted(item({ trang_thai: "da_dang" }), posts), null);
    assert.equal(matchPosted(item({ kenh: "shopee" }), posts), null);
  });

  it("thiếu content gì: thiếu ảnh, thiếu video, hết bài test, một page, chưa có bài", () => {
    const posts = [
      post("1_1", ["AA26001"], "reel"), // AA: chỉ có video, chỉ trên page 1
      post("1_2", ["BB26002"], "photo"),
      post("2_3", ["BB26002"], "video", "2026-09-30"), // quá 30 ngày: không tính cho thiếu video
      post("9_4", ["CC26003"], "photo"),
      post("1_5", ["DD26004"], "photo"), // mã "Đừng chạy": không báo
    ];
    const stock: StockMap = new Map([["EE26005", { stock: 80, days: null }], ["FF26006", { stock: 10, days: 5 }], ["AA26001", { stock: 500, days: 30 }], ["X1", { stock: 999, days: null }]]);
    const gaps = contentGaps({
      rows: [row("AA26001", "scale", 0), row("BB26002", "test"), row("CC26003", "try"), row("DD26004", "stop")],
      posts,
      stock,
      today: "2026-11-25",
      multiPages: ["1", "2"],
      planned: [item({ id: 5, ma: ["BB26002"], dang: "reel" })],
    });
    assert.deepEqual(gaps.map((g) => [g.flag, g.code, g.dang, g.page_id, g.plannedId]), [
      ["het_bai_test", "AA26001", "anh", "1", null],
      ["thieu_anh", "AA26001", "anh", "1", null],
      ["thieu_video", "BB26002", "video", "1", 5], // đã có dòng reel trong lịch
      ["thieu_video", "CC26003", "video", "9", null],
      ["mot_page", "AA26001", "video", "2", null], // gợi ý đăng sang page còn lại
      ["chua_co_bai", "EE26005", "anh", null, null], // FF tồn ít; AA đã có bài; X1 không đúng dạng mã
    ]);
  });
});
