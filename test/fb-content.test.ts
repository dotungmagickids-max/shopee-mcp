/** FB Magic Tool, màn Nội dung: khoảng ngày, loại bài, lọc theo page/mã, đếm theo page và theo mã. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fromPancakePost, isOffWall, pancakePageTokens, pickImage, vnRangeUnix } from "../src/lib/facebook/pancake-posts";
import { composioConfig, dayWindows, fromGraphPost, postsOf } from "../src/lib/facebook/composio-posts";
import { adsByPost, enrich, parseCodes } from "../src/lib/facebook/content";
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

  it("bài lấy qua Pancake: giờ UTC đổi sang ngày Việt Nam, loại bài, bỏ bài đã gỡ, ảnh nếu có", () => {
    const p = fromPancakePost({ id: "111_9", message: "Mã: ADT25002", type: "video", inserted_at: "2026-11-21T18:00:14", attachments: { data: [{ media: { image: { src: "https://example.test/v.jpg" } } }] } })!;
    const c = toContentPost("111", p);
    assert.equal(c.day, "2026-11-22");
    assert.equal(c.kind, "video");
    assert.deepEqual(c.codes, ["ADT25002"]);
    assert.equal(c.picture, "https://example.test/v.jpg");
    assert.equal(c.permalink, "https://www.facebook.com/111_9");
    assert.equal(fromPancakePost({ id: "111_8", type: "photo", message: "BD25056 về hàng", inserted_at: "2026-11-21T03:00:00" })!.picture, null);
    assert.equal(fromPancakePost({ id: "111_5", type: "photo", message: null, inserted_at: "2026-11-21T03:00:00" }), null); // ảnh con của album
    assert.equal(fromPancakePost({ id: "111_7", removed: true }), null);
    assert.equal(fromPancakePost({ id: "111_4", is_removed: true }), null);
    // Dạng thật của Pancake: ảnh bìa ở attachments.data[].url, link bài ở attachments.target.url.
    const real = fromPancakePost({
      id: "111_3", message: "Mã: BD25056", type: "video", inserted_at: "2026-11-23T13:00:00",
      attachments: { data: [{ image_data: { height: 1280, width: 720 }, type: "video_inline", url: "https://content.example.test/a/b.jpg" }], target: { id: "9", url: "https://www.facebook.com/reel/9/" } },
    })!;
    assert.equal(real.picture, "https://content.example.test/a/b.jpg");
    assert.equal(real.permalink, "https://www.facebook.com/reel/9/");
    assert.equal(toContentPost("111", real).kind, "reel");
    assert.equal(real.off_wall, false);
    // Video không nằm trên tường page (link /videos/): tách nhóm riêng, không đếm vào số bài đã đăng.
    const off = toContentPost("111", fromPancakePost({ id: "111_2", message: "Mã: QD25009", type: "video", inserted_at: "2026-11-08T19:31:39", attachments: { data: [], target: { url: "https://www.facebook.com/111/videos/2" } } })!);
    assert.equal(off.offWall, true);
    assert.equal(matches(off, {}), false);
    assert.equal(matches(off, { scope: "off" }), true);
    assert.equal(matches(toContentPost("111", real), { scope: "off" }), false);
    assert.equal(countByPage([off, toContentPost("111", real)].filter((p) => matches(p, {})), ["111"])[0].total, 1);
    assert.equal(isOffWall("photo", "https://www.facebook.com/111/videos/2"), false);
    // Bài ảnh ngoài tường: status_type "shared_story".
    assert.equal(fromPancakePost({ id: "111_12", message: "Quần nỉ", type: "photo", status_type: "shared_story", inserted_at: "2026-10-27T00:46:00" })!.off_wall, true);
    assert.equal(fromPancakePost({ id: "111_13", message: "Quần nỉ", type: "photo", status_type: "added_photos", inserted_at: "2026-10-27T00:46:00" })!.off_wall, false);
    assert.equal(pickImage({ attachments: { data: [], target: { url: "https://www.facebook.com/reel/9/" } } }), null);
    assert.equal(toContentPost("111", fromPancakePost({ id: "111_6", type: "livestream", inserted_at: "2026-11-21T03:00:00" })!).kind, "video");
    assert.equal(pickImage({ attachments: { data: [{ url: "https://example.test/clip.mp4" }] } }), null);
    assert.deepEqual(vnRangeUnix("2026-11-20", "2026-11-20"), { since: 1795107600, until: 1795193999 });
  });

  it("token Pancake từng page: đọc JSON, sai định dạng thì coi như chưa có", () => {
    assert.deepEqual([...pancakePageTokens('{"111":"abc","222":" def ","333":"","444":{"ten":"Page A","khoa":"ghi"}}')], [["111", "abc"], ["222", "def"], ["444", "ghi"]]);
    assert.equal(pancakePageTokens("không phải json").size, 0);
    assert.equal(pancakePageTokens(undefined).size, 0);
    assert.equal(pancakePageTokens("[1]").size, 0);
  });

  it("bài lấy qua Composio: cấu hình, chia khoảng ngày, gỡ lớp bọc câu trả lời, có ảnh đại diện", () => {
    assert.equal(composioConfig({}), null);
    assert.equal(composioConfig({ COMPOSIO_API_KEY: "k" }), null);
    assert.deepEqual(composioConfig({ COMPOSIO_API_KEY: " k ", COMPOSIO_FB_ACCOUNT: "acc" }), { key: "k", account: "acc", userId: null });
    assert.deepEqual(dayWindows("2026-11-20", "2026-11-23"), [{ since: "2026-11-20", until: "2026-11-23" }]);
    assert.deepEqual(dayWindows("2026-09-01", "2026-11-23"), [
      { since: "2026-10-25", until: "2026-11-23" },
      { since: "2026-09-25", until: "2026-10-24" },
      { since: "2026-09-01", until: "2026-09-24" },
    ]);
    assert.deepEqual(dayWindows("2026-11-22", "2026-11-23", 1), [
      { since: "2026-11-23", until: "2026-11-23" },
      { since: "2026-11-22", until: "2026-11-22" },
    ]);
    const row = { id: "111_5", message: "Mã: ADT25003", created_time: "2026-11-18T13:00:14+0000", full_picture: "https://example.test/p.jpg", permalink_url: "https://www.facebook.com/reel/1/", status_type: "added_video" };
    assert.equal(postsOf({ successful: true, data: { data: [row] } }).length, 1);
    assert.equal(postsOf({ data: { data: { data: [row] } } }).length, 1);
    assert.equal(postsOf({ data: {} }).length, 0);
    const c = toContentPost("111", fromGraphPost(row)!);
    assert.equal(c.picture, "https://example.test/p.jpg");
    assert.equal(c.kind, "reel");
    assert.equal(c.day, "2026-11-18");
    assert.deepEqual(c.codes, ["ADT25003"]);
    assert.equal(fromGraphPost({}), null);
  });

  it("bài đang chạy quảng cáo và mã gắn với bài: nhập tay > chữ trong bài > tên quảng cáo", () => {
    assert.deepEqual(parseCodes(" adt26001, BD26011 ; adt26001 abc 12345"), ["ADT26001", "BD26011"]);
    assert.deepEqual(parseCodes(""), []);
    const ads = adsByPost(
      [
        { ad_id: "a1", ad_name: "QD25009-P01-V01" },
        { ad_id: "a2", ad_name: "QD25009-P01-V02" },
        { ad_id: "a3", ad_name: "BD26011.BD24066-P02-V01" },
        { ad_id: "a4", ad_name: "khong ro bai" },
      ],
      new Map([
        ["a1", { story_id: "111_3", status: "ACTIVE" }],
        ["a2", { story_id: "111_3", status: "PAUSED" }],
        ["a3", { story_id: "111_1", status: "CAMPAIGN_PAUSED" }],
        ["a4", { story_id: null, status: "ACTIVE" }],
      ])
    );
    assert.deepEqual(ads.get("111_3"), { running: 1, total: 2, names: ["QD25009-P01-V01", "QD25009-P01-V02"] });
    assert.equal(ads.get("111_1")!.running, 0);
    assert.equal(ads.size, 2);
    const out = enrich(posts, ads, new Map([["111_2", ["AO26004"]], ["222_1", []]]));
    const by = (id: string) => out.find((p) => p.id === id)!;
    assert.deepEqual([by("111_3").codes, by("111_3").codeSource, by("111_3").ads?.running], [["QD25009"], "ads", 1]); // bài không ghi mã: lấy từ tên QC
    assert.deepEqual([by("111_1").codes, by("111_1").codeSource], [["ADT26001"], "text"]); // chữ trong bài thắng tên QC
    assert.deepEqual([by("111_2").codes, by("111_2").codeSource], [["AO26004"], "manual"]); // nhập tay thắng tất cả
    assert.deepEqual([by("222_1").codes, by("222_1").codeSource, by("222_1").ads], [["ADT26001"], "text", null]); // dòng nhập tay rỗng: giữ mã đọc được
  });
});
