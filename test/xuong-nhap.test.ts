/** Xưởng nhập phiếu cắt, phiếu đóng gói (vào sổ ngay) và phần làm sạch kết quả đọc ảnh. */
import assert from "node:assert/strict";
import fs from "node:fs";
import { describe, it } from "node:test";
import { docAnhVao, lamSachBang, lamSachVai } from "../src/lib/xuong-doc-anh";
import { docLenhNhap, loiNhap, soNguyen } from "../src/lib/xuong-nhap";

const nay = "2026-11-23";
const gio = Date.parse("2026-11-23T03:04:05Z"); // 10:04:05 giờ Việt Nam
const dong = [{ mau: " Đỏ ", size: 130, so: "1.200" }, { mau: "Đỏ", size: "140", so: 0 }, { mau: "Trắng", size: "130", so: "35" }, { mau: "Trắng", size: "140", so: "" }];

describe("docLenhNhap: phiếu cắt", () => {
  const cat = { action: "cat", ma_hang: "ma26005", lo: " L2 ", ngay_cat: "2026-11-22", hen_tra: "2026-12-05", dot_dat: "L2", dong, nguoi: "Người A" };
  it("thành lời gọi mk_sx_lot_save, bỏ dòng 0 và trống, số có dấu chấm đọc đúng", () => {
    const r = docLenhNhap(cat, nay, gio);
    assert.ok(r.ok && r.loai === "cat");
    if (!r.ok || r.loai !== "cat") return;
    assert.deepEqual([r.fn, r.ma, r.lo, r.ghiDe, r.tong], ["mk_sx_lot_save", "MA26005", "L2", false, 1235]);
    assert.deepEqual(r.args, {
      p_agent: "Xưởng: Người A", p_ma_hang: "MA26005", p_lo: "L2", p_nguon: "Trang xưởng (/xuong), phiếu cắt: Người A",
      p_lines: [{ mau: "Đỏ", size: "130", so_cat: 1200 }, { mau: "Trắng", size: "130", so_cat: 35 }],
      p_ngay_cat: "2026-11-22", p_hen_tra: "2026-12-05", p_dot_dat: "L2",
    });
  });
  it("ghi đè lô đã có thì không gửi ngày hẹn (ngày hẹn chỉ đổi qua mục dời hẹn)", () => {
    const r = docLenhNhap({ ...cat, ghi_de: true }, nay, gio);
    assert.ok(r.ok && r.loai === "cat" && r.ghiDe && r.args.p_hen_tra === null);
  });
  it("từ chối phiếu sai", () => {
    const loi = (doi: Record<string, unknown>) => {
      const r = docLenhNhap({ ...cat, ...doi }, nay, gio);
      return r.ok ? "" : r.error;
    };
    assert.match(loi({ nguoi: "A" }), /tên người nhập/);
    assert.match(loi({ ma_hang: "x" }), /Mã hàng/);
    assert.match(loi({ lo: "" }), /lô/);
    assert.match(loi({ ngay_cat: "" }), /ngày cắt/);
    assert.match(loi({ ngay_cat: "2026-11-24" }), /tương lai/);
    assert.match(loi({ hen_tra: "2026-11-01" }), /trước ngày cắt/);
    assert.match(loi({ dong: [] }), /Chưa có số lượng/);
    assert.match(loi({ dong: [{ mau: "Đỏ", size: "130", so: "0" }] }), /Chưa có số lượng/);
    assert.match(loi({ dong: [{ mau: "Đỏ", size: "130", so: "12a" }] }), /số nguyên/);
    assert.match(loi({ dong: [{ mau: "Đỏ", size: "130", so: -3 }] }), /số nguyên/);
    assert.match(loi({ dong: [{ mau: "Đỏ", size: "130", so: 200000 }] }), /100\.000/);
    assert.match(loi({ dong: [{ mau: "Đỏ", size: "130", so: 5 }, { mau: "đỏ", size: "130", so: 6 }] }), /Trùng dòng/);
    assert.match(loi({ action: "khac" }), /action/);
  });
});

