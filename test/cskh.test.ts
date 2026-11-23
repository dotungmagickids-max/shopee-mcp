/** Quản lý chất lượng CSKH: tính số một ngày, rút gọn tin Pancake, chỉ-đọc. Mọi mã, tên, số ở đây là dữ liệu giả. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { bamSdt, boThe, chuanSdt, docHoiThoai, docTin, gioPancake, maTrongChu, pageTokens, rutHoiThoai, rutTin } from "../src/lib/cskh/pancake-chat";
import { rutDon, ungVienHoiThoai } from "../src/lib/cskh/data";
import { tonTheoMa } from "../src/lib/cskh/ton";
import { MAC_DINH, dauNgay, hanTraLoi, moc90, tinhNgay, tomTat, trungVi, type HoiThoai, type Tin } from "../src/lib/cskh/tinh";

const NGAY = "2026-01-10";
const PAGE = "900000000000001";
const luc = (gio: number, phut = 0, ngay = 0) => dauNgay(NGAY) + ngay * 86_400_000 + gio * 3_600_000 + phut * 60_000;
const gioVN = (ms: number) => new Date(ms + 7 * 3_600_000).toISOString().slice(0, 16);
let dem = 0;
const tin = (ms: number, ben: Tin["ben"], them: Partial<Tin> = {}): Tin => ({ id: `m${++dem}`, luc: ms, ben, kyTu: 10, loai: "chu", ...(ben === "nhan_vien" ? { nv: "Nhân viên A" } : {}), ...them });
const ht = (id: string, taoLuc: number, ds: Tin[], them: Partial<HoiThoai> = {}): HoiThoai => ({ page: PAGE, id, loai: "INBOX", taoLuc, the: [], coSdt: false, tin: ds, ...them });

describe("cskh: hạn trả lời theo ca", () => {
  it("trong ca thì hạn là hết ca; ngoài giờ tính vào ca sáng kế tiếp", () => {
    assert.deepEqual([gioVN(hanTraLoi(luc(10)).han), hanTraLoi(luc(10)).ca], ["2026-01-10T12:00", "sáng"]);
    assert.deepEqual([gioVN(hanTraLoi(luc(14, 30)).han), hanTraLoi(luc(14, 30)).ca], ["2026-01-10T18:00", "chiều"]);
    assert.deepEqual([gioVN(hanTraLoi(luc(19)).han), hanTraLoi(luc(19)).ca], ["2026-01-10T22:00", "tối"]);
    assert.deepEqual([gioVN(hanTraLoi(luc(6)).han), hanTraLoi(luc(6)).ca], ["2026-01-10T12:00", "sáng"]);
    assert.deepEqual([gioVN(hanTraLoi(luc(23, 30)).han), hanTraLoi(luc(23, 30)).ca], ["2026-01-11T12:00", "sáng"]);
  });
  it("tin đến sát cuối ca vẫn có số phút tối thiểu", () => {
    assert.equal(gioVN(hanTraLoi(luc(11, 58)).han), "2026-01-10T12:13");
    assert.equal(gioVN(hanTraLoi(luc(11, 58), { ...MAC_DINH, toiThieuPhut: 0 }).han), "2026-01-10T12:00");
  });
  it("trung vị và mốc 90%", () => {
    assert.equal(trungVi([]), null);
    assert.equal(trungVi([5, 1, 3]), 3);
    assert.equal(trungVi([1, 3, 5, 100]), 4);
    assert.equal(moc90([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]), 9);
  });
});

describe("cskh: tính số một ngày", () => {
  const moiChot = ht("c-10001", luc(9), [tin(luc(9), "khach", { ma: ["AB12345"] }), tin(luc(9, 0) + 5_000, "tu_dong"), tin(luc(9, 1), "nhan_vien", { ma: ["AB12345", "#set nỉ"] })], { the: ["Thẻ quan tâm"], coSdt: true });
  const shopNhan = ht("c-10002", luc(9, 0, -30), [tin(luc(8), "tu_dong"), tin(luc(8, 1), "nhan_vien")]);
  const cuPhanHoi = ht("c-10003", luc(9, 0, -30), [tin(luc(8), "nhan_vien", { nv: "Nhân viên B" }), tin(luc(10), "khach"), tin(luc(13), "nhan_vien", { nv: "Nhân viên B" })]);
  const demKhuya = ht("c-10004", luc(9, 0, -5), [tin(luc(23), "khach")]);
  const binhLuan = ht("p_c-10005", luc(11), [tin(luc(11), "khach")], { loai: "COMMENT" });
  const sticker = ht("c-10006", luc(15), [tin(luc(15), "khach", { loai: "sticker", kyTu: 0 })]);
  const tuBinhLuan = ht("c-10007", luc(16), [tin(luc(16), "tu_dong"), tin(luc(16, 1), "nhan_vien")]);
  const homKhac = ht("c-10008", luc(9, 0, -1), [tin(luc(9, 0, -1), "khach")]);
  const ds = [moiChot, shopNhan, cuPhanHoi, demKhuya, binhLuan, sticker, tuBinhLuan, homKhac];
  const dons = [
    { page: PAGE, hoiThoai: "c-10001", ma: "D1", taoLuc: luc(9, 0, 1) },
    { page: PAGE, hoiThoai: "c-10003", ma: "D2", taoLuc: luc(11, 0, 3) }, // quá 48 giờ
    { page: PAGE, hoiThoai: "c-10006", ma: "D3", taoLuc: luc(14) }, // trước tin đầu tiên
  ];
  const k = tinhNgay(ds, dons, NGAY, MAC_DINH, luc(10, 0, 1));

  it("chia nhóm khách và loại cuộc shop nhắn mà khách không trả lời", () => {
    assert.equal(k.tong.khachMoi, 3); // khách mới, sticker, mới từ bình luận
    assert.equal(k.tong.khachCu, 1);
    assert.equal(k.tong.khachCuPhanHoi, 1);
    assert.equal(k.tong.shopNhan, 1);
    assert.equal(k.tong.cuoc, 5);
    assert.equal(k.tong.binhLuan, 1);
    assert.equal(k.tong.coSdt, 1);
    assert.deepEqual(Object.fromEntries(k.cuoc.map((c) => [c.duoi, c.nhom])), { "10001": "khach_moi", "10003": "khach_cu_phan_hoi", "10004": "khach_cu", "10006": "khach_moi", "10007": "moi_tu_binh_luan" });
  });
  it("tin shop gửi trước cho khách cũ không tính vào lượng tin", () => {
    assert.equal(k.tong.tinNhanLai, 3); // 2 tin của cuộc shop nhắn + 1 tin mở đầu của cuộc khách cũ phản hồi
    assert.equal(k.tong.tinKhach, 4);
    assert.equal(k.tong.tinNhanVien, 3);
    assert.equal(k.tong.tinTuDong, 2);
    assert.equal(k.theoGio.khach[9], 1);
    assert.equal(k.theoGio.khach[23], 1);
    assert.equal(k.theoGio.nhanVien[13], 1);
  });
  it("trả lời đầu bỏ qua tin tự động và ghi đúng người trực", () => {
    const a = k.nguoiTruc.find((r) => r.ten === "Nhân viên A")!;
    assert.equal(a.trungViGiay, 60);
    assert.equal(a.cuoc, 2); // cuộc khách mới và cuộc mới từ bình luận
    const b = k.nguoiTruc.find((r) => r.ten === "Nhân viên B")!;
    assert.equal(b.trungViGiay, 3 * 3600);
    assert.equal(b.traLoiTre, 1);
    assert.equal(k.nguoiTruc.find((r) => r.ten === "(chưa ai trả lời)")!.cuoc, 2);
  });
  it("chốt chỉ tính đơn trong 48 giờ kể từ tin đầu tiên trong ngày", () => {
    assert.equal(k.tong.chotMoi, 1);
    assert.equal(k.tong.chotCu, 0);
    assert.equal(k.cuoc.find((c) => c.duoi === "10006")!.chot, false);
    assert.equal(k.tamTinh, true);
    assert.equal(tinhNgay(ds, dons, NGAY, MAC_DINH, luc(1, 0, 3)).tamTinh, false);
  });
  it("tin sót tính theo hết ca; tin đêm chưa tới hạn thì chưa sót; chỉ sticker thì không tính", () => {
    assert.deepEqual(k.sot.map((s) => [s.duoi, s.ca, s.traLoi != null]), [["10003", "sáng", true]]);
    assert.equal(k.tong.sot, 1);
    assert.equal(k.tong.sotConTreo, 0);
    const sau = tinhNgay(ds, dons, NGAY, MAC_DINH, luc(13, 0, 1));
    assert.deepEqual(sau.sot.map((s) => [s.duoi, s.traLoi]), [["10003", luc(13)], ["10004", null]]);
    assert.equal(sau.tong.sotConTreo, 1);
    assert.equal(gioVN(sau.sot[1].han), "2026-01-11T12:00");
  });
  it("mã được hỏi và thẻ đếm theo số cuộc; bản tóm tắt không có gì về khách", () => {
    assert.deepEqual(k.ma, [{ ma: "#set nỉ", cuoc: 1 }, { ma: "AB12345", cuoc: 1 }]);
    assert.deepEqual(k.the, [{ the: "Thẻ quan tâm", cuoc: 1 }]);
    assert.deepEqual(tomTat(k), { ngay: NGAY, tamTinh: true, cuoc: 5, khachMoi: 3, tinKhach: 4, chotMoi: 1, sot: 1, trungViGiay: (60 + 3 * 3600) / 2 });
    assert.ok(k.cuoc.every((c) => c.duoi.length === 5));
  });
  it("khách cũ bấm quảng cáo: dòng hệ thống đến cùng lúc với tin khách không làm thành shop nhắn trước", () => {
    const bamQc = ht("q-30001", luc(9, 0, -20), [tin(luc(10) - 3_000, "tu_dong", { loai: "khac", kyTu: 0 }), tin(luc(10) - 2_000, "tu_dong"), tin(luc(10), "khach"), tin(luc(10, 1), "nhan_vien")]);
    const baoDon = ht("q-30002", luc(9, 0, -20), [tin(luc(8), "tu_dong"), tin(luc(10), "khach"), tin(luc(10, 1), "nhan_vien")]);
    const r = tinhNgay([bamQc, baoDon], [], NGAY, MAC_DINH, luc(23));
    assert.deepEqual(Object.fromEntries(r.cuoc.map((c) => [c.duoi, c.nhom])), { "30001": "khach_cu", "30002": "khach_cu_phan_hoi" });
    assert.equal(r.tong.tinNhanLai, 1);
    assert.equal(r.tong.tinTuDong, 2);
  });
  it("chỉ dán mẫu rồi dừng: mọi tin có chữ của nhân viên đều trùng với nhiều cuộc khác", () => {
    const cuoc = Array.from({ length: 5 }, (_, i) => ht(`m-2000${i}`, luc(9), [tin(luc(9, i), "khach"), tin(luc(9, i + 1), "nhan_vien", { bam: "mau1" })]));
    cuoc[0].tin.push(tin(luc(9, 30), "khach"), tin(luc(9, 31), "nhan_vien", { bam: "rieng" }));
    const r = tinhNgay(cuoc, [], NGAY, MAC_DINH, luc(23));
    assert.equal(r.nguoiTruc[0].chiDanMau, 4);
  });
});

describe("cskh: rút gọn dữ liệu Pancake", () => {
  it("giờ Pancake là UTC không ghi múi giờ", () => {
    assert.equal(gioPancake("2026-01-10T02:00:00"), Date.parse("2026-01-10T02:00:00Z"));
    assert.equal(gioPancake("2026-01-10T02:00:00Z"), Date.parse("2026-01-10T02:00:00Z"));
    assert.equal(gioPancake(""), 0);
  });
  it("tin của khách: không giữ chữ, tên hay SĐT", () => {
    const t = rutTin({ id: "x1", inserted_at: "2026-01-10T02:00:00", original_message: "Shop ơi mã ab12345 còn không, sđt 0900000000", from: { id: "777", name: "Tên Khách Giả" } }, PAGE)!;
    assert.deepEqual(t, { id: "x1", luc: Date.parse("2026-01-10T02:00:00Z"), ben: "khach", kyTu: 44, loai: "chu", ma: ["AB12345"] });
    assert.ok(!/Tên Khách|0900000000|Shop ơi/.test(JSON.stringify(t)));
  });
  it("phân biệt nhân viên, tin tự động và tin của page", () => {
    const co = { id: "x", inserted_at: "2026-01-10T02:00:00" };
    const nv = rutTin({ ...co, message: "<div>Dạ shop gửi mình bảng size áo thun ạ</div>", from: { id: PAGE, admin_name: "Nhân viên A", uid: "u1" } }, PAGE)!;
    assert.equal(nv.ben, "nhan_vien");
    assert.equal(nv.nv, "Nhân viên A");
    assert.deepEqual(nv.ma, ["#áo thun"]);
    assert.equal(nv.bam?.length, 12);
    assert.equal(rutTin({ ...co, message: "Đơn đang giao", from: { id: PAGE, admin_name: "POS" } }, PAGE)!.ben, "tu_dong");
    assert.equal(rutTin({ ...co, message: "Chào bạn", from: { id: PAGE, admin_name: "Nhân viên A", is_automated: true } }, PAGE)!.ben, "tu_dong");
    assert.equal(rutTin({ ...co, message: "Chào bạn", from: { id: PAGE } }, PAGE)!.ben, "tu_dong");
    assert.equal(rutTin({ ...co, message: "<div></div>", attachments: [{ type: "photo" }], from: { id: "777" } }, PAGE)!.loai, "anh");
    assert.equal(rutTin({ ...co, attachments: [{ type: "sticker" }], from: { id: "777" } }, PAGE)!.loai, "sticker");
    assert.equal(rutTin({ ...co, is_removed: true, from: { id: "777" } }, PAGE), null);
    assert.equal(rutTin({ ...co, message: "khách nhắn dài hơn hai mươi ký tự nhé", from: { id: "777" } }, PAGE)!.bam, undefined);
  });
  it("hội thoại: SĐT chỉ còn dạng băm, không có tên khách", () => {
    process.env.CSKH_SALT = "muoi-thu";
    const h = rutHoiThoai({ id: "c1", type: "inbox", inserted_at: "2026-01-10T01:00:00", updated_at: "2026-01-10T03:00:00", has_phone: true, message_count: 7, tags: [{ id: 1, text: " Thẻ quan tâm " }, null], recent_phone_numbers: [{ phone_number: "+84900000000" }, { phone_number: "0900000000" }], from: { name: "Tên Khách Giả" } }, PAGE)!;
    assert.equal(h.loai, "INBOX");
    assert.deepEqual(h.the, ["Thẻ quan tâm"]);
    assert.deepEqual(h.sdtBam, [bamSdt("0900000000")]);
    assert.ok(!/0900000000|84900000000|Tên Khách/.test(JSON.stringify(h)));
    assert.equal(rutDon({ id: 55, status: 1, inserted_at: "2026-01-10T04:00:00", conversation_id: `${PAGE}_777`, page_id: PAGE, bill_phone_number: "0900 000 000", bill_full_name: "Tên Khách Giả" })!.sdtBam, h.sdtBam[0]);
    delete process.env.CSKH_SALT;
  });
  it("chuẩn SĐT, bỏ thẻ HTML, mã trong chữ, các dạng mã hội thoại", () => {
    assert.equal(chuanSdt("+84 900 000 000"), "0900000000");
    assert.equal(chuanSdt("abc"), "");
    assert.equal(bamSdt("0900000000", ""), "");
    assert.equal(boThe("<div>Xin&nbsp;chào​  bạn</div>"), "Xin chào bạn");
    assert.deepEqual(maTrongChu("lấy qd12345 và XYZ54321, quần kaki"), ["QD12345", "XYZ54321", "#quần kaki"]);
    assert.deepEqual(ungVienHoiThoai(`${PAGE}_777`, PAGE), [`${PAGE}_777`, "777"]);
    assert.deepEqual(ungVienHoiThoai("777", PAGE), ["777", `${PAGE}_777`]);
    assert.deepEqual(ungVienHoiThoai("", PAGE), []);
  });
  it("khóa page đọc được cả hai dạng cấu hình", () => {
    assert.deepEqual(pageTokens('{"111":"k1","222":{"ten":"Page thử","khoa":"k2"},"333":""}'), [
      { id: "111", ten: "Page …111", khoa: "k1" },
      { id: "222", ten: "Page thử", khoa: "k2" },
    ]);
    assert.deepEqual(pageTokens(""), []);
    assert.throws(() => pageTokens("{"), /không phải JSON/);
  });
  it("tồn kho gộp theo mã hàng, bỏ qua nhóm hàng", () => {
    assert.deepEqual(tonTheoMa(["AB12345", "#set nỉ", "ZZ99999"], [["AB12345DEN120", 3, "", "AB12345", 1], ["AB12345DEN130", 0, "", "ab12345", 2], ["CD1", 9, "", "CD23456", 0]]), { AB12345: { ton: 3, phanLoai: 2, het: 1, choHang: 3 } });
  });
});

describe("cskh: chỉ đọc", () => {
  it("đọc hội thoại và tin chỉ bằng lệnh GET, lật trang đúng, lỗi không lộ khóa", async () => {
    const that = globalThis.fetch;
    const goi: Array<{ method: string; url: URL }> = [];
    const p = { id: PAGE, ten: "Page thử", khoa: "khoa-bi-mat" };
    try {
      globalThis.fetch = (async (u: string, init: RequestInit = {}) => {
        const url = new URL(u);
        goi.push({ method: String(init.method ?? "GET"), url });
        if (url.pathname.endsWith("/conversations")) {
          const trang2 = url.searchParams.has("last_conversation_id");
          const n = trang2 ? 3 : 60;
          return Response.json({ conversations: Array.from({ length: n }, (_, i) => ({ id: `${trang2 ? "b" : "a"}${i}`, type: "INBOX", inserted_at: "2026-01-10T01:00:00", updated_at: "2026-01-10T02:00:00" })) });
        }
        const da = Number(url.searchParams.get("current_count") ?? 0);
        const ngay = da ? "2026-01-08" : "2026-01-10";
        return Response.json({ messages: Array.from({ length: 30 }, (_, i) => ({ id: `m${da + i}`, inserted_at: `${ngay}T02:00:${String(i).padStart(2, "0")}`, message: "xin chào", from: { id: "777" } })) });
      }) as typeof fetch;
      assert.equal((await docHoiThoai(p, dauNgay(NGAY), dauNgay(NGAY) + 86_400_000)).length, 63);
      assert.equal((await docTin(p, "a0", dauNgay(NGAY))).length, 30);
      assert.equal(goi.length, 4);
      assert.ok(goi.every((g) => g.method === "GET" && g.url.host === "pages.fm" && g.url.pathname.startsWith("/api/public_api/")));
      assert.ok(!goi[0].url.searchParams.get("fields")!.includes("from"));
      globalThis.fetch = (async () => new Response("no", { status: 500 })) as typeof fetch;
      await assert.rejects(docTin(p, "a0", 0), (e: Error) => /HTTP 500/.test(e.message) && !e.message.includes("khoa-bi-mat"));
    } finally {
      globalThis.fetch = that;
    }
  });
  it("API /api/cskh cần mã truy cập riêng và chỉ có GET", async () => {
    const route: Record<string, unknown> = await import("../src/app/api/cskh/route");
    const GET = route.GET as (r: Request) => Promise<Response>;
    assert.deepEqual(["POST", "PUT", "PATCH", "DELETE"].filter((m) => m in route), []);
    delete process.env.CSKH_API_KEY;
    assert.equal((await GET(new Request("http://x/api/cskh"))).status, 503);
    process.env.CSKH_API_KEY = "ma-thu";
    assert.equal((await GET(new Request("http://x/api/cskh"))).status, 401);
    assert.equal((await GET(new Request("http://x/api/cskh", { headers: { "x-mk-key": "sai" } }))).status, 401);
    assert.equal((await GET(new Request("http://x/api/cskh?ngay=10/01/2026", { headers: { "x-mk-key": "ma-thu" } }))).status, 400);
    delete process.env.CSKH_API_KEY;
  });
});
