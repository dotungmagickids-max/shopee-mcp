/** Tra đơn cho bàn đóng hàng: chọn đúng đơn theo mã kho quét và rút gọn sản phẩm. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { blockReason, carrierGroup, checkKhoKey, endOfTodayVN, shapeOrder, shapePancakeXuat, shapeShopeeXuat } from "../src/lib/kho";

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

describe("đơn cần đóng", () => {
  const now = Date.parse("2026-11-20T03:00:00Z"); // 10h sáng 20/11 giờ VN
  it("phân nhóm hãng vận chuyển", () => {
    assert.equal(carrierGroup("SPX Express"), "SPX");
    assert.equal(carrierGroup("SPX Instant"), "Hỏa tốc");
    assert.equal(carrierGroup("Hỏa Tốc - Trong Ngày"), "Hỏa tốc");
    assert.equal(carrierGroup("Giao Hàng Nhanh"), "GHN");
    assert.equal(carrierGroup("VTP"), "Viettel Post");
    assert.equal(carrierGroup(""), "Chưa rõ");
  });
  it("cuối ngày theo giờ Việt Nam", () => assert.equal(new Date(endOfTodayVN(now)).toISOString(), "2026-11-20T16:59:59.999Z"));
  it("đơn Shopee: gấp khi hạn giao trong hôm nay hoặc đã quá hạn", () => {
    const o = {
      order_sn: "261120QFJR0RJD",
      shipping_carrier: "SPX Express",
      ship_by_date: "2026-11-20T16:59:59.000Z",
      create_time: 1795107809,
      item_list: [{ item_sku: "ADT25003", model_sku: "ADT25003XANHTHAN180", item_name: "Áo", model_name: "Xanh than,180", model_quantity_purchased: 2, image_info: { image_url: "https://x.test/a" } }],
    };
    const r = shapeShopeeXuat(o, "Magickids", now);
    assert.deepEqual([r.id, r.channel, r.group, r.urgent, r.eligible], ["261120QFJR0RJD", "Shopee", "SPX", true, true]);
    assert.deepEqual(r.items, [{ sku: "ADT25003XANHTHAN180", product: "ADT25003", name: "Áo", detail: "Xanh than,180", quantity: 2, image: "https://x.test/a" }]);
    assert.equal(shapeShopeeXuat({ ...o, ship_by_date: 1795300000 }, "Magickids", now).urgent, false);
  });
  const fb = (extra: object) => ({
    id: 500609,
    status: 1,
    order_sources_name: "Facebook",
    inserted_at: "2026-11-19T00:41:29.248796",
    partner: { partner_name: "VTP" },
    items: [{ quantity: 2, variation_info: { name: "BD26011", display_id: "BD26011XANHTHAN150", product_display_id: "BD26011", fields: [{ value: "XANH THAN" }, { value: "150" }], images: [] } }],
    ...extra,
  });
  it("đơn Facebook: đủ điều kiện, vướng ghi chú, thiếu hàng", () => {
    const ok = shapePancakeXuat(fb({}), new Map([["BD26011XANHTHAN150", 5]]))!;
    assert.deepEqual([ok.id, ok.channel, ok.group, ok.eligible], ["500609", "Facebook", "Viettel Post", true]);
    assert.equal(ok.items[0].product, "BD26011");
    assert.equal(shapePancakeXuat(fb({ note: "Khách hẹn giao sau 25/11" }), null)!.eligible, false);
    assert.match(shapePancakeXuat(fb({ note: "chưa chốt màu" }), null)!.reason, /Ghi chú/);
    const short = shapePancakeXuat(fb({}), new Map([["BD26011XANHTHAN150", 1]]))!;
    assert.equal(short.eligible, false);
    assert.match(short.reason, /cần 2, tồn thực 1/);
    assert.equal(blockReason(fb({ tags: [{ name: "Nợ hàng" }] })), "Thẻ: Nợ hàng");
    assert.equal(blockReason(fb({ note: "gọi trước khi giao" })), "");
  });
  it("bỏ đơn Shopee trên Pancake, đơn Facebook đã gửi; nhận đơn TikTok đang đóng", () => {
    assert.equal(shapePancakeXuat(fb({ order_sources_name: "Shopee" }), null), null);
    assert.equal(shapePancakeXuat(fb({ status: 2 }), null), null);
    assert.equal(shapePancakeXuat(fb({ status: 8 }), null), null);
    const tt = shapePancakeXuat(fb({ order_sources_name: "Tiktok", status: 8, id: "587263114848929710", note: "giao sau" }), null)!;
    assert.deepEqual([tt.channel, tt.group, tt.eligible], ["TikTok", "TikTok", true]);
  });
});
