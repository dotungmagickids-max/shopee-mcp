import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { ApiKeyContext } from "./api-keys";
import { agentOf, call } from "./magickids-tools";
import { loiDongTrung, loiHangVe } from "./san-xuat";

/**
 * Sổ hàng xưởng (mục Sản xuất): công cụ cho phòng Thu Hà ghi phiếu đặt, lô cắt, ngày hẹn, lần hàng về.
 * Mỗi công cụ gọi một hàm Postgres `public.mk_sx_*` (supabase/migrations/0025_san_xuat.sql, 0026_sx_ngay_chot.sql), hàm đó ghi nhật ký.
 * Không công cụ nào ở đây ghi sang Pancake, Shopee hay Meta: số phiếu Pancake chỉ là số tham chiếu.
 */

const ro = { readOnlyHint: true, openWorldHint: false } as const;
const add = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const;

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD");
const maHang = z.string().trim().min(3).max(30).describe("Mã hàng, vd ADT26001");
const soNguyen = z.coerce.number().int().min(0).max(1_000_000);
/** Số có thể để trống. `null` và "" nghĩa là chưa có số (KHÔNG phải 0), nên bỏ đi trước khi ép kiểu. */
const soTuyChon = z.preprocess((v) => (v === null || v === "" ? undefined : v), soNguyen.optional());
const mau = z.string().trim().max(40).describe('Màu, vd "Xanh than"; chưa chia màu thì ""');
const size = z.coerce.string().trim().max(10).describe('Size, vd "140"; chưa chia size thì ""');

export const nguon = z
  .string()
  .trim()
  .min(3)
  .max(500)
  .describe("Bắt buộc. Nguồn của số: msgId Zalo, số phiếu xưởng, ảnh chữ ký kho… vd 'zalo:<nhóm> msg <id>' hoặc 'phiếu xưởng 21/11 lần 2'");

export const dongDat = z.array(z.object({ mau, size, so_luong: soNguyen })).min(1).max(300);
export const dongCat = z.array(z.object({ mau, size, so_cat: soNguyen })).min(1).max(300);
export const dongVe = z
  .array(
    z.object({
      mau,
      size,
      xuong_giao: soTuyChon.describe("Số xưởng ghi trên phiếu giao"),
      kho_dem: soTuyChon.describe("Số kho đếm thực nhận; kho chưa đếm thì bỏ trống (không ghi 0)"),
    })
  )
  .min(1)
  .max(300);

export const orderSaveInput = {
  ma_hang: maHang,
  dot: z.string().trim().max(30).default("").describe("Phân biệt các phiếu cùng mã, vd 'L2' hoặc '17/11'; chỉ một phiếu thì để trống"),
  nguon,
  lines: dongDat.optional().describe("Số đặt màu × size. Phiếu mới bắt buộc; khi sửa, có thì thay toàn bộ dòng"),
  ngay_dat: date.optional(),
  gia: z.coerce.number().min(0).max(100_000_000).optional().describe("Giá đ/cái"),
  ngay_du_kien_cat: date.optional(),
  trang_thai: z.enum(["cho_cat", "da_cat", "huy"]).optional().describe("da_cat = xưởng không cắt thêm cho phiếu này"),
  ghi_chu: z.string().max(2000).optional(),
};

export const lotSaveInput = {
  ma_hang: maHang,
  lo: z.string().trim().min(1).max(30).describe("Tên lô, vd 'L1', 'Tái 27/10'"),
  nguon,
  lines: dongCat.optional().describe("Số cắt THẬT màu × size. Lô mới bắt buộc; khi sửa, có thì thay toàn bộ dòng"),
  ngay_cat: date.optional(),
  hen_tra: date.optional().describe("Chỉ đặt lần đầu. Đã có ngày hẹn rồi thì dùng mk_sx_lot_reschedule"),
  gia: z.coerce.number().min(0).max(100_000_000).optional(),
  dot_dat: z.string().trim().max(30).optional().describe("Đợt của phiếu đặt cùng mã để nối lô với phiếu"),
  trang_thai: z
    .enum(["dang_ve", "chua_doi_soat", "dong"])
    .optional()
    .describe("chua_doi_soat = mới có số theo sổ xưởng, kho chưa đếm; dong = đóng lô"),
  ghi_chu: z.string().max(2000).optional(),
};

export const rescheduleInput = {
  ma_hang: maHang,
  lo: z.string().trim().min(1).max(30),
  hen_moi: date,
  ly_do: z.string().trim().min(3).max(1000).describe("Ai báo dời, vì sao"),
  nguon,
};

