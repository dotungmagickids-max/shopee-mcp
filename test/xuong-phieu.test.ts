/** Phiếu xưởng gửi đối tác lưu trên máy chủ: kiểm và làm sạch nội dung, giữ đơn giá vải, đánh số khi trùng. */
import assert from "node:assert/strict";
import fs from "node:fs";
import { describe, it } from "node:test";
import { chuaCoBang, docPhieu, soTiep, trungSo } from "../src/lib/xuong-phieu";

const gui = { ten: "Xưởng may A", diaChi: "Số 1 đường Mẫu", sdt: "0900 000 000", nguoi: "Người A" };
const vai = {
  loai: "vai", so: "dv-261123-01", ngay: "2026-11-23", can: "2026-11-27", doiTac: "  Nhà vải   B ", lienHe: "Người B", ma: "ma26005", lo: "L2", gui,
  vai: [{ ten: "Cotton 4 chiều", mau: "Hồng", sl: "120", dv: "kg", gia: "95000", ghi: "Khổ 1m8" }, { ten: "", mau: "", sl: "", dv: "kg", gia: "", ghi: "" }],
  sizes: ["130"], hang: [{ mau: "Đỏ", o: ["5"] }], viTri: "ngực", yeuCau: "x", ghiChu: "Giao tại xưởng\r\ngiờ hành chính", id: "p1", sid: 9, luuLuc: 1, la: "trường lạ",
};
const may = { loai: "may", so: "GM-261123-01", ngay: "2026-11-23", doiTac: "Tổ may C", gui, sizes: ["130", "140", ""], hang: [{ mau: "Đỏ", o: ["20", "24", "9"] }, { mau: "", o: [] }], yeuCau: "May theo bảng thông số" };

describe("docPhieu", () => {
  it("phiếu đặt vải: giữ đơn giá, bỏ trường lạ, chuẩn hóa chữ, bỏ dòng trống", () => {
    const r = docPhieu({ action: "phieu_luu", nguoi: "Người A", phieu: vai });
    assert.ok(r.ok);
    if (!r.ok) return;
    assert.equal(r.id, null);
    assert.equal(r.nguoi, "Người A");
    assert.deepEqual(r.phieu, {
      loai: "vai", so: "DV-261123-01", ngay: "2026-11-23", can: "2026-11-27", doiTac: "Nhà vải B", lienHe: "Người B", ma: "MA26005", lo: "L2", gui,
      vai: [{ ten: "Cotton 4 chiều", mau: "Hồng", sl: "120", dv: "kg", gia: "95000", ghi: "Khổ 1m8" }],
      sizes: [], hang: [], viTri: "", kieu: "", yeuCau: "", ghiChu: "Giao tại xưởng\ngiờ hành chính",
    });
    assert.ok(!/"la"|"sid"|"luuLuc"/.test(JSON.stringify(r.phieu)));
  });
  it("phiếu giao may: bảng màu × size cắt theo số size, bỏ dòng trống; người ghi lấy từ người lập phiếu", () => {
    const r = docPhieu({ id: "12", phieu: may });
    assert.ok(r.ok);
    if (!r.ok) return;
    assert.equal(r.id, 12);
    assert.equal(r.nguoi, "Người A");
    assert.deepEqual([r.phieu.sizes, r.phieu.hang, r.phieu.vai], [["130", "140"], [{ mau: "Đỏ", o: ["20", "24"] }], []]);
  });
  it("từ chối phiếu thiếu hoặc sai", () => {
    const loi = (doi: Record<string, unknown>, goc: Record<string, unknown> = vai) => {
      const r = docPhieu({ phieu: { ...goc, ...doi } });
      return r.ok ? "" : r.error;
    };
    assert.match(loi({ loai: "khac" }), /Loại phiếu/);
    assert.match(loi({ so: "a" }), /Số phiếu/);
    assert.match(loi({ so: "DV 01; drop" }), /Số phiếu/);
    assert.match(loi({ ngay: "2026-02-30" }), /Ngày lập/);
    assert.match(loi({ can: "mai" }), /Ngày cần/);
    assert.match(loi({ doiTac: " " }), /đối tác/);
    assert.match(loi({ gui: { ...gui, ten: "" } }), /đơn vị gửi/);
    assert.match(loi({ vai: [{ ten: "Cotton", sl: "0", dv: "kg" }] }), /Chưa có dòng vải/);
    assert.match(loi({ vai: [{ ten: "Cotton", sl: "10", dv: "tấn" }] }), /Đơn vị vải/);
    assert.match(loi({ vai: [{ ten: "Cotton", sl: "mười", dv: "kg" }] }), /phải là số/);
    assert.match(loi({ vai: [{ ten: "Cotton", sl: "10", dv: "kg", gia: "95k" }] }), /Đơn giá phải là số/);
    assert.match(loi({ ghiChu: "x".repeat(801) }), /dài quá/);
    assert.match(loi({ doiTac: "A\u0000B" }), /không hợp lệ/);
    assert.match(loi({ hang: [{ mau: "Đỏ", o: ["", ""] }] }, may), /Chưa có số lượng/);
    assert.match(loi({ vai: new Array(31).fill({ ten: "x", sl: "1", dv: "kg" }) }), /Danh sách vải/);
    assert.equal(docPhieu({ id: -1, phieu: vai }).ok, false);
    assert.equal(docPhieu({}).ok, false);
    assert.equal(docPhieu(null).ok, false);
  });
});

