import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { ApiKeyContext } from "./api-keys";
import { pancakeStock } from "./kho";
import { cached } from "./kho-store";
import { hoSoTheoVai, type HoSoRow } from "./mau";
import { maBanTheoVai, type MaBanRow } from "./mau-ban";
import { allRows, db } from "./supabase";

/**
 * Các trang nội bộ còn lại của web quản trị cho phòng AI soi chiếu số (anh Tùng chốt 27/11/2026):
 * CSKH chất lượng (/cskh), mẫu và media (/mau), FB Magic Tool (/fb). CHỈ ĐỌC, cùng nguồn với trang.
 * Không trả tên, SĐT, nội dung tin của khách; mẫu không có giá nhập (đọc như vai "người làm").
 */

const ro = { readOnlyHint: true, openWorldHint: false } as const;
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD");
const MAX_CHARS = 100_000;
const vnNow = () => new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);

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

/** Hồ sơ mẫu cho phòng AI: bỏ giá nhập (vai người làm), lọc theo trạng thái hoặc mã. */
export function locHoSo(rows: HoSoRow[], trangThai?: string, ma?: string): Record<string, unknown>[] {
  const q = ma?.trim().toUpperCase();
  const ds = hoSoTheoVai(rows, new Map(), "lam") as Record<string, unknown>[];
  return ds
    .filter((r) => !trangThai || r.trang_thai === trangThai)
    .filter((r) => !q || String(r.ma ?? "").toUpperCase().includes(q) || String(r.ma_chinh_thuc ?? "").toUpperCase().includes(q))
    .map(({ anh: _anh, ...r }) => r);
}

