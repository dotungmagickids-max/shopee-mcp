import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { ApiKeyContext } from "./api-keys";
import { cancelledRecent, giaoProblems, ordersToPack, pancakeStock, returnsExpected } from "./kho";
import { chiMucDaDong, giaoCoVanDe, huySauKhiDong, layLechGanDay, tomTatDongHang, tomTatHangHoan, tomTatKiemKe, tomTatTon, vnDay, vnTime } from "./kho-doc";
import { cached, dayGet, kiemList, lechList, marksGet, nhapList, videoList } from "./kho-store";

/**
 * Trang kho (đóng hàng, Soát đơn, hàng hoàn, đơn hủy, Viettel Post, tồn, kiểm kê) cho các phòng AI soi chiếu số
 * (anh Tùng chốt 27/11/2026: phần mềm nội bộ các phòng phải xem được). CHỈ ĐỌC: không ghi Shopee, Pancake,
 * Viettel Post hay sổ kho. Không trả tên, SĐT, địa chỉ khách, tiền thu hộ, tên sản phẩm.
 */

const ro = { readOnlyHint: true, openWorldHint: false } as const;
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD");
const MAX_CHARS = 100_000;

function text(v: unknown): CallToolResult {
  let body = JSON.stringify(v, null, 1);
  if (body.length > MAX_CHARS) body = `${body.slice(0, MAX_CHARS)}\n\n[đã cắt bớt: thu hẹp yêu cầu]`;
  return { content: [{ type: "text", text: body }] };
}

const safe =
  <A>(fn: (a: A) => Promise<unknown>) =>
  async (a: A): Promise<CallToolResult> => {
    try {
      return text(await fn(a));
    } catch (err) {
      return { isError: true, content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }] };
    }
  };

/** Số ngày sổ video cần đọc để phủ ngày `ngay` (thêm 2 ngày cho đơn tồn đóng muộn). */
export function soNgayVideo(ngay: string, now: number, toiThieu = 2): number {
  const cach = Math.ceil((now - Date.parse(`${ngay}T00:00:00Z`)) / 86400_000) + 2;
  return Math.min(90, Math.max(toiThieu, cach));
}