describe("soTiep", () => {
  it("số máy tự đánh mà trùng thì lấy số kế tiếp trong ngày của cùng loại", () => {
    assert.equal(soTiep("DV-261123-01", ["DV-261123-01", "DV-261123-03", "IN-261123-07", "DV-261122-09"]), "DV-261123-04");
    assert.equal(soTiep("GM-261123-01", []), "GM-261123-01");
  });
  it("số người gõ tay thì không tự đổi", () => {
    assert.equal(soTiep("PHIEU-A1", ["PHIEU-A1"]), null);
  });
});

describe("lỗi database", () => {
  it("nhận ra bảng chưa có và số phiếu trùng", () => {
    assert.equal(chuaCoBang({ code: "PGRST205", message: "Could not find the table 'public.sx_phieu_gui' in the schema cache" }), true);
    assert.equal(chuaCoBang({ code: "42P01", message: 'relation "sx_phieu_gui" does not exist' }), true);
    assert.equal(chuaCoBang({ code: "23505", message: "duplicate key" }), false);
    assert.equal(trungSo({ code: "23505" }), true);
  });
  it("migration khóa bảng với người ngoài", () => {
    const sql = fs.readFileSync("supabase/migrations/0028_sx_phieu_gui.sql", "utf8");
    assert.match(sql, /enable row level security/);
    assert.match(sql, /revoke all on sx_phieu_gui from anon, authenticated/);
  });
});

describe("POST /api/xuong phiếu", () => {
  it("cùng cổng mã truy cập của xưởng; phiếu sai bị từ chối trước khi gọi database", async () => {
    const { POST } = await import("../src/app/api/xuong/route");
    const cu = [process.env.XUONG_API_KEY, process.env.KHO_API_KEY];
    process.env.XUONG_API_KEY = "ma-xuong-thu";
    process.env.KHO_API_KEY = "ma-kho-thu";
    const goi = (key: string, body: unknown) =>
      POST(new Request("https://x.test/api/xuong", { method: "POST", headers: { "x-mk-key": key, "content-type": "application/json" }, body: JSON.stringify(body) }));
    try {
      assert.equal((await goi("sai", { action: "phieu_luu", phieu: vai })).status, 401);
      assert.equal((await goi("ma-kho-thu", { action: "phieu_luu", phieu: vai })).status, 401);
      const r = await goi("ma-xuong-thu", { action: "phieu_luu", phieu: { ...vai, doiTac: "" } });
      assert.equal(r.status, 400);
      assert.match((await r.json()).error, /đối tác/);
      assert.equal((await goi("ma-xuong-thu", { action: "phieu_xoa", id: "x" })).status, 400);
    } finally {
      for (const [k, v] of [["XUONG_API_KEY", cu[0]], ["KHO_API_KEY", cu[1]]] as const) {
        if (v == null) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
});