export const lotInfoInput = {
  ma_hang: maHang,
  lo: z.string().trim().min(1).max(30),
  nguon,
  ngay_chot: date.optional().describe("Ngày chốt sản xuất với xưởng: mốc để đo xưởng làm mất bao lâu"),
  xuong: z.string().trim().max(100).optional().describe("Đơn vị gia công"),
  ngay_vai_ve: date.optional().describe("Ngày vải về xưởng"),
  thong_tin_sx: z.string().trim().max(2000).optional().describe("Thông tin sản xuất của lô: in thêu, may, hoàn thiện, vướng gì…"),
};

export const arrivalSaveInput = {
  nguon,
  id: z.coerce.number().int().positive().optional().describe("Có id = sửa lần hàng về đó (lấy id từ mk_sx_arrivals)"),
  ma_hang: maHang.optional(),
  lo: z.string().trim().min(1).max(30).optional(),
  ngay: date.optional().describe("Ngày hàng về kho"),
  lines: dongVe.optional().describe("Lần mới bắt buộc; khi sửa, có thì thay toàn bộ dòng"),
  so_phieu_xuong: z.string().trim().max(100).optional(),
  nguoi_ky: z.string().trim().max(100).optional().describe("Người của kho ký nhận"),
  pancake: z
    .string()
    .trim()
    .max(40)
    .optional()
    .describe("Số phiếu nhập Pancake (chỉ để tham chiếu). Chỉ ghi khi kho đã đếm đủ và có người ký"),
  khong_nhap: z.boolean().optional().describe("true = lần này không nhập Pancake (vd đã nhập trước ở phiếu khác)"),
  ghi_chu: z.string().max(2000).optional(),
};

function loi(text: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text }] };
}

