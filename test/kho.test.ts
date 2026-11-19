/** Tra đơn cho bàn đóng hàng: chọn đúng đơn theo mã kho quét và rút gọn sản phẩm. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checkKhoKey, shapeOrder } from "../src/lib/kho";

const info = (display_id: string, barcode: string, mau: string, size: string) => ({
  name: "Áo dài tay ADT25002",
  fields: [{ name: "MÀU", value: mau }, { name: "SIZE SỐ", value: size }],
  images: ["https://example.test/a.png"],
  display_id,
  barcode,
});

const shopee = {
  id: "261119N12G44SH",
  system_id: 500594,
  status: 1,
  status_name: "submitted",
  order_sources_name: "Shopee",
  partner: { extend_code: "SPXVN06486533980B", order_number_vtp: null },
  items: [
    { quantity: 1, components: null, variation_info: info("ADT25002TRANG170", "1893-10", "TRẮNG", "170") },
    { quantity: 2, components: null, variation_info: info("ADT25002TRANG170", "1893-10", "TRẮNG", "170") },
  ],
};
const vtp = {
  id: 500609,
  system_id: 500609,
  status: 6,
  status_name: "canceled",
  order_sources_name: "Facebook",
  partner: { extend_code: "PKE540445091144762", order_number_vtp: "PKE1576845310" },
  items: [{ quantity: 1, variation_info: info("BD26011XANHTHAN150", "", "XANH THAN", "150") }],
};

describe("shapeOrder", () => {
  it("khớp theo mã vận đơn, gộp dòng trùng phân loại", () => {
    const r = shapeOrder([vtp, shopee], "spxvn06486533980b");
    assert.equal(r.found, true);
    if (!r.found) return;
    assert.equal(r.order.id, "261119N12G44SH");
    assert.equal(r.order.status_name, "Đã xác nhận");
    assert.equal(r.order.cancelled, false);
    assert.deepEqual(r.items.map((i) => [i.display_id, i.barcode, i.detail, i.quantity]), [["ADT25002TRANG170", "1893-10", "TRẮNG · 170", 3]]);
  });
  it("khớp theo mã đơn sàn và mã Viettel Post, báo đơn hủy", () => {
    assert.equal(shapeOrder([shopee], "261119N12G44SH").found, true);
    const r = shapeOrder([shopee, vtp], "PKE1576845310");
    assert.equal(r.found && r.order.cancelled, true);
    assert.equal(r.found && r.order.source, "Facebook");
  });
  it("Pancake trả đơn gần đúng nhưng không khớp nguyên mã thì coi như không thấy", () => {
    assert.deepEqual(shapeOrder([shopee, vtp], "SPXVN0648653398"), { found: false });
    assert.deepEqual(shapeOrder([], "ABC"), { found: false });
  });
});

describe("checkKhoKey", () => {
  const req = (k?: string) => new Request("https://x.test/api/kho/don", { headers: k ? { "x-mk-key": k } : {} });
  it("chưa đặt khóa thì từ chối, sai khóa thì từ chối, đúng khóa thì cho", () => {
    delete process.env.KHO_API_KEY;
    assert.equal(checkKhoKey(req("abc")), "unset");
    process.env.KHO_API_KEY = "khoa-thu-nghiem";
    assert.equal(checkKhoKey(req()), "bad");
    assert.equal(checkKhoKey(req("khoa-thu-nghiex")), "bad");
    assert.equal(checkKhoKey(req("khoa-thu-nghiem")), "ok");
    delete process.env.KHO_API_KEY;
  });
});
