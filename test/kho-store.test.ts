/** Dữ liệu vận hành của kho trên Supabase: lọc mã, ghi chú, dòng sổ video. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { cacheFresh, cleanCodes, cleanNote, cleanVtpRows, validDay, validKey, videoRow } from "../src/lib/kho-store";

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
