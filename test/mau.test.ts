/** Trang Mẫu và media (/mau): vai theo mã truy cập, bản đọc theo vai, kiểm tra lệnh ghi, luật chuyển trạng thái. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ANH_TOI_DA, docLenhMau, dungLoaiAnh, hoSoTheoVai, linkHopLe, loiChuyen, thieuDeCoMedia, tomTatSua, vaiCuaKhoa, type HoSoRow } from "../src/lib/mau";

const hs = (x: Partial<HoSoRow> = {}): HoSoRow => ({
  id: 1, ma: "MAU27001", ma_chinh_thuc: null, ten: "Áo thử", thuong_hieu: "", gioi: "trai", loai: "Áo", mua: "", nguon_loai: "taobao",
  nguon_link: "https://example.com/sp/1", nguon_shop: "", thong_tin_nguon: "", phan_tich: "Phân tích nội bộ", ly_do: "", chat_lieu: "", mau_sac: "", bang_size: "",
  co_mau_that: false, ngay_mau_ve: null, gia_ban: "Giá bán thử", gia_nhap: "Giá nhập thử", link_goc: "", link_anh: "", link_video: "", link_shopee: "",
  so_anh: 0, so_video: 0, sua_tt: "chua_giao", sua_nguoi: "", sua_yeu_cau: "Yêu cầu chỉnh thử", sua_xong: null, mo_ta: "", luu_y: "", trang_thai: "dang_xem", ly_do_bo: "",
  nguoi_tao: "Người A", tao_luc: "2026-11-23T01:00:00Z", cap_nhat_luc: "2026-11-23T01:00:00Z", ...x,
});

const voiKhoa = async (dat: Record<string, string | undefined>, chay: () => Promise<void> | void) => {
  const ten = ["MAU_QUAN_LY_KEY", "MAU_LAM_KEY", "MAU_XEM_KEY", "KHO_API_KEY", "XUONG_API_KEY"];
  const cu = ten.map((k) => process.env[k]);
  for (const k of ten) dat[k] == null ? delete process.env[k] : (process.env[k] = dat[k]);
  try {
    await chay();
  } finally {
    ten.forEach((k, i) => (cu[i] == null ? delete process.env[k] : (process.env[k] = cu[i])));
  }
};
const u = "https://x.test/api/mau";
const goi = (key?: string, them = "") => new Request(u + them, key == null ? {} : { headers: { "x-mk-key": key } });

describe("vaiCuaKhoa", () => {
  it("mỗi mã một vai; sai mã thì bad; chưa đặt mã nào thì unset", async () => {
    await voiKhoa({}, () => assert.equal(vaiCuaKhoa(goi("gi-do")), "unset"));
    await voiKhoa({ MAU_QUAN_LY_KEY: "ma-quan-ly", MAU_LAM_KEY: "ma-lam", MAU_XEM_KEY: "ma-xem" }, () => {
      assert.deepEqual(["ma-quan-ly", "ma-lam", "ma-xem"].map((k) => vaiCuaKhoa(goi(k))), ["quan_ly", "lam", "xem"]);
      for (const k of [undefined, "", "ma-xe", "ma-xemx", "MA-XEM"]) assert.equal(vaiCuaKhoa(goi(k)), "bad");
    });
  });

  it("mã trùng nhau hoặc trùng mã kho, xưởng thì không dùng được", async () => {
    await voiKhoa({ MAU_QUAN_LY_KEY: "chung", MAU_LAM_KEY: "chung", MAU_XEM_KEY: "ma-xem" }, () => {
      assert.equal(vaiCuaKhoa(goi("chung")), "bad");
      assert.equal(vaiCuaKhoa(goi("ma-xem")), "xem");
    });
    await voiKhoa({ MAU_QUAN_LY_KEY: "ma-kho", KHO_API_KEY: "ma-kho" }, () => assert.equal(vaiCuaKhoa(goi("ma-kho")), "unset"));
    await voiKhoa({ MAU_LAM_KEY: "ma-xuong", MAU_XEM_KEY: "ma-xem", XUONG_API_KEY: "ma-xuong" }, () => {
      assert.equal(vaiCuaKhoa(goi("ma-xuong")), "bad");
      assert.equal(vaiCuaKhoa(goi("ma-xem")), "xem");
    });
  });
});

describe("hoSoTheoVai", () => {
  const rows = [hs(), hs({ id: 2, ma: "MAU27002", trang_thai: "co_media", link_anh: "https://example.com/t/2", mo_ta: "Mô tả thử" }), hs({ id: 3, ma: "MAU27003", trang_thai: "bo" })];
  const anh = new Map([[2, "2026-11-23T02:00:00Z"]]);

  it("quản lý thấy hết, kể cả giá nhập", () => {
    const r = hoSoTheoVai(rows, anh, "quan_ly") as Record<string, unknown>[];
    assert.equal(r.length, 3);
    assert.equal(r[0].gia_nhap, "Giá nhập thử");
    assert.deepEqual(r.map((x) => x.anh), [null, "2026-11-23T02:00:00Z", null]);
  });

  it("người làm thấy hết trừ giá nhập", () => {
    const r = hoSoTheoVai(rows, anh, "lam");
    assert.equal(r.length, 3);
    assert.ok(!JSON.stringify(r).includes("Giá nhập thử"));
    assert.ok(JSON.stringify(r).includes("Phân tích nội bộ"));
  });

  it("người xem chỉ thấy mẫu đã có media, không có giá nhập, phân tích, link nguồn, việc chỉnh ảnh", () => {
    const r = hoSoTheoVai(rows, anh, "xem") as Record<string, unknown>[];
    assert.deepEqual(r.map((x) => x.ma), ["MAU27002"]);
    const txt = JSON.stringify(r);
    for (const x of ["Giá nhập thử", "Phân tích nội bộ", "example.com/sp", "Yêu cầu chỉnh thử", "Người A", "nguon_link", "link_goc", "gia_nhap"]) assert.ok(!txt.includes(x), x);
    assert.equal(r[0].mo_ta, "Mô tả thử");
    assert.equal(r[0].link_anh, "https://example.com/t/2");
    assert.equal(r[0].gia_ban, "Giá bán thử");
  });
});

describe("docLenhMau", () => {
  const tao = { action: "tao", ma: " mau27009 ", nguoi: "  Người   B ", ten: "  Áo  thử ", nguon_link: "https://example.com/sp/9", gioi: "gai", so_anh: "3" };
  const loi = (b: unknown, vai: "quan_ly" | "lam" | "xem" = "lam") => {
    const r = docLenhMau(b, vai);
    return r.ok ? null : r;
  };

  it("thêm mẫu: mã viết hoa, chữ đã gọn, số đã đổi", () => {
    assert.deepEqual(docLenhMau(tao, "lam"), {
      ok: true, viec: "tao", nguoi: "Người B", ma: "MAU27009",
      cot: { ten: "Áo thử", gioi: "gai", nguon_link: "https://example.com/sp/9", so_anh: 3 },
    });
  });

  it("mẫu Taobao bắt buộc có link nguồn; nguồn khác thì không", () => {
    assert.match(loi({ ...tao, nguon_link: "" })!.error, /link nguồn/);
    assert.equal(docLenhMau({ ...tao, nguon_link: "", nguon_loai: "suu_tam" }, "lam").ok, true);
  });

  it("sửa: chỉ lấy trường được gửi; trường lạ bị bỏ qua; trống là xóa", () => {
    assert.deepEqual(docLenhMau({ action: "sua", id: 7, nguoi: "Người B", mo_ta: "Dòng 1\r\nDòng 2 ", ngay_mau_ve: "", co_mau_that: true, trang_thai: "co_media", id_la: 1 }, "lam"), {
      ok: true, viec: "sua", nguoi: "Người B", id: 7, cot: { mo_ta: "Dòng 1\nDòng 2", ngay_mau_ve: null, co_mau_that: true },
    });
    assert.match(loi({ action: "sua", id: 7, nguoi: "Người B" })!.error, /Chưa có thông tin/);
    assert.match(loi({ action: "sua", id: "7", nguoi: "Người B", ten: "x" })!.error, /id/);
  });

  it("từ chối đầu vào sai", () => {
    for (const b of [null, "x", [], {}, { ...tao, action: "xoa" }]) assert.ok(loi(b), JSON.stringify(b));
    assert.match(loi({ ...tao, nguoi: "A" })!.error, /tên người/);
    assert.match(loi({ ...tao, nguoi: "A\u0000B" })!.error, /tên người/);
    for (const ma of ["", "ab", "MA 27", "MÃ27001", "x".repeat(31), "-ABC"]) assert.match(loi({ ...tao, ma })!.error, /Mã mẫu/, ma);
    for (const l of ["http://example.com/a", "javascript:alert(1)", "data:text/html,x", "https://example.com/a b", 'https://example.com/"><script>', "https://u:p@example.com/", "khong-phai-link", `https://example.com/${"a".repeat(600)}`]) {
      assert.match(loi({ ...tao, link_anh: l })!.error, /Thư mục ảnh đã chỉnh/, l);
    }
    assert.match(loi({ ...tao, gioi: "nam" })!.error, /Bé trai/);
    assert.match(loi({ ...tao, loai: "Giày" })!.error, /Loại/);
    for (const loai of ["", "Áo", "Quần", "Bộ", "Váy", "Khác"]) assert.equal(docLenhMau({ ...tao, loai }, "lam").ok, true, loai);
    assert.match(loi({ ...tao, so_anh: -1 })!.error, /Số ảnh/);
    assert.match(loi({ ...tao, so_video: 1.5 })!.error, /Số video/);
    assert.match(loi({ ...tao, ngay_mau_ve: "2026-02-30" })!.error, /YYYY-MM-DD/);
    assert.match(loi({ ...tao, ten: "x".repeat(151) })!.error, /dài quá/);
    assert.match(loi({ ...tao, mo_ta: { a: 1 } })!.error, /không hợp lệ/);
    assert.match(loi({ ...tao, co_mau_that: "có" })!.error, /có hoặc không/);
  });

  it("quyền theo vai", () => {
    assert.equal(loi(tao, "xem")!.status, 403);
    assert.equal(loi({ ...tao, gia_nhap: "Giá thử" }, "lam")!.status, 403);
    assert.equal(docLenhMau({ ...tao, gia_nhap: "Giá thử" }, "quan_ly").ok, true);
    assert.equal(loi({ action: "sua", id: 1, nguoi: "Người B", sua_tt: "da_duyet" }, "lam")!.status, 403);
    assert.equal(docLenhMau({ action: "sua", id: 1, nguoi: "Người B", sua_tt: "cho_duyet" }, "lam").ok, true);
    const tt = { action: "trang_thai", id: 1, den: "chon_lam", nguoi: "Người B" };
    assert.equal(loi(tt, "lam")!.status, 403);
    assert.deepEqual(docLenhMau(tt, "quan_ly"), { ok: true, viec: "trang_thai", nguoi: "Người B", id: 1, den: "chon_lam", ghiChu: "" });
    assert.match(loi({ ...tt, den: "test_1" }, "quan_ly")!.error, /Trạng thái mới/);
    assert.match(loi({ ...tt, ghi_chu: "x".repeat(501) }, "quan_ly")!.error, /Ghi chú/);
  });

  it("ảnh đại diện: đúng kiểu, đúng byte đầu, không quá nặng", () => {
    const jpg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(40)]).toString("base64");
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40)]).toString("base64");
    const a = (du_lieu: unknown) => ({ action: "anh", id: 1, nguoi: "Người B", du_lieu });
    assert.deepEqual(docLenhMau(a(`data:image/jpeg;base64,${jpg}`), "lam"), { ok: true, viec: "anh", nguoi: "Người B", id: 1, kieu: "image/jpeg", duLieu: jpg });
    assert.equal(docLenhMau(a(`data:image/png;base64,${png}`), "quan_ly").ok, true);
    assert.match(loi(a(`data:image/png;base64,${jpg}`))!.error, /không phải ảnh/);
    assert.match(loi(a(`data:image/svg+xml;base64,${jpg}`))!.error, /JPG, PNG hoặc WEBP/);
    assert.match(loi(a(`data:text/html;base64,${jpg}`))!.error, /JPG, PNG hoặc WEBP/);
    assert.match(loi(a("https://example.com/a.jpg"))!.error, /JPG, PNG hoặc WEBP/);
    assert.match(loi(a(`data:image/jpeg;base64,${"/9j/".repeat(ANH_TOI_DA / 4 + 1)}`))!.error, /quá nặng/);
    assert.equal(dungLoaiAnh("image/webp", Buffer.from("RIFF0000WEBPVP8 ", "latin1")), true);
    assert.equal(dungLoaiAnh("image/webp", Buffer.from("RIFF0000WAVEfmt ", "latin1")), false);
  });

  it("linkHopLe", () => {
    assert.equal(linkHopLe("https://example.com/thu-muc/1?a=b"), true);
    assert.equal(linkHopLe("https://"), false);
    assert.equal(linkHopLe("ftp://example.com/a"), false);
  });
});

describe("luật chuyển trạng thái", () => {
  const du = hs({ trang_thai: "chon_lam", link_anh: "https://example.com/t/1", mo_ta: "Mô tả" });

  it("đi đúng đường: đang xem → chọn làm → đã có media; bỏ và mở lại cần lý do", () => {
    assert.equal(loiChuyen(hs(), "chon_lam", "", false), null);
    assert.match(loiChuyen(hs(), "co_media", "", true)!, /Không chuyển thẳng/);
    assert.match(loiChuyen(hs(), "dang_xem", "", false)!, /rồi/);
    assert.equal(loiChuyen(du, "co_media", "", true), null);
    assert.match(loiChuyen(hs(), "bo", "x", false)!, /lý do/);
    assert.equal(loiChuyen(hs(), "bo", "Trùng mẫu cũ", false), null);
    assert.match(loiChuyen(hs({ trang_thai: "bo" }), "dang_xem", "", false)!, /Mở lại/);
    assert.equal(loiChuyen(hs({ trang_thai: "bo" }), "dang_xem", "Xem lại cho đợt hè", false), null);
    assert.match(loiChuyen(hs({ trang_thai: "bo" }), "chon_lam", "Xem lại", false)!, /Không chuyển thẳng/);
    assert.equal(loiChuyen(hs({ ...du, trang_thai: "co_media" }), "chon_lam", "", true), null);
    assert.match(loiChuyen(hs({ trang_thai: "test_1" }), "bo", "Lý do", false)!, /đợt sau/);
  });

  it("đã có media cần đủ: link thư mục, ảnh đại diện, mô tả", () => {
    assert.deepEqual(thieuDeCoMedia(hs(), false), ["link thư mục ảnh hoặc video", "ảnh đại diện", "mô tả cơ bản"]);
    assert.deepEqual(thieuDeCoMedia(hs({ link_goc: "https://example.com/t/1", mo_ta: "  " }), true), ["mô tả cơ bản"]);
    assert.match(loiChuyen(du, "co_media", "", false)!, /ảnh đại diện/);
    assert.match(loiChuyen(hs({ trang_thai: "chon_lam" }), "co_media", "", true)!, /link thư mục.*mô tả/);
  });

  it("nhật ký sửa chỉ ghi tên trường đã đổi, không chép nội dung", () => {
    const t = tomTatSua(hs(), { ten: "Áo thử", gia_ban: "Giá mới bí mật", ngay_mau_ve: null, mo_ta: "Mô tả mới" });
    assert.equal(t, "Giá bán dự kiến, Mô tả cơ bản");
    assert.equal(tomTatSua(hs(), { ten: "Áo thử" }), "");
  });
});

describe("/api/mau", () => {
  it("chưa đặt mã 503, sai mã 401, không lưu đệm", async () => {
    const { GET, POST } = await import("../src/app/api/mau/route");
    await voiKhoa({ KHO_API_KEY: "ma-kho" }, async () => {
      const r = await GET(goi("ma-kho"));
      assert.equal(r.status, 503);
    });
    await voiKhoa({ MAU_QUAN_LY_KEY: "ma-quan-ly", MAU_XEM_KEY: "ma-xem", KHO_API_KEY: "ma-kho" }, async () => {
      for (const k of [undefined, "sai", "ma-kho"]) {
        const r = await GET(goi(k));
        assert.equal(r.status, 401);
        assert.equal(r.headers.get("cache-control"), "no-store");
        assert.equal((await GET(goi(k, "?anh=1"))).status, 401);
      }
      assert.equal((await POST(new Request(u, { method: "POST", body: "{}" }))).status, 401);
    });
  });

  it("lệnh sai và lệnh vượt quyền bị chặn trước khi tới database", async () => {
    const { GET, POST } = await import("../src/app/api/mau/route");
    await voiKhoa({ MAU_QUAN_LY_KEY: "ma-quan-ly", MAU_LAM_KEY: "ma-lam", MAU_XEM_KEY: "ma-xem" }, async () => {
      const gui = (key: string, body: string) => POST(new Request(u, { method: "POST", headers: { "x-mk-key": key }, body }));
      assert.equal((await gui("ma-lam", "không phải json")).status, 400);
      assert.equal((await gui("ma-xem", JSON.stringify({ action: "tao", ma: "MAU27001", nguoi: "Người A" }))).status, 403);
      assert.equal((await gui("ma-lam", JSON.stringify({ action: "trang_thai", id: 1, den: "chon_lam", nguoi: "Người A" }))).status, 403);
      const r = await gui("ma-lam", JSON.stringify({ action: "tao", ma: "MAU27001", nguoi: "Người A", nguon_link: "javascript:alert(1)" }));
      assert.equal(r.status, 400);
      assert.match((await r.json()).error, /Link nguồn/);
      assert.equal((await GET(goi("ma-xem", "?nhatky=1"))).status, 403);
      assert.equal((await GET(goi("ma-lam", "?anh=abc"))).status, 400);
    });
  });
});