describe("docLenhNhap: phiếu đóng gói", () => {
  const giao = { action: "giao", ma_hang: "MA26001", lo: "L1", ngay: "2026-11-23", dong, nguoi: "Người B" };
  it("thành lần hàng về chỉ có số xưởng giao, không có số kho đếm, không có số Pancake", () => {
    const r = docLenhNhap({ ...giao, so_phieu: " 0457 " }, nay, gio);
    assert.ok(r.ok && r.loai === "giao");
    if (!r.ok) return;
    assert.deepEqual(r.args, {
      p_agent: "Xưởng: Người B", p_nguon: "Trang xưởng (/xuong), phiếu đóng gói: Người B · phiếu 0457",
      p_ma_hang: "MA26001", p_lo: "L1", p_ngay: "2026-11-23",
      p_lines: [{ mau: "Đỏ", size: "130", xuong_giao: 1200 }, { mau: "Trắng", size: "130", xuong_giao: 35 }],
      p_so_phieu_xuong: "0457",
    });
    assert.ok(!/kho_dem|pancake|nguoi_ky/.test(JSON.stringify(r.args)));
  });
  it("không có số phiếu thì nguồn kèm giờ nhập, để hai lần giao cùng ngày không bị coi là trùng", () => {
    const r = docLenhNhap(giao, nay, gio);
    assert.ok(r.ok && r.args.p_nguon === "Trang xưởng (/xuong), phiếu đóng gói: Người B · nhập lúc 10:04:05" && r.args.p_so_phieu_xuong === null);
  });
  it("ngày giao bắt buộc và không ở tương lai", () => {
    assert.equal(docLenhNhap({ ...giao, ngay: "" }, nay, gio).ok, false);
    assert.equal(docLenhNhap({ ...giao, ngay: "2026-11-24" }, nay, gio).ok, false);
  });
  it("tham số gửi đi đều có trong chữ ký hàm của migration", () => {
    const sql = fs.readFileSync("supabase/migrations/0025_san_xuat.sql", "utf8");
    for (const b of [giao, { action: "cat", ma_hang: "MA26001", lo: "L9", ngay_cat: nay, dong, nguoi: "Người B" }]) {
      const r = docLenhNhap(b, nay, gio);
      assert.ok(r.ok);
      if (!r.ok) continue;
      const m = sql.match(new RegExp(`create or replace function public\\.${r.fn}\\(([^)]*)\\)`));
      assert.ok(m, r.fn);
      const params = [...m[1].matchAll(/\b(p_\w+)\s/g)].map((x) => x[1]);
      for (const k of Object.keys(r.args)) assert.ok(params.includes(k), `${r.fn} không có tham số ${k}`);
    }
  });
});

describe("soNguyen, loiNhap", () => {
  it("đọc số gõ tay", () => {
    assert.deepEqual([soNguyen("1.200"), soNguyen(" 35 "), soNguyen(""), soNguyen(null), soNguyen(7), soNguyen("3,5"), soNguyen("-2"), soNguyen("12345678")], [1200, 35, 0, 0, 7, null, null, null]);
  });
  it("lỗi luật của database thành câu cho xưởng, không lộ tên hàm nội bộ", () => {
    const a = loiNhap({ code: "P0001", message: "Chưa có lô cắt MA26001 L9. Ghi lô cắt trước (mk_sx_lot_save), hàng về phải ghi đúng theo lô" });
    assert.deepEqual([a.status, /mk_sx/.test(a.error), /Nhập phiếu cắt của lô này trước/.test(a.error)], [400, false, true]);
    const b = loiNhap({ code: "P0001", message: "Đã có lần hàng về #12 cùng lô, ngày và nguồn. Muốn sửa thì truyền id" });
    assert.ok(/Phiếu này đã nhập rồi/.test(b.error) && !/truyền id/.test(b.error));
    assert.equal(loiNhap({ code: "XX000", message: "lỗi kỹ thuật" }).status, 502);
  });
});

