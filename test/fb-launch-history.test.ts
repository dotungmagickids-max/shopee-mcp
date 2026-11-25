/** FB Magic Tool, Lịch sử lên camp: dựng lại kết quả từ nhật ký lệnh ghi. Số và mã trong test là số giả. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { canRetry, resultsFromLog, runsFromLog, uncovered, type LogRow } from "../src/lib/facebook/launch-history";

let n = 0;
const at = (sec: number) => new Date(Date.UTC(2026, 10, 25, 1, 0, 0) + sec * 1000).toISOString();
const row = (sec: number, action: string, name: string, ok: boolean, target: string | null, after: Record<string, unknown> = {}, error: string | null = null): LogRow => ({
  id: ++n,
  created_at: at(sec),
  action,
  account_id: "111",
  target_id: target,
  target_name: name,
  ok,
  error,
  after,
});

describe("FB Magic Tool: lịch sử lên camp", () => {
  it("dựng lại 1-N-1: quảng cáo tạo được, lỗi nút nhắn tin, lỗi bài không còn", () => {
    n = 0;
    const rows = [
      row(0, "create_campaign", "TT-MGO-AA-01", true, "C1"),
      row(2, "create_adset", "TN-01", true, "S1", { campaign_id: "C1", promoted_object: JSON.stringify({ page_id: "9" }) }),
      row(4, "create_creative", "AA-P03", true, "K1", { object_story_id: "9_3" }),
      row(8, "create_ad", "AA-P03", false, null, { adset_id: "S1" }, "incompatible"),
      row(9, "create_creative", "AA-P03", false, null, { object_story_id: "9_3" }, "Something went wrong"),
      row(11, "create_adset", "TN-02", true, "S2", { campaign_id: "C1" }),
      row(12, "create_creative", "AA-P04", false, null, { object_story_id: "9_4" }, "post not available"),
      row(14, "create_adset", "TN-03", true, "S3", { campaign_id: "C1" }),
      row(15, "create_creative", "AA-P05", true, "K2", { object_story_id: "9_5" }),
      row(18, "create_ad", "AA-P05", false, null, { adset_id: "S3" }, "incompatible"),
      row(19, "create_creative", "AA-P05", true, "K3", { object_story_id: "9_5" }),
      row(21, "create_ad", "AA-P05", true, "A5", { adset_id: "S3" }),
    ];
    const { results, page_id } = resultsFromLog(rows);
    assert.equal(page_id, "9");
    assert.deepEqual(
      results.map((r) => [r.ad_name, r.post_id, r.campaign_id, r.adset_id, r.adset_name, r.ad_id, r.error]),
      [
        ["AA-P03", "9_3", "C1", "S1", "TN-01", null, "Something went wrong"],
        ["AA-P04", "9_4", "C1", "S2", "TN-02", null, "post not available"],
        ["AA-P05", "9_5", "C1", "S3", "TN-03", "A5", null],
      ]
    );
    assert.deepEqual(results.map(canRetry), [true, true, false]);
  });

  it("nhóm lỗi: một dòng cho nhóm, không biết bài, không tạo lại được", () => {
    n = 100;
    const { results } = resultsFromLog([
      row(0, "create_campaign", "TT-MG-GOM-01", true, "C9"),
      row(1, "create_adset", "TN-01", false, null, { campaign_id: "C9", promoted_object: JSON.stringify({ page_id: "7" }) }, "need access"),
    ]);
    assert.deepEqual(results.map((r) => [r.ad_name, r.campaign_id, r.adset_id, r.error]), [["(nhóm TN-01)", "C9", null, "need access"]]);
    assert.equal(canRetry(results[0]), false);
  });

  it("gom thành lần lên camp theo khoảng nghỉ; bỏ cụm chỉ có tạo lại; bỏ lệnh đã nằm trong lần đã lưu", () => {
    n = 200;
    const a = [row(0, "create_campaign", "X", true, "C1"), row(2, "create_adset", "S", true, "S1", { campaign_id: "C1" }), row(3, "create_creative", "P1", true, "K", { object_story_id: "9_1" }), row(4, "create_ad", "P1", true, "A1", { adset_id: "S1" })];
    const retry = [row(600, "create_creative", "P2", true, "K2", { object_story_id: "9_2" }), row(601, "create_ad", "P2", true, "A2", { adset_id: "S1" })];
    const b = [row(1200, "create_campaign", "Y", true, "C2"), row(1201, "create_adset", "S", true, "S2", { campaign_id: "C2" })];
    const runs = runsFromLog([...b, ...retry, ...a]);
    assert.deepEqual(runs.map((r) => r.key), [`${b[0].id}-${b[1].id}`, `${a[0].id}-${a[3].id}`]); // mới nhất trước, cụm tạo lại bị bỏ
    const left = uncovered([...a, ...b], [{ created_at: a[0].created_at, finished_at: a[3].created_at }]);
    assert.deepEqual(left.map((r) => r.id), b.map((r) => r.id));
  });
});