export function registerNoiBoTools(server: McpServer, _ctx: ApiKeyContext): void {
  server.registerTool(
    "mk_cskh_chat_luong",
    {
      title: "Magickids: trang Quản lý chất lượng CSKH",
      description:
        "Số của trang CSKH chất lượng cho một ngày (mặc định hôm qua): số cuộc chat, tỉ lệ chốt theo page và người trực, mã khách hỏi kèm tồn, điểm AI chấm và các danh sách cần sale xử lý (link mở cuộc chat Pancake). " +
        "`xu_huong` = số ngày (tối đa 90) để lấy dòng gọn từng ngày thay vì chi tiết một ngày. Không có tên, SĐT, nội dung tin của khách. Chỉ đọc.",
      inputSchema: {
        ngay: date.optional().describe("Ngày, mặc định hôm qua (giờ VN)"),
        xu_huong: z.coerce.number().int().min(1).max(90).optional(),
      },
      annotations: ro,
    },
    safe(async ({ ngay, xu_huong }: { ngay?: string; xu_huong?: number }) => {
      const { congNgay, layNgay, layXuHuong, ngayVN, tenPage, tinhLaiNgay } = await import("./cskh/data");
      const { layCham } = await import("./cskh/cham-data");
      const { tonTheoMa } = await import("./cskh/ton");
      const d = ngay ?? congNgay(ngayVN(), -1);
      if (xu_huong) return { den: d, ngay: await layXuHuong(congNgay(d, -(xu_huong - 1)), d) };
      let k = (await layNgay(d)) ?? (await tinhLaiNgay(d));
      if (k.cuoc.length && (!k.cuoc[0].id || k.cuoc[0].choKhach === undefined)) k = await tinhLaiNgay(d);
      let ton: Record<string, unknown> = {};
      try {
        const s = await cached("tonpancake3", 10 * 60_000, pancakeStock, (v) => v.stock.length > 0);
        ton = tonTheoMa(k.ma.map((m) => m.ma), s.stock);
      } catch {
        /* thiếu tồn thì vẫn trả số chat */
      }
      const link = (page: string, id: string) => `https://pancake.vn/${encodeURIComponent(page)}?c_id=${encodeURIComponent(id)}`;
      const boId = <T extends { page: string; id: string }>(xs: T[]) => xs.map(({ id, ...r }) => ({ ...r, link: link(r.page, id) }));
      const g = await layCham(k);
      const cham = g ? { ...g, viec: boId(g.viec), xau: boId(g.xau), khach: boId(g.khach), chamLai: boId(g.chamLai) } : null;
      const { cuoc, ...con } = k;
      return { ...con, so_cuoc: cuoc.length, tenPage: tenPage(), ton, cham };
    })
  );

  server.registerTool(
    "mk_mau_media",
    {
      title: "Magickids: trang Mẫu và media",
      description:
        "Hồ sơ mẫu (lấy mẫu, chụp ảnh, quay video, trạng thái, số ảnh/video, link Shopee) của trang /mau, không có giá nhập. " +
        "Lọc `trang_thai` hoặc `ma`. `ma_ban=true` để xem danh sách mã bán tốt tự quản (số bán, nhóm hot/đều). Chỉ đọc.",
      inputSchema: {
        trang_thai: z.string().max(40).optional(),
        ma: z.string().max(30).optional(),
        ma_ban: z.boolean().default(false),
        toi_da: z.coerce.number().int().min(1).max(300).default(100),
      },
      annotations: ro,
    },
    safe(async ({ trang_thai, ma, ma_ban, toi_da }: { trang_thai?: string; ma?: string; ma_ban: boolean; toi_da: number }) => {
      if (ma_ban) {
        const cot = "ma, ten, gioi, loai, mua, nam, anh_url, sl_ban, nam_ban, so_ban_luc, nguon, an, ly_do_an, nhom";
        const rows = await allRows<MaBanRow>(() => db().from("mau_ma_ban").select(cot).order("ma"));
        const ds = maBanTheoVai(rows, new Map(), "lam")
          .filter((r) => !ma || r.ma.includes(ma.toUpperCase()))
          .map(({ anh: _a, anhRieng: _b, ...r }) => r);
        return { tong: ds.length, ds: ds.slice(0, toi_da) };
      }
      const rows = await allRows<HoSoRow>(() => db().from("mau_ho_so").select("*").order("cap_nhat_luc", { ascending: false }).order("id"));
      const ds = locHoSo(rows, trang_thai, ma);
      const dem: Record<string, number> = {};
      for (const r of ds) dem[String(r.trang_thai)] = (dem[String(r.trang_thai)] ?? 0) + 1;
      return { tong: ds.length, theo_trang_thai: dem, ds: ds.slice(0, toi_da) };
    })
  );

  server.registerTool(
    "mk_fb_quang_cao",
    {
      title: "Magickids: FB Magic Tool (trần, mục tiêu, lịch sử lên camp, đề xuất)",
      description:
        "Số của phần mềm quảng cáo Facebook /fb. phan=tran: bảng trần chi/doanh thu từng mã; muc_tieu: mục tiêu tháng, dự chi hôm nay, còn phải lên bao nhiêu; " +
        "lich_su: các lần lên camp gần đây (kết quả từng quảng cáo); de_xuat: đề xuất chạy theo mã và theo bài. Chỉ đọc, không gọi lệnh ghi Meta.",
      inputSchema: {
        phan: z.enum(["tran", "muc_tieu", "lich_su", "de_xuat"]),
        ngay: date.optional().describe("muc_tieu: ngày lập kế hoạch, mặc định hôm nay"),
        so_ngay: z.coerce.number().int().min(1).max(60).default(14).describe("lich_su: số ngày gần nhất"),
      },
      annotations: ro,
    },
    safe(async ({ phan, ngay, so_ngay }: { phan: "tran" | "muc_tieu" | "lich_su" | "de_xuat"; ngay?: string; so_ngay: number }) => {
      const today = vnNow();
      if (phan === "tran") return (await import("./facebook/magic-data")).listCeilings();
      if (phan === "muc_tieu") return (await import("./facebook/targets-data")).loadTargetsView(today, ngay ?? today);
      if (phan === "lich_su") return (await import("./facebook/launch-data")).loadHistory(so_ngay, 30);
      return (await import("./facebook/suggest-run-data")).loadSuggest(today);
    })
  );

  server.registerTool(
    "mk_hom_nay",
    {
      title: "Magickids: trang Hôm nay (web quản trị)",
      description: "Số của trang /admin/hom-nay: 6 khối số trong ngày (doanh số các kênh, quảng cáo, đơn, kho…), mỗi số kèm nguồn và mốc giờ. Chỉ đọc.",
      inputSchema: {},
      annotations: ro,
    },
    safe(async () => (await import("./quan-tri/hom-nay")).taiHomNay())
  );

  server.registerTool(
    "mk_shopee_autopilot",
    {
      title: "Magickids: Shopee Autopilot (web quản trị)",
      description:
        "Số của Shopee Autopilot: phan=tong_quan (hôm nay từng shop: chi, doanh thu, ROAS, đề xuất), chien_dich (chiến dịch kèm xếp hạng, cần `shop_id`), " +
        "nhat_ky (các lệnh/đề xuất gần đây), cho_duyet (đề xuất đang chờ anh duyệt), do_phu (giờ nào thiếu số trong 48 giờ). Chỉ đọc, không bấm duyệt.",
      inputSchema: {
        phan: z.enum(["tong_quan", "chien_dich", "nhat_ky", "cho_duyet", "do_phu"]).default("tong_quan"),
        shop_id: z.coerce.number().int().optional().describe("chien_dich: shop_id; bỏ trống = shop đầu tiên"),
        toi_da: z.coerce.number().int().min(1).max(200).default(50),
      },
      annotations: ro,
    },
    safe(async ({ phan, shop_id, toi_da }: { phan: "tong_quan" | "chien_dich" | "nhat_ky" | "cho_duyet" | "do_phu"; shop_id?: number; toi_da: number }) => {
      const d = await import("./autopilot/dashboard");
      const { shops } = await import("./autopilot/config");
      if (phan === "tong_quan") return Promise.all(shops().map(async (s) => ({ shop: s.name ?? s.shopId, shop_id: s.shopId, hom_nay: await d.todayOverview(s.shopId), kinh_te: await d.econSummary(s.shopId) })));
      if (phan === "chien_dich") return (await d.campaignsWithRanking(shop_id ?? shops()[0].shopId)).slice(0, toi_da);
      if (phan === "nhat_ky") return d.recentLog(toi_da);
      if (phan === "cho_duyet") return d.pendingProposals();
      return d.collectCoverage(48);
    })
  );
}
