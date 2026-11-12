/** Nhân viên Shopee giai đoạn A: phân loại đánh giá, câu trả lời soạn sẵn, chỉ số sức khỏe shop. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { healthIssues, lowReply, reviewTopic, thankReply, toUnix, type Metric } from "../src/lib/autopilot/care";

describe("phân loại đánh giá xấu", () => {
  it("nhận ra size, chất lượng, giao hàng", () => {
    assert.equal(reviewTopic("Áo chật quá bé mặc không vừa"), "size");
    assert.equal(reviewTopic("Vải xù lông sau 1 lần giặt"), "chat_luong");
    assert.equal(reviewTopic("Giao thiếu 1 quần"), "giao_hang");
    assert.equal(reviewTopic("bình thường"), "khac");
    assert.equal(reviewTopic(""), "khac");
  });
  it("câu trả lời lịch sự, mời nhắn shop, không hứa hoàn tiền", () => {
    for (const t of ["size", "chat_luong", "giao_hang", "khac"] as const) {
      const r = lowReply(t);
      assert.match(r, /Magickids/);
      assert.match(r, /nhắn tin cho shop/);
      assert.doesNotMatch(r, /hoàn tiền/);
      assert.ok(r.length <= 500);
    }
    assert.match(lowReply("size"), /đổi size/);
  });
  it("lời cảm ơn xoay vòng, ổn định theo mã đánh giá", () => {
    assert.equal(thankReply("117745913768"), thankReply(117745913768));
    const set = new Set(["1", "2", "3", "4"].map(thankReply));
    assert.equal(set.size, 4);
  });
});

describe("sức khỏe shop", () => {
  const m = (metric_name: string, v: number | null, value: number, comparator: string, unit = 2): Metric => ({
    metric_id: 0,
    metric_name,
    current_period: v,
    unit,
    target: { value, comparator },
  });
  it("vượt ngưỡng, sát ngưỡng, bình thường", () => {
    const r = healthIssues([
      m("late_shipment_rate", 12, 10, "<"), // vượt
      m("non_fulfillment_rate", 8, 10, "<"), // sát (≥ 70%)
      m("cancellation_rate", 1, 5, "<"), // ổn
      m("shop_rating", 4.1, 4, ">=", 1), // sát
      m("response_rate", 99, 80, ">="), // ổn
      m("severe_listing_violations", null, 0, "<=", 1), // không có số
      m("chi_so_la", 99, 1, "<"), // không theo dõi
    ]);
    assert.deepEqual(
      r.map((i) => [i.name, i.level]),
      [
        ["Tỉ lệ giao trễ", "vuot"],
        ["Tỉ lệ đơn không thành công", "sat"],
        ["Đánh giá shop", "sat"],
      ]
    );
    assert.equal(r[0].target, "< 10%");
  });
  it("số liệu thật Magickids 12/11 không có cảnh báo", () => {
    const r = healthIssues([
      m("late_shipment_rate", 0.66, 10, "<"),
      m("non_fulfillment_rate", 0.3, 10, "<"),
      m("preparation_time", 0.51, 1.5, "<", 4),
      m("response_rate", 99.17, 80, ">="),
      m("shop_rating", 4.91, 4, ">=", 1),
    ]);
    assert.equal(r.length, 0);
  });
});

describe("thời gian Shopee", () => {
  it("đọc ISO, giây, mili giây", () => {
    assert.equal(toUnix("2026-11-10T16:59:59.000Z"), 1794329999);
    assert.equal(toUnix(1794329999), 1794329999);
    assert.equal(toUnix(1794329999000), 1794329999);
    assert.equal(toUnix(null), 0);
  });
});
