/** "Sai vì…": câu hỏi sau khi anh bỏ qua đề xuất. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { whyQuestion } from "../src/lib/feedback";

describe("Sai vì…", () => {
  it("câu hỏi nêu đề xuất bị bỏ qua, nhắc trả lời tin, chống chèn HTML", () => {
    const q = whyQuestion("tắt quảng cáo <ADT25002-P01-A01> (BOSS TUYỀN 2)");
    assert.match(q, /Anh vừa bỏ qua/);
    assert.match(q, /&lt;ADT25002-P01-A01&gt;/);
    assert.match(q, /trả lời tin này/);
  });
  it("tóm tắt quá dài bị cắt", () => {
    assert.ok(whyQuestion("x".repeat(2000)).length < 700);
  });
});
