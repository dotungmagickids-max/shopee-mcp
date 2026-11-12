/** Giá vốn: đơn Shopee thiếu SKU phân loại hoặc SKU dính khoảng trắng vẫn ra giá vốn. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { costOf } from "../src/lib/autopilot/pancake";

const map = new Map<string, number>([
  ["BD26011GHI150", 125000],
  ["ADT26001DO150", 85000],
  ["ADT26001", 83000], // nhập tay theo mã sản phẩm
  ["ADT26002", 60000],
]);

describe("costOf", () => {
  it("SKU dính xuống dòng vẫn khớp", () => assert.equal(costOf(map, { model_sku: "BD26011GHI150\n" }), 125000));
  it("đúng SKU phân loại thì lấy giá biến thể", () => assert.equal(costOf(map, { model_sku: "ADT26001DO150", item_sku: "ADT26001" }), 85000));
  it("thiếu SKU phân loại thì lấy theo SKU sản phẩm", () => assert.equal(costOf(map, { model_sku: "", item_sku: "ADT26001" }), 83000));
  it("biến thể chưa có giá thì lấy theo mã sản phẩm", () => assert.equal(costOf(map, { model_sku: "ADT26002DO150", item_sku: "" }), 60000));
  it("không có gì thì null", () => assert.equal(costOf(map, { model_sku: "", item_sku: "" }), null));
});