export function registerKhoTools(server: McpServer, _ctx: ApiKeyContext): void {
  server.registerTool(
    "mk_kho_dong_hang",
    {
      title: "Magickids: đóng hàng và Soát đơn (phần mềm kho)",
      description:
        "Số của phần mềm đóng hàng nội bộ cho một ngày (mặc định hôm nay, giờ VN): video đóng hàng theo kênh; Soát đơn (đơn trong danh sách chuẩn bị đã đóng / chưa đóng, kèm lý do kho ghi); " +
        "đơn Shopee quá hạn gửi hoặc đến hạn trong ngày mà CHƯA có video đóng; số đơn chờ đóng hiện tại theo kênh. " +
        "`tra`: tra từng mã đơn / mã vận đơn / số đơn Pancake xem đã có video đóng chưa (sổ 90 ngày). " +
        "Dùng để đối chiếu mọi báo cáo đi đơn, đơn quá hạn, đơn nợ: Pancake 'Đã gửi hàng' mà chưa có video đóng là CHƯA ĐÓNG. Chỉ đọc.",
      inputSchema: {
        ngay: date.optional().describe("Ngày soát, mặc định hôm nay (giờ VN)"),
        tra: z.array(z.string().trim().min(4).max(40)).max(200).optional().describe("Mã đơn, mã vận đơn hoặc số đơn Pancake cần tra"),
        don_cho: z.boolean().default(true).describe("Đọc đơn chờ gửi (Shopee API + Pancake, mất 10–30 giây). false nếu chỉ cần Soát đơn / tra mã"),
        toi_da: z.coerce.number().int().min(1).max(300).default(50).describe("Số dòng tối đa mỗi danh sách"),
      },
      annotations: ro,
    },
    safe(async ({ ngay, tra, don_cho, toi_da }: { ngay?: string; tra?: string[]; don_cho: boolean; toi_da: number }) => {
      const now = Date.now();
      const d = ngay ?? vnDay(now);
      const days = tra?.length ? 90 : soNgayVideo(d, now);
      const [video, day, orders] = await Promise.all([
        videoList(days),
        dayGet(d).catch(() => null),
        don_cho ? ordersToPack().catch((err) => ({ orders: null, errors: [String(err instanceof Error ? err.message : err)] })) : Promise.resolve(null),
      ]);
      return tomTatDongHang({
        ngay: d,
        now,
        video: video.rows,
        day: day && day.codes.length ? day : null,
        orders: orders?.orders ?? null,
        ordersErrors: orders?.errors,
        tra,
        toiDa: toi_da,
      });
    })
  );

  server.registerTool(
    "mk_kho_su_co",
    {
      title: "Magickids: sự cố kho (đơn hủy sau khi đóng, giao có vấn đề, lấy lệch)",
      description:
        "Ba danh sách của phần mềm kho: (1) đơn đã hủy trên Pancake trong 5 ngày mà kho đã quay video đóng (phải lấy lại hàng), kèm kho đã ghi lấy lại chưa; " +
        "(2) đơn Viettel Post giao có vấn đề còn mở theo báo cáo mail hằng ngày, kèm kết quả xử lý đã ghi; (3) lần lấy hàng lệch khi đóng trong 7 ngày. Chỉ đọc.",
      inputSchema: { toi_da: z.coerce.number().int().min(1).max(300).default(50) },
      annotations: ro,
    },
    safe(async ({ toi_da }: { toi_da: number }) => {
      const now = Date.now();
      const [video, huy, giao, lech] = await Promise.all([videoList(7), cancelledRecent(now), giaoProblems(now), lechList()]);
      const idx = chiMucDaDong(video.rows);
      const sauDong = huySauKhiDong(huy.rows, idx, huy.marks);
      return {
        doc_luc: vnTime(now),
        huy_sau_khi_dong: { so_don: sauDong.length, danh_sach: sauDong.slice(0, toi_da), ...(huy.errors.length ? { loi: huy.errors } : {}) },
        giao_co_van_de: { bao_cao_ngay: giao.ngay, ...giaoCoVanDe(giao.rows, giao.marks, toi_da) },
        lay_lech_7_ngay: layLechGanDay(lech.entries, now).slice(0, toi_da),
      };
    })
  );

  server.registerTool(
    "mk_kho_hang_hoan",
    {
      title: "Magickids: hàng hoàn (phần mềm kho)",
      description:
        "Kiện hoàn đang về kho (Shopee trả hàng, Viettel Post giao thất bại / hoàn một phần) theo kênh, tình trạng kho đã ghi khi kiện về, " +
        "và số lượt nhập hàng hoàn 7 ngày gần nhất. Chỉ đọc.",
      inputSchema: { toi_da: z.coerce.number().int().min(1).max(300).default(50) },
      annotations: ro,
    },
    safe(async ({ toi_da }: { toi_da: number }) => {
      const now = Date.now();
      const [ret, marks, nhap] = await Promise.all([cached("hoan", 10 * 60_000, returnsExpected, (v) => !v.errors.length), marksGet(), nhapList()]);
      return {
        doc_luc: vnTime(now),
        nguon_viettel: ret.vtp,
        ...tomTatHangHoan(ret.returns, marks.marks, nhap.entries, now, toi_da),
        ...(ret.errors.length ? { loi: ret.errors } : {}),
      };
    })
  );

  server.registerTool(
    "mk_kho_ton",
    {
      title: "Magickids: tồn kho thực và tổng kiểm kho (trang Quản lý kho)",
      description:
        "Tồn thực Pancake gom theo mã hàng (chỉ mã, không tên sản phẩm) và số đơn đang chờ hàng; lọc `ma` để xem từng phân loại. " +
        "`kiem_ke` = ngày bắt đầu đợt tổng kiểm kho: tổng số đếm và các phân loại lệch so với tồn Pancake. Số lưu tạm 10 phút. Chỉ đọc.",
      inputSchema: {
        ma: z.array(z.string().trim().min(3).max(30)).max(30).optional().describe("Mã hàng cần xem, vd ADT26001"),
        kiem_ke: date.optional().describe("Ngày bắt đầu đợt tổng kiểm kho"),
      },
      annotations: ro,
    },
    safe(async ({ ma, kiem_ke }: { ma?: string[]; kiem_ke?: string }) => {
      const now = Date.now();
      const stock = await cached("tonpancake3", 10 * 60_000, pancakeStock, (v) => v.stock.length > 0);
      const out: Record<string, unknown> = { doc_luc: vnTime(now), so_ton_luc: vnTime(stock.at), ...tomTatTon(stock.stock, ma) };
      if (kiem_ke) out.kiem_ke = { dot: kiem_ke, ...tomTatKiemKe((await kiemList(kiem_ke)).entries, stock.stock) };
      return out;
    })
  );
}
