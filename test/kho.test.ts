/** Tra đơn cho bàn đóng hàng: chọn đúng đơn theo mã kho quét và rút gọn sản phẩm. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { altSkus, applyPushedStock, applyShopeeStock, arrangeBody, blockReason, carrierGroup, checkKhoKey, endOfTodayVN, exchangeKind, guessSku, labelGroups, mergeVtpReturns, shapeOrder, reportAgeDays, shapeGiao, shapePancakeReturn, shapePancakeXuat, shapeShopeeReturn, shapeShopeeXuat, shapeVtpMail, vtpMailDoc, vtpWaitingPickup } from "../src/lib/kho";

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
    assert.equal(shapePancakeXuat(fb({ status: 2, partner: { partner_name: "VTP", picked_up_at: "2026-11-20T03:00:00" } }), null), null);
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

describe("kiện hoàn đang chờ về", () => {
  const ret = { return_sn: "2611190ABC", order_sn: "261110XYZ12345", status: "ACCEPTED", needs_logistics: true, tracking_number: "spxvn061234567890", reason: "DIFFERENT_DESCRIPTION", refund_amount: 149000, create_time: 1795000000, return_seller_due_date: 1795500000, item: [{ name: "Áo ADT25002", variation_sku: "ADT25002TRANG150", amount: 2 }] };
  it("yêu cầu trả hàng Shopee: lấy đủ ba mã để khớp video, bỏ yêu cầu chỉ hoàn tiền hoặc đã hủy", () => {
    const r = shapeShopeeReturn(ret, "Magickids")!;
    assert.deepEqual([r.key, r.kind, r.id, r.status, r.reason, r.refund], ["S:2611190ABC", "tra-hang", "261110XYZ12345", "Đã chấp nhận trả hàng", "Khác mô tả", 149000]);
    assert.deepEqual(r.codes, ["SPXVN061234567890", "261110XYZ12345", "2611190ABC"]);
    assert.deepEqual(r.items, [{ sku: "ADT25002TRANG150", name: "Áo ADT25002", detail: "", quantity: 2 }]);
    assert.equal(r.since, 1795000000000);
    assert.equal(shapeShopeeReturn({ ...ret, reassessed_request_reason: "NONE" }, "Magickids")!.reason, "Khác mô tả");
    assert.equal(shapeShopeeReturn({ ...ret, reassessed_request_reason: "WRONG_SIZE" }, "Magickids")!.reason, "Sai size");
    assert.equal(shapeShopeeReturn({ ...ret, needs_logistics: false }, "Magickids"), null);
    assert.equal(shapeShopeeReturn({ ...ret, status: "CANCELLED" }, "Magickids"), null);
    assert.deepEqual(shapeShopeeReturn({ ...ret, tracking_number: "" }, "Magickids")!.codes, ["261110XYZ12345", "2611190ABC"]);
  });
  it("đơn Viettel Post đang hoàn trên Pancake; bỏ đơn Shopee và đơn không ở trạng thái hoàn", () => {
    const o = { id: 500156, status: 4, order_sources_name: "Facebook", inserted_at: "2026-11-16T07:14:16", partner: { extend_code: "PKE540445091971802", order_number_vtp: "PKE1577718696", first_undeliverable_at: "2026-11-18T07:42:14", extend_update: [{ status: "Giao cho Bưu tá đi nhận", updated_at: "2026-11-17T01:00:00" }, { status: "Đang chuyển hoàn", updated_at: "2026-11-19T01:00:00" }] }, items: [{ quantity: 1, variation_info: { name: "QD26002", display_id: "QD26002DEN160", fields: [{ value: "ĐEN" }, { value: "160" }] } }] };
    const r = shapePancakeReturn(o)!;
    assert.deepEqual([r.key, r.kind, r.channel, r.status], ["P:500156", "giao-that-bai", "Facebook", "Đang chuyển hoàn"]);
    assert.deepEqual(r.codes, ["500156", "PKE540445091971802", "PKE1577718696"]);
    assert.deepEqual(r.items, [{ sku: "QD26002DEN160", name: "QD26002", detail: "ĐEN · 160", quantity: 1 }]);
    assert.equal(shapePancakeReturn({ ...o, status: 15 })!.kind, "hoan-mot-phan");
    assert.equal(shapePancakeReturn({ ...o, order_sources_name: "Shopee" }), null);
    assert.equal(shapePancakeReturn({ ...o, status: 2 }), null);
  });
  it("đơn hoàn Viettel theo báo cáo mail: ghép sản phẩm từ Pancake, giữ ngày thấy đầu tiên", () => {
    const o = { id: 500156, status: 4, order_sources_name: "Facebook", partner: { extend_code: "PKE540445091971802", order_number_vtp: "PKE1577718696" }, items: [{ quantity: 2, variation_info: { name: "QD26002", display_id: "QD26002DEN160", fields: [{ value: "ĐEN" }, { value: "160" }] } }] };
    const row = { ma: "PKE1577718696", status: "Đang chuyển hoàn", reason: "Không có nhu cầu nhận hàng" };
    const d = vtpMailDoc(row, "2026-11-19", undefined, [{ id: 1, partner: {} }, o], 1000);
    assert.deepEqual([d.id, d.channel, d.kind, d.first, d.ngay], ["500156", "Facebook", "giao-that-bai", 1000, "2026-11-19"]);
    const r = shapeVtpMail(row.ma, d);
    assert.deepEqual([r.key, r.shop, r.status, r.reason, r.since], ["P:500156", "Viettel Post", "Đang chuyển hoàn", "Không có nhu cầu nhận hàng", 1000]);
    assert.deepEqual(r.codes, ["PKE1577718696", "500156", "PKE540445091971802"]);
    assert.deepEqual(r.items, [{ sku: "QD26002DEN160", name: "QD26002", detail: "ĐEN · 160", quantity: 2 }]);
    // Hôm sau đổi trạng thái: giữ ngày đầu và sản phẩm, không cần tra lại Pancake.
    const d2 = vtpMailDoc({ ...row, status: "Đã trả", reason: "" }, "2026-11-20", d, null, 9000);
    assert.deepEqual([d2.status, d2.reason, d2.first, d2.ngay, d2.items?.length], ["Đã trả", "Không có nhu cầu nhận hàng", 1000, "2026-11-20", 1]);
    // Không tìm thấy đơn trên Pancake: vẫn có trong danh sách theo mã Viettel.
    const r3 = shapeVtpMail("PKE1", vtpMailDoc({ ma: "PKE1", status: "", reason: "" }, "2026-11-20", undefined, [], 5));
    assert.deepEqual([r3.key, r3.id, r3.status, r3.items.length], ["VTP:PKE1", "PKE1", "Đang hoàn", 0]);
    assert.equal(vtpMailDoc(row, "2026-11-19", undefined, [{ ...o, status: 15 }], 1).kind, "hoan-mot-phan");
    // Đơn giao có vấn đề: chỉ mã phân loại và số lượng, không tên sản phẩm; "con" = còn trong báo cáo mới nhất.
    const g = shapeGiao(row.ma, d, "2026-11-19");
    assert.equal(g.con, true);
    assert.equal(g.since, 1000);
    assert.ok(g.items.every((i) => Object.keys(i).sort().join() === "quantity,sku"));
    assert.equal(shapeGiao(row.ma, d, "2026-11-20").con, false);
    // Đơn rời danh sách: có trong danh sách hoàn là hoàn, không có là đã giao được. Đơn còn trong danh sách thì chưa có kết quả.
    assert.equal(shapeGiao(row.ma, d, "2026-11-20").kq, "giao");
    assert.equal(shapeGiao(row.ma, d, "2026-11-20", true).kq, "hoan");
    assert.equal(shapeGiao(row.ma, d, "2026-11-19", true).kq, undefined);
    assert.deepEqual(shapeGiao("PKE1", { status: "", reason: "", ngay: "2026-11-20", first: 0 }, "2026-11-20"), { ma: "PKE1", id: "", channel: "Viettel Post", status: "", reason: "", items: [], since: null, ngay: "2026-11-20", con: true });
  });
  it("hoàn Viettel: mail + đơn hoàn một phần của Pancake, không lấy đơn đang hoàn của Pancake, không trùng", () => {
    const row = (key: string, kind: string, codes: string[]) => ({ key, kind, codes }) as any;
    const mail = [row("P:1", "giao-that-bai", ["PKE1", "1"]), row("VTP:PKE9", "giao-that-bai", ["PKE9"])];
    const out = mergeVtpReturns(mail, [row("P:1", "hoan-mot-phan", ["1", "PKE1"]), row("P:2", "hoan-mot-phan", ["2", "PKE2"]), row("P:3", "giao-that-bai", ["3", "PKE3"]), row("P:4", "hoan-mot-phan", ["4", "PKE9"])]);
    assert.deepEqual(out.map((r) => r.key), ["P:1", "VTP:PKE9", "P:2"]);
    assert.equal(out[0].kind, "giao-that-bai");
  });
  it("tuổi của báo cáo mail tính theo ngày Việt Nam", () => {
    assert.equal(reportAgeDays("2026-11-19", Date.parse("2026-11-20T00:30:00Z")), 1);
    assert.equal(reportAgeDays("2026-11-19", Date.parse("2026-11-21T18:00:00Z")), 3);
  });
});

describe("đơn Viettel Post đã gửi hàng, chờ bưu tá lấy", () => {
  const o = { id: 500742, status: 2, order_sources_name: "Facebook", inserted_at: "2026-11-19T15:32:40", note: "khách hẹn giao sau 25/11", partner: { partner_name: "VTP", partner_status: "request_received", picked_up_at: null, service_partner: { ORDER_SERVICE: "VSL7", ORDER_SERVICE_ADD: null } }, items: [{ quantity: 1, variation_info: { name: "QD26002", display_id: "QD26002DEN160", fields: [{ value: "ĐEN" }, { value: "160" }] } }] };
  it("vào danh sách cần đóng, đánh dấu đã chuẩn bị, không còn xét ghi chú hay tồn", () => {
    const r = shapePancakeXuat(o, new Map([["QD26002DEN160", 0]]))!;
    assert.deepEqual([r.id, r.channel, r.group, r.arranged, r.eligible, r.reason], ["500742", "Facebook", "Viettel Post", true, true, ""]);
    assert.equal(r.exchange, undefined);
  });
  it("bưu tá đã nhận hoặc không phải Viettel Post thì bỏ", () => {
    assert.equal(shapePancakeXuat({ ...o, partner: { ...o.partner, picked_up_at: "2026-11-20T03:00:00" } }, null), null);
    assert.equal(shapePancakeXuat({ ...o, partner: { ...o.partner, partner_status: "on_the_way" } }, null), null);
    assert.equal(shapePancakeXuat({ ...o, partner: { ...o.partner, partner_name: "GHTK" } }, null), null);
    assert.equal(vtpWaitingPickup({ partner: { partner_name: "VTP", partner_status: "picking_up" } }), true);
    assert.equal(vtpWaitingPickup({}), false);
  });
  it("đơn đã chọn GGDH là đơn đổi chắc chắn", () => {
    const r = shapePancakeXuat({ ...o, note: "", partner: { ...o.partner, service_partner: { ORDER_SERVICE_ADD: "GGDH" } } }, null)!;
    assert.deepEqual([r.exchange, r.arranged], ["doi", true]);
  });
});

describe("đơn Viettel Post đã gửi hàng chỉ vào đợt đóng khi có hàng", () => {
  const sp = (id: string, shipBy: number, sku: string, q: number, arranged = false) => ({ id, channel: "Shopee" as const, shop: "Magickids", carrier: "SPX", group: "SPX", urgent: false, shipBy, created: 1, eligible: true, reason: "", arranged, items: [{ sku, product: "ADT26001", name: "", detail: "", quantity: q, image: "" }] });
  const fb = (id: string, created: number, sku: string, q: number, arranged = true) => ({ id, channel: "Facebook" as const, shop: "Facebook", carrier: "VTP", group: "Viettel Post", urgent: false, shipBy: null, created, eligible: true, reason: "", ...(arranged ? { arranged: true } : {}), items: [{ sku, product: "ADT26001", name: "", detail: "", quantity: q, image: "" }] });
  it("Shopee được chia trước, Viettel Post nhận phần còn lại theo đơn tạo trước", () => {
    const s1 = sp("S1", 100, "ADT26001DO140", 3);
    const f1 = fb("F1", 10, "ADT26001DO140", 2);
    const f2 = fb("F2", 20, "ADT26001DO140", 1);
    const f3 = fb("F3", 5, "ADT26001DO130", 1);
    const f4 = fb("F4", 30, "MAKHONGCOTON", 1);
    const waiting = fb("F5", 1, "ADT26001DO130", 1, false);
    applyPushedStock([f2, f1, f3, f4, waiting], applyShopeeStock([s1], new Map([["ADT26001DO140", 5], ["ADT26001DO130", 0]])));
    assert.equal(s1.eligible, true);
    assert.equal(f1.eligible, true);
    assert.equal(f2.eligible, false);
    assert.match(f2.reason, /Đã gửi hàng nhưng chưa có hàng.*cần 1, còn 0/);
    assert.equal(f3.eligible, false);
    assert.equal(f4.eligible, true);
    assert.equal(waiting.eligible, true); // đơn chưa đẩy không thuộc phần chia này
  });
});

describe("tồn Pancake cho trang Quản lý kho", () => {
  it("trả mã hàng và số cái đơn đang chờ, không có giá", async () => {
    const { stockRow } = await import("../src/lib/kho");
    const v = {
      retail_price: 169000,
      last_imported_price: 67000,
      product: { name: "Quần gió QD26036", display_id: "qd26036" },
      variations_warehouses: [{ actual_remain_quantity: 0, waiting_quantity: 2 }, { actual_remain_quantity: 5, waiting_quantity: 1 }],
    };
    assert.deepEqual(stockRow("QD26036DEN140", 5, v), ["QD26036DEN140", 5, "Quần gió QD26036", "QD26036", 3]);
    assert.deepEqual(stockRow("X", NaN, {}), ["X", 0, "", "", 0]);
  });
  it("ảnh đại diện: ảnh phân loại trước, rồi ảnh sản phẩm; bỏ đường dẫn không phải https", async () => {
    const { variationImage } = await import("../src/lib/kho");
    assert.equal(variationImage({ images: ["https://a.test/1.jpg"], product: { image: "https://a.test/p.jpg" } }), "https://a.test/1.jpg");
    assert.equal(variationImage({ images: [], product: { image: "https://a.test/p.jpg" } }), "https://a.test/p.jpg");
    assert.equal(variationImage({ images: ["javascript:alert(1)", null], product: { image: null } }), "");
    assert.equal(variationImage({}), "");
  });
});
