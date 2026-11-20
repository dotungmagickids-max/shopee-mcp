/** Tra đơn cho bàn đóng hàng: chọn đúng đơn theo mã kho quét và rút gọn sản phẩm. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { altSkus, applyShopeeStock, arrangeBody, blockReason, carrierGroup, checkKhoKey, endOfTodayVN, exchangeKind, guessSku, labelGroups, shapeOrder, shapePancakeXuat, shapeShopeeXuat } from "../src/lib/kho";

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

describe("Shopee chỉ chuẩn bị đơn có hàng", () => {
  const mk = (id: string, shipBy: number, sku: string, quantity: number) => ({ id, channel: "Shopee" as const, shop: "Magickids", carrier: "SPX Express", group: "SPX", urgent: false, shipBy, created: 1, eligible: true, reason: "", items: [{ sku, product: "QD26036", name: "", detail: "", quantity, image: "" }] });
  it("chia tồn cho đơn hạn sớm trước, đơn sau thiếu thì tách ra; mã không có tồn thì không chặn", () => {
    const late = mk("B", 200, "QD26036DEN150", 2);
    const early = mk("A", 100, "QD26036DEN150", 2);
    const pre = mk("C", 50, "QD26099DEN150", 1); // hàng đặt trước, tồn 0
    const unknown = mk("D", 300, "KHONGCOTRENPANCAKE", 1);
    applyShopeeStock([late, early, pre, unknown], new Map([["QD26036DEN150", 3], ["QD26099DEN150", 0]]));
    assert.equal(early.eligible, true);
    assert.equal(late.eligible, false);
    assert.match(late.reason, /cần 2, còn 1/);
    assert.equal(pre.eligible, false);
    assert.equal(unknown.eligible, true);
  });
});

describe("đơn Shopee không có mã phân loại", () => {
  it("ghép mã sản phẩm + màu + size", () => {
    assert.equal(guessSku("ADT26001", "Đỏ,150"), "ADT26001DO150");
    assert.equal(guessSku("ADT26001 ", "Xanh than,140"), "ADT26001XANHTHAN140");
    assert.equal(guessSku("", "Đỏ,150"), "");
    const r = shapeShopeeXuat({ order_sn: "X", item_list: [{ item_sku: "ADT26001", model_sku: "", model_name: "Trắng,130", model_quantity_purchased: 1 }] }, "Magickids", Date.now());
    assert.deepEqual([r.items[0].sku, r.items[0].product], ["ADT26001TRANG130", "ADT26001"]);
  });
  it("màu Shopee Xanh dương = mã Pancake XANHBIEN", () => assert.deepEqual(altSkus("ADT26001XANHDUONG150"), ["ADT26001XANHBIEN150"]));
});

describe("tem vận đơn và chuẩn bị hàng Shopee", () => {
  const mk = (id: string, shipBy: number, arranged: boolean) => ({ id, channel: "Shopee" as const, shop: "Magickids", carrier: "SPX Express", group: "SPX", urgent: false, shipBy, created: 1, eligible: true, reason: "", arranged, items: [{ sku: "QD26036DEN150", product: "QD26036", name: "", detail: "", quantity: 1, image: "" }] });
  it("đơn đã chuẩn bị hàng được chia tồn trước và không bị chặn", () => {
    const early = mk("A", 100, false);
    const arranged = mk("B", 900, true);
    const arranged2 = mk("C", 950, true);
    applyShopeeStock([early, arranged, arranged2], new Map([["QD26036DEN150", 1]]));
    assert.equal(arranged.eligible, true);
    assert.equal(arranged2.eligible, true);
    assert.equal(early.eligible, false);
    assert.equal(shapeShopeeXuat({ order_sn: "X", order_status: "PROCESSED", item_list: [] }, "Magickids", 0).arranged, true);
    assert.equal(shapeShopeeXuat({ order_sn: "X", order_status: "READY_TO_SHIP", item_list: [] }, "Magickids", 0).arranged, false);
  });
  it("gom tem theo loại tem và hãng", () => {
    assert.deepEqual(
      labelGroups([
        { id: "A", type: "THERMAL_AIR_WAYBILL", carrier: "SPX Express" },
        { id: "B", type: "THERMAL_AIR_WAYBILL", carrier: "Giao Hàng Nhanh" },
        { id: "C", type: "THERMAL_AIR_WAYBILL", carrier: "SPX Express" },
      ]).map((g) => [g.carrier, g.orders]),
      [["SPX Express", ["A", "C"]], ["Giao Hàng Nhanh", ["B"]]]
    );
  });
  it("chọn địa chỉ lấy hàng mặc định và khung giờ sớm nhất; thiếu thông tin thì không tự làm", () => {
    const param = {
      info_needed: { pickup: ["address_id", "pickup_time_id"] },
      pickup: {
        address_list: [
          { address_id: 1, address_flag: ["return_address"], time_slot_list: [{ date: 5, pickup_time_id: "x" }] },
          { address_id: 2, address_flag: ["default_address", "pickup_address"], time_slot_list: [{ date: 300, pickup_time_id: "late" }, { date: 200, pickup_time_id: "soon" }] },
          { address_id: 3, address_flag: ["pickup_address"], time_slot_list: [] },
        ],
      },
    };
    assert.deepEqual(arrangeBody("SN1", param, "pickup"), { order_sn: "SN1", pickup: { address_id: 2, pickup_time_id: "soon" } });
    assert.equal(typeof arrangeBody("SN1", param, "dropoff"), "string");
    assert.deepEqual(arrangeBody("SN1", { info_needed: { dropoff: [] } }, "dropoff"), { order_sn: "SN1", dropoff: {} });
    assert.match(arrangeBody("SN1", { info_needed: { dropoff: ["branch_id"] } }, "dropoff") as string, /branch_id/);
    assert.match(arrangeBody("SN1", { info_needed: { pickup: ["address_id", "pickup_time_id"] }, pickup: { address_list: [] } }, "pickup") as string, /khung giờ/);
    assert.match(arrangeBody("SN1", { info_needed: { non_integrated: [] } }, "pickup") as string, /không có hình thức/);
  });
});

describe("đơn đổi hàng đi Viettel Post", () => {
  it("nhận các cách sale ghi đơn đổi, kể cả gõ sai dấu", () => {
    for (const note of ["đơn đổi cầm 1 quần về", "Đơn đổi cầm 2 sp về", "đơn đổi , cầm 1 quần về", "đơn đổi cầm 1 bộ vè", "Đơn đổi 1 bộ về", "báo kho chek kỹ màu - đơn đổi cầm 1 áo về", "ship cầm hàng cũ về giúp shop", "thu hồi 1 áo"])
      assert.equal(exchangeKind({ note }).kind, "doi", note);
    assert.equal(exchangeKind({ note: "", note_print: "đơn đổi càm 2 áo về" }).kind, "doi");
  });
  it("đơn thường không bị nhận nhầm; nhắc đổi mà không rõ thì xếp nghi ngờ", () => {
    for (const note of ["", "gọi trước khi giao", "giao giờ hành chính", "khách đi vắng buổi sáng", "hàng dễ vỡ, nhẹ tay", "khách về quê 25/11 mới nhận"]) assert.equal(exchangeKind({ note }).kind, "", note);
    assert.equal(exchangeKind({ note: "khách muốn đổi nếu không vừa" }).kind, "nghi");
    // "đợi" không phải "đổi" (lỗi thấy trên đơn thật 20/11/2026)
    for (const note of ["đợi chốt", "Đợi hàng về rồi gửi", "đơn đợi khách chuyển khoản", "ĐỢI CHỐT "]) assert.equal(exchangeKind({ note }).kind, "", note);
  });
  it("đơn Facebook mang nhãn đơn đổi, đơn TikTok thì không", () => {
    const o = { id: 1, status: 1, order_sources_name: "Facebook", note: "đơn đổi cầm 1 quần về", partner: {}, items: [] };
    const r = shapePancakeXuat(o, null)!;
    assert.deepEqual([r.exchange, r.exchangeNote, r.eligible], ["doi", "đơn đổi cầm 1 quần về", true]);
    assert.equal(shapePancakeXuat({ ...o, note: "" }, null)!.exchange, undefined);
    assert.equal(shapePancakeXuat({ ...o, order_sources_name: "Tiktok" }, null)!.exchange, undefined);
  });
});