export function registerSanXuatTools(server: McpServer, ctx: ApiKeyContext): void {
  const agent = agentOf(ctx);

  server.registerTool(
    "mk_sx_progress",
    {
      title: "Sản xuất: tiến độ theo lô",
      description:
        "Factory progress per cut lot: cut qty, counted by warehouse, still owed (con_no = so_cat − kho_dem), days late " +
        "(ngay_tre), colour × size matrix and the history of moved due dates. cho_kho_dem = delivered by the factory " +
        "but not yet counted by the warehouse (not counted as received).",
      inputSchema: {
        ma_hang: z.string().trim().max(30).optional().describe("Mã hàng hoặc đầu mã, vd QD26"),
        chi_con_no: z.boolean().default(false).describe("true = chỉ lô đang về còn nợ"),
      },
      annotations: ro,
    },
    async ({ ma_hang, chi_con_no }) =>
      call("mk_sx_progress", { p_agent: agent, p_ma_hang: ma_hang || null, p_chi_con_no: chi_con_no })
  );

  server.registerTool(
    "mk_sx_arrivals",
    {
      title: "Sản xuất: nhật ký hàng về",
      description: "Deliveries from the factory, newest first, with colour × size lines and the id needed to edit one.",
      inputSchema: {
        ma_hang: z.string().trim().max(30).optional(),
        from: date.optional(),
        to: date.optional(),
        limit: z.coerce.number().int().min(1).max(500).default(50),
      },
      annotations: ro,
    },
    async ({ ma_hang, from, to, limit }) =>
      call("mk_sx_arrivals", { p_agent: agent, p_ma_hang: ma_hang || null, p_from: from ?? null, p_to: to ?? null, p_limit: limit })
  );

  server.registerTool(
    "mk_sx_orders",
    {
      title: "Sản xuất: phiếu đặt",
      description: "Purchase orders to the factory with ordered qty, qty already cut and qty still waiting to be cut.",
      inputSchema: {
        ma_hang: z.string().trim().max(30).optional(),
        trang_thai: z.enum(["cho_cat", "da_cat", "huy"]).optional(),
      },
      annotations: ro,
    },
    async ({ ma_hang, trang_thai }) =>
      call("mk_sx_orders", { p_agent: agent, p_ma_hang: ma_hang || null, p_trang_thai: trang_thai ?? null })
  );

  if (ctx.access !== "read_write") return;

  server.registerTool(
    "mk_sx_order_save",
    {
      title: "Sản xuất: thêm/sửa phiếu đặt",
      description:
        "Add or edit a factory order, keyed by (ma_hang, dot). Editing keeps fields you leave out. " +
        "Writes only to the production ledger; never touches Pancake.",
      inputSchema: orderSaveInput,
      annotations: add,
    },
    async (v) => {
      const trung = v.lines && loiDongTrung(v.lines);
      if (trung) return loi(trung);
      return call("mk_sx_order_save", {
        p_agent: agent,
        p_ma_hang: v.ma_hang,
        p_nguon: v.nguon,
        p_dot: v.dot,
        p_lines: v.lines ?? null,
        p_ngay_dat: v.ngay_dat ?? null,
        p_gia: v.gia ?? null,
        p_ngay_du_kien_cat: v.ngay_du_kien_cat ?? null,
        p_trang_thai: v.trang_thai ?? null,
        p_ghi_chu: v.ghi_chu ?? null,
      });
    }
  );

  server.registerTool(
    "mk_sx_lot_save",
    {
      title: "Sản xuất: thêm/sửa lô cắt",
      description:
        "Add or edit a cut lot with the REAL cut quantities per colour × size, keyed by (ma_hang, lo). " +
        "hen_tra can only be set the first time here; to move it use mk_sx_lot_reschedule so the history is kept.",
      inputSchema: lotSaveInput,
      annotations: add,
    },
    async (v) => {
      const trung = v.lines && loiDongTrung(v.lines);
      if (trung) return loi(trung);
      return call("mk_sx_lot_save", {
        p_agent: agent,
        p_ma_hang: v.ma_hang,
        p_lo: v.lo,
        p_nguon: v.nguon,
        p_lines: v.lines ?? null,
        p_ngay_cat: v.ngay_cat ?? null,
        p_hen_tra: v.hen_tra ?? null,
        p_gia: v.gia ?? null,
        p_dot_dat: v.dot_dat ?? null,
        p_trang_thai: v.trang_thai ?? null,
        p_ghi_chu: v.ghi_chu ?? null,
      });
    }
  );

  server.registerTool(
    "mk_sx_lot_reschedule",
    {
      title: "Sản xuất: đổi ngày hẹn trả",
      description: "Move a lot's due date. The old date, new date, reason and source are appended to the lot's history.",
      inputSchema: rescheduleInput,
      annotations: add,
    },
    async (v) =>
      call("mk_sx_lot_reschedule", {
        p_agent: agent,
        p_ma_hang: v.ma_hang,
        p_lo: v.lo,
        p_hen_moi: v.hen_moi,
        p_ly_do: v.ly_do,
        p_nguon: v.nguon,
      })
  );

  server.registerTool(
    "mk_sx_lot_info",
    {
      title: "Sản xuất: ngày chốt và thông tin sản xuất của lô",
      description:
        "Set the production-confirmed date (ngay_chot) and production info (factory, fabric arrival date, free notes) " +
        "of an EXISTING cut lot. Fields you leave out are kept. ngay_chot is the starting point for measuring how long " +
        "the factory takes: confirmed → cut → first delivery → fully delivered (shown by mk_sx_progress).",
      inputSchema: lotInfoInput,
      annotations: add,
    },
    async (v) => {
      if (v.ngay_chot == null && v.xuong == null && v.ngay_vai_ve == null && v.thong_tin_sx == null) {
        return loi("Chưa có thông tin nào để ghi: cần ít nhất ngay_chot, xuong, ngay_vai_ve hoặc thong_tin_sx");
      }
      return call("mk_sx_lot_info", {
        p_agent: agent,
        p_ma_hang: v.ma_hang,
        p_lo: v.lo,
        p_nguon: v.nguon,
        p_ngay_chot: v.ngay_chot ?? null,
        p_xuong: v.xuong ?? null,
        p_ngay_vai_ve: v.ngay_vai_ve ?? null,
        p_thong_tin_sx: v.thong_tin_sx ?? null,
      });
    }
  );

  server.registerTool(
    "mk_sx_arrival_save",
    {
      title: "Sản xuất: thêm/sửa lần hàng về",
      description:
        "Record one delivery from the factory for one lot on one day: per colour × size the factory's qty (xuong_giao) " +
        "and the warehouse count (kho_dem; leave empty until the warehouse has counted, never 0). " +
        "A Pancake receipt number is only accepted once every line is counted and someone from the warehouse signed. " +
        "This does NOT create anything in Pancake.",
      inputSchema: arrivalSaveInput,
      annotations: add,
    },
    async (v) => {
      const sai = loiHangVe(v);
      if (sai) return loi(sai);
      return call("mk_sx_arrival_save", {
        p_agent: agent,
        p_nguon: v.nguon,
        p_id: v.id ?? null,
        p_ma_hang: v.ma_hang ?? null,
        p_lo: v.lo ?? null,
        p_ngay: v.ngay ?? null,
        p_lines: v.lines ?? null,
        p_so_phieu_xuong: v.so_phieu_xuong ?? null,
        p_nguoi_ky: v.nguoi_ky ?? null,
        p_pancake: v.pancake ?? null,
        p_khong_nhap: v.khong_nhap ?? null,
        p_ghi_chu: v.ghi_chu ?? null,
      });
    }
  );
}