describe("đọc ảnh phiếu", () => {
  it("chỉ nhận ảnh JPG, PNG, WEBP dạng data URL và giới hạn dung lượng", () => {
    assert.deepEqual(docAnhVao({ loai: "cat", anh: "data:image/jpeg;base64,AAAA" }), { ok: true, loai: "cat", kieu: "image/jpeg", duLieu: "AAAA" });
    assert.equal(docAnhVao({ loai: "cat", anh: "data:image/svg+xml;base64,AAAA" }).ok, false);
    assert.equal(docAnhVao({ loai: "cat", anh: "https://x.test/a.jpg" }).ok, false);
    assert.equal(docAnhVao({ loai: "khac", anh: "data:image/png;base64,AAAA" }).ok, false);
    assert.equal(docAnhVao({ loai: "vai", anh: `data:image/png;base64,${"A".repeat(3_600_000)}` }).ok, false);
  });
  it("làm sạch bảng màu × size: số chỉ còn chữ số, cắt theo số size, bỏ dòng trống", () => {
    const r = lamSachBang({
      ma_hang: " ma 26005 ", lo: "L2", ngay: "23/11", sizes: ["130", "140", ""],
      hang: [{ mau: "Hồng", so: ["98", "1.050", "7"] }, { mau: "", so: ["", ""] }, { mau: "Xanh", so: ["05", "khoảng 40"] }], ghi_chu: " Ô\nmờ ",
    });
    assert.deepEqual(r, { ma: "MA26005", lo: "L2", ngay: "", sizes: ["130", "140"], hang: [{ mau: "Hồng", o: ["98", "1050"] }, { mau: "Xanh", o: ["5", "40"] }], ghiChu: "Ô mờ" });
  });
  it("làm sạch danh sách vải: giữ dấu phẩy thập phân ở số lượng, đơn giá chỉ còn chữ số", () => {
    const r = lamSachVai({ doi_tac: "Nhà vải B", ma_hang: "", ngay: "2026-11-23", vai: [{ ten: "Cotton", mau: "Hồng", sl: "12,5 kg", dv: "kg", gia: "95.000đ", ghi: "" }, { ten: "", mau: "", sl: "", dv: "m", gia: "", ghi: "" }], ghi_chu: "" });
    assert.deepEqual(r, { doiTac: "Nhà vải B", ma: "", ngay: "2026-11-23", vai: [{ ten: "Cotton", mau: "Hồng", sl: "12,5", dv: "kg", gia: "95000", ghi: "" }], ghiChu: "" });
  });
});

describe("POST /api/xuong nhập phiếu", () => {
  it("cùng cổng mã truy cập của xưởng; phiếu sai và ảnh sai bị từ chối trước khi gọi database hay AI", async () => {
    const { POST } = await import("../src/app/api/xuong/route");
    const cu = [process.env.XUONG_API_KEY, process.env.KHO_API_KEY, process.env.ANTHROPIC_API_KEY];
    process.env.XUONG_API_KEY = "ma-xuong-thu";
    process.env.KHO_API_KEY = "ma-kho-thu";
    delete process.env.ANTHROPIC_API_KEY;
    const goi = (key: string, body: unknown) =>
      POST(new Request("https://x.test/api/xuong", { method: "POST", headers: { "x-mk-key": key, "content-type": "application/json" }, body: JSON.stringify(body) }));
    try {
      assert.equal((await goi("ma-kho-thu", { action: "cat" })).status, 401);
      assert.equal((await goi("ma-xuong-thu", { action: "cat", ma_hang: "MA26001", lo: "L1", ngay_cat: nay, dong: [], nguoi: "Người A" })).status, 400);
      assert.equal((await goi("ma-xuong-thu", { action: "doc_anh", loai: "cat", anh: "khong-phai-anh" })).status, 400);
      const r = await goi("ma-xuong-thu", { action: "doc_anh", loai: "cat", anh: "data:image/jpeg;base64,AAAA" });
      assert.equal(r.status, 501);
      assert.equal((await r.json()).chuaBat, true);
    } finally {
      const ten = ["XUONG_API_KEY", "KHO_API_KEY", "ANTHROPIC_API_KEY"];
      ten.forEach((k, i) => (cu[i] == null ? delete process.env[k] : (process.env[k] = cu[i])));
    }
  });
});
