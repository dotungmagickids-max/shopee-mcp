/** Dữ liệu vận hành của kho trên Supabase: lọc mã, ghi chú, dòng sổ video. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { cacheFresh, cleanCodes, cleanMark, cleanNote, nhapEntry, cleanVtpRows, validDay, validKey, videoRow } from "../src/lib/kho-store";

describe("kho-store", () => {
  it("lọc mã đơn: viết hoa, bỏ khoảng trắng, bỏ trùng và thứ không phải mã", () => {
    assert.deepEqual(cleanCodes([" pke1576832568 ", "PKE1576832568", "261120RU4M8WST", 500742, "ab", "tên khách", null, "SPXVN06 141430053B"]), ["PKE1576832568", "261120RU4M8WST", "500742", "SPXVN06141430053B"]);
    assert.deepEqual(cleanCodes("PKE123"), []);
    assert.equal(cleanCodes(Array.from({ length: 50 }, (_, i) => `MA${1000 + i}`), 10).length, 10);
  });
  it("ngày và khóa hợp lệ", () => {
    assert.equal(validDay("2026-11-20"), true);
    for (const x of ["20/11/2026", "2026-13-40", "", null, 20261120]) assert.equal(validDay(x), false, String(x));
    assert.equal(validKey("V:PKE0000000901_20261120-122038_HH.mp4"), true);
    assert.equal(validKey("R:S:2611190ABC"), true);
    assert.equal(validKey("a/b"), false);
    assert.equal(validKey(""), false);
  });
  it("ghi chú chỉ giữ trường đã biết và cắt độ dài", () => {
    assert.deepEqual(cleanNote({ lyDo: "hết hàng", xuLy: "chờ 22/11", khac: "x", state: "thieu" }), { lyDo: "hết hàng", xuLy: "chờ 22/11", state: "thieu" });
    assert.equal(cleanNote({ note: "a".repeat(900) }).note.length, 500);
    assert.deepEqual(cleanNote(null), {});
  });

  it("tình trạng kiện hoàn giữ sản phẩm đã quét, sản phẩm của đơn và dấu video đã xóa", () => {
    const m = cleanMark({ state: "dung", khac: 1, items: [{ code: "1893-10", name: "Áo", ok: true, at: 5, la: 1 }, { code: "" }], need: [{ sku: "qd26036den150", name: "Quần", quantity: 2 }, { sku: "X1", quantity: 0 }], codes: ["spx1", ""], code: "spx1", gone: 9 });
    assert.deepEqual(m, { state: "dung", items: [{ code: "1893-10", name: "Áo", ok: true, at: 5 }], need: [{ sku: "QD26036DEN150", name: "Quần", quantity: 2 }, { sku: "X1", name: "", quantity: 1 }], codes: ["SPX1"], code: "SPX1", gone: 9 });
    assert.deepEqual(cleanMark({ note: "a" }), { note: "a" });
    assert.deepEqual(cleanMark(null), {});
  });

  it("lượt nhập hàng hoàn: cần mã, số lượng khác 0; số âm là lượt hủy", () => {
    assert.deepEqual(nhapEntry({ id: "may-ab12-1700000000000-x1", sku: "qd26036den150", code: "2001-05", qty: 2, kind: "nhap", note: "", at: 7, may: "may-ab12", la: 1 }), { id: "may-ab12-1700000000000-x1", sku: "QD26036DEN150", code: "2001-05", qty: 2, kind: "nhap", note: "", at: 7, may: "may-ab12" });
    assert.equal(nhapEntry({ id: "may-ab12-1", sku: "A1", qty: -1, kind: "bo", at: 1 })?.qty, -1);
    assert.equal(nhapEntry({ id: "may-ab12-1", sku: "A1", qty: -1, kind: "bo", at: 1 })?.kind, "bo");
    for (const bad of [{ id: "x", sku: "A1", qty: 1 }, { id: "may-ab12-1", sku: "", qty: 1 }, { id: "may-ab12-1", sku: "A1", qty: 0 }, { id: "may-ab12-1", sku: "A1", qty: 5000 }, { id: "a b c d e f", sku: "A1", qty: 1 }, null]) assert.equal(nhapEntry(bad), null);
  });
  it("dòng báo cáo hoàn Viettel: chỉ giữ mã, trạng thái, lý do", () => {
    assert.deepEqual(cleanVtpRows([{ ma: " pke1575319886 ", status: " Đang chuyển hoàn ", reason: "Chuyển phân công", ten: "x", sdt: "0900000000" }, { ma: "PKE1575319886", status: "Đã trả" }, { ma: "tên khách" }, null, { ma: "PKE1574103822", trang_thai: "Đã trả", ly_do: "Không có nhu cầu nhận hàng" }]), [
      { ma: "PKE1575319886", status: "Đang chuyển hoàn", reason: "Chuyển phân công" },
      { ma: "PKE1574103822", status: "Đã trả", reason: "Không có nhu cầu nhận hàng" },
    ]);
    assert.deepEqual(cleanVtpRows("PKE1"), []);
  });
  it("bản đã lưu: còn hạn thì dùng, quá hạn / thiếu giờ / giờ ở tương lai thì tính lại", () => {
    const now = 1_000_000_000;
    assert.equal(cacheFresh(now - 5 * 60_000, 10 * 60_000, now), true);
    assert.equal(cacheFresh(now - 10 * 60_000, 10 * 60_000, now), false);
    assert.equal(cacheFresh(now + 1, 10 * 60_000, now), false);
    for (const x of [0, null, undefined, "x"]) assert.equal(cacheFresh(x, 10 * 60_000, now), false, String(x));
  });
  it("dòng sổ video: nhận dòng đủ thông tin, bỏ dòng thiếu", () => {
    const now = new Date("2026-11-20T08:00:00Z");
    const r = videoRow({ fileName: "SPXVN06141430053B_20261120-113826_DH.mp4", code: "spxvn06141430053b", orderId: "2611100MBVW3CS", sysId: 500594, mode: "DH", startedAt: Date.parse("2026-11-20T04:38:26Z"), durationSec: 34.2, size: 1234567.8, check: "Đủ 2/2", source: "Shopee", type: "Vận đơn SPX" }, "may-ab12", now)!;
    assert.deepEqual([r.file, r.ma, r.ma_don, r.so_don, r.che_do, r.bat_dau, r.giay, r.kich_thuoc, r.soat, r.may, r.da_xoa], ["SPXVN06141430053B_20261120-113826_DH.mp4", "SPXVN06141430053B", "2611100MBVW3CS", "500594", "DH", "2026-11-20T04:38:26.000Z", 34.2, 1234568, "Đủ 2/2", "may-ab12", false]);
    assert.equal(videoRow({ fileName: "PKE1_20261120-090000_HH.mp4", code: "PKE1", mode: "HH", startedAt: 1, del: true }, "", now)!.da_xoa, true);
    assert.equal(videoRow({ fileName: "PKE1_20261120-090000_HH.mp4", code: "PKE1", mode: "HH", startedAt: 1 }, "", now)!.che_do, "HH");
    assert.equal(videoRow({ fileName: "../../etc/passwd", code: "A", startedAt: 1 }, "", now), null);
    assert.equal(videoRow({ fileName: "a_DH.mp4", code: "", startedAt: 1 }, "", now), null);
    assert.equal(videoRow({ fileName: "a_DH.mp4", code: "A1", startedAt: "x" }, "", now), null);
  });
});
