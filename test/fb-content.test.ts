/** FB Magic Tool, màn Nội dung: khoảng ngày, loại bài, lọc theo page/mã, đếm theo page và theo mã. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { contentRange, countByCode, countByPage, daysToFetch, inRange, kindOf, matches, toContentPost } from "../src/lib/facebook/content";

const raw = (id: string, message: string, created_time: string, kind = "added_photos", permalink: string | null = null) => ({
  id, message, created_time, picture: "https://example.test/a.jpg", permalink, kind,
});
const A = "111";
const B = "222";
const posts = [
  toContentPost(A, raw("111_1", "Áo adt26001 về hàng", "2026-11-20T03:00:00+0000")),
  toContentPost(A, raw("111_2", "Set BD26011 và BD24066", "2026-11-19T18:30:00+0000", "added_video")),
  toContentPost(A, raw("111_3", "Chúc cả nhà cuối tuần vui", "2026-11-10T03:00:00+0000")),
  toContentPost(B, raw("222_1", "ADT26001 màu mới", "2026-11-21T03:00:00+0000", "added_video", "https://www.facebook.com/reel/123")),
];

describe("FB Magic Tool: nội dung đã đăng", () => {
  it("khoảng ngày: mặc định 30 ngày, nút chọn nhanh, tùy chọn bị cắt về 180 ngày và không vượt hôm nay", () => {
    assert.deepEqual(contentRange({}, "2026-11-23"), { since: "2026-10-25", until: "2026-11-23", preset: "30" });
    assert.deepEqual(contentRange({ r: "7" }, "2026-11-23"), { since: "2026-11-17", until: "2026-11-23", preset: "7" });
    assert.equal(contentRange({ r: "999" }, "2026-11-23").preset, "30");
    assert.deepEqual(contentRange({ since: "2026-11-01", until: "2026-11-10" }, "2026-11-23"), { since: "2026-11-01", until: "2026-11-10", preset: "custom" });
    assert.deepEqual(contentRange({ since: "2025-01-01", until: "2026-12-31" }, "2026-11-23"), { since: "2026-05-28", until: "2026-11-23", preset: "custom" });
    assert.equal(contentRange({ since: "2026-11-10", until: "2026-11-01" }, "2026-11-23").preset, "30");
    assert.equal(contentRange({ since: "x", until: "2026-11-01" }, "2026-11-23").preset, "30");
    assert.equal(daysToFetch("2026-11-17", "2026-11-23"), 8);
  });

  it("ngày đăng tính theo giờ Việt Nam; đọc mã và loại bài", () => {
    assert.equal(posts[1].day, "2026-11-20"); // 18:30 UTC ngày 19 = 01:30 ngày 20 giờ VN
    assert.deepEqual(posts[1].codes, ["BD26011", "BD24066"]);
    assert.equal(posts[1].kind, "video");
    assert.equal(posts[3].kind, "reel");
    assert.equal(kindOf("mobile_status_update", null), "other");
    assert.ok(inRange(posts[1], "2026-11-20", "2026-11-20"));
    assert.ok(!inRange(posts[2], "2026-11-17", "2026-11-23"));
  });

  it("lọc theo page, mã (gõ một phần, không phân biệt hoa thường), loại, bài chưa gắn mã", () => {
    const ids = (f: Parameters<typeof matches>[1]) => posts.filter((p) => matches(p, f)).map((p) => p.id);
    assert.deepEqual(ids({ page: B }), ["222_1"]);
    assert.deepEqual(ids({ code: " adt26001 " }), ["111_1", "222_1"]);
    assert.deepEqual(ids({ code: "BD2" }), ["111_2"]);
    assert.deepEqual(ids({ code: "ADT26001", page: A }), ["111_1"]);
    assert.deepEqual(ids({ kind: "reel" }), ["222_1"]);
    assert.deepEqual(ids({ noCode: true }), ["111_3"]);
    assert.equal(ids({}).length, 4);
  });

  it("đếm theo page (page không có bài vẫn ra 0) và theo mã", () => {
    const c = countByPage(posts, [A, B, "333"]);
    assert.deepEqual(c[0], { page_id: A, total: 3, video: 1, photo: 2, noCode: 1, lastDay: "2026-11-20" });
    assert.deepEqual(c[1], { page_id: B, total: 1, video: 1, photo: 0, noCode: 0, lastDay: "2026-11-21" });
    assert.deepEqual(c[2], { page_id: "333", total: 0, video: 0, photo: 0, noCode: 0, lastDay: null });
    assert.deepEqual(countByCode(posts), [
      { code: "ADT26001", posts: 2 },
      { code: "BD24066", posts: 1 },
      { code: "BD26011", posts: 1 },
    ]);
  });
});
