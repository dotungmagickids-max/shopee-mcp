import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { ApiKeyContext } from "./api-keys";
import { cached } from "./kho-store";
import { registerKhoTools } from "./kho-tools";
import { registerMagickidsTools } from "./magickids-tools";
import { registerNoiBoTools } from "./noi-bo-tools";
import { registerSanXuatTools } from "./san-xuat-tools";

/**
 * Một cửa đọc chung mọi phần mềm nội bộ cho các phòng AI (anh Tùng chốt 27/11/2026: "có gộp thành công cụ chung").
 * Tên và tham số của công cụ này KHÔNG đổi khi thêm phần mềm mới: nguồn mới chỉ là một giá trị `nguon` mới,
 * nên phiên đang chạy không phải nạp lại danh sách công cụ. Chỉ gom các công cụ CHỈ ĐỌC (readOnlyHint) đã có.
 */

type Handler = (args: Record<string, unknown>, extra?: unknown) => Promise<CallToolResult> | CallToolResult;
export interface NguonDoc {
  ten: string;
  title: string;
  description: string;
  shape: Record<string, z.ZodType>;
  handler: Handler;
}

/** Tên nguồn: bỏ tiền tố "mk_" của công cụ gốc, vd mk_kho_dong_hang → kho_dong_hang. */
export const tenNguon = (tool: string) => tool.replace(/^mk_/, "");

/** Gom mọi công cụ chỉ đọc mà các hàm register* đăng ký, không đăng ký lên máy chủ thật. */
export function gomNguon(ctx: ApiKeyContext, registers: Array<(s: McpServer, c: ApiKeyContext) => void>): Map<string, NguonDoc> {
  const m = new Map<string, NguonDoc>();
  const thu = {
    registerTool(name: string, cfg: { title?: string; description?: string; inputSchema?: Record<string, z.ZodType>; annotations?: { readOnlyHint?: boolean } }, handler: Handler) {
      if (!cfg.annotations?.readOnlyHint) return;
      m.set(tenNguon(name), { ten: tenNguon(name), title: cfg.title ?? name, description: cfg.description ?? "", shape: cfg.inputSchema ?? {}, handler });
    },
  } as unknown as McpServer;
  for (const r of registers) r(thu, ctx);
  return m;
}

/** Danh sách nguồn kèm mô tả và tham số (JSON Schema) để phòng AI biết gọi thế nào. */
export function danhSachNguon(m: Map<string, NguonDoc>): Array<Record<string, unknown>> {
  return [...m.values()].map((n) => {
    let tham_so: unknown = {};
    try {
      const js = z.toJSONSchema(z.object(n.shape)) as { properties?: unknown; required?: unknown };
      tham_so = { properties: js.properties ?? {}, required: js.required ?? [] };
    } catch {
      tham_so = Object.keys(n.shape);
    }
    return { nguon: n.ten, ten: n.title, mo_ta: n.description, tham_so };
  });
}

const loi = (msg: string): CallToolResult => ({ isError: true, content: [{ type: "text", text: msg }] });

/**
 * Anh chốt 27/11: dùng chung để đồng nhất số lần gọi các phần mềm khác, không gọi liên tục, mỗi phòng gọi khi cần.
 * Mọi phòng gọi cùng một nguồn với cùng tham số trong thời gian này dùng chung một bản đã lưu (lưu trên Supabase,
 * nên các máy chủ Vercel cũng dùng chung), không gọi lại Pancake / Shopee / Meta.
 */
export const LUU_PHUT: Record<string, number> = { kho_dong_hang: 5, kho_su_co: 10, kho_hang_hoan: 10, kho_ton: 10, cskh_chat_luong: 15, mau_media: 10, fb_quang_cao: 10, so_sang: 15, hom_nay: 10, shopee_autopilot: 5 };
export const LUU_MAC_DINH_PHUT = 3;
const VN = (ms: number) => new Date(ms + 7 * 3600_000).toISOString().slice(0, 16).replace("T", " ");

export type GoiLuu = (key: string, ttlMs: number, fn: () => Promise<CallToolResult>, keep: (v: CallToolResult) => boolean) => Promise<CallToolResult & { _at?: number }>;

/** Bản đã lưu mặc định: bọc kết quả kèm giờ lấy để báo cho phòng biết số lấy lúc nào. */
const luuSupabase: GoiLuu = async (key, ttlMs, fn, keep) => {
  const r = await cached(key, ttlMs, async () => ({ ...(await fn()), _at: Date.now() }), keep);
  return r;
};

export function khoaLuu(nguon: string, args: unknown): string {
  return `doc:${nguon}:${createHash("sha1").update(JSON.stringify(args ?? {})).digest("hex").slice(0, 16)}`;
}

/** Gọi một nguồn: kiểm tham số theo schema của công cụ gốc rồi chạy đúng hàm của nó. */
export async function docNguon(m: Map<string, NguonDoc>, nguon: string, thamSo: unknown, luu: GoiLuu = luuSupabase, now = Date.now): Promise<CallToolResult> {
  const key = tenNguon(String(nguon ?? "").trim().toLowerCase());
  if (key === "danh_sach" || key === "") return { content: [{ type: "text", text: JSON.stringify(danhSachNguon(m), null, 1) }] };
  const n = m.get(key);
  if (!n) return loi(`Không có nguồn "${nguon}". Gọi nguon="danh_sach" để xem các nguồn: ${[...m.keys()].join(", ")}`);
  const parsed = z.object(n.shape).safeParse(thamSo ?? {});
  if (!parsed.success) return loi(`Tham số sai cho nguồn ${key}: ${parsed.error.issues.map((i) => `${i.path.join(".") || "(gốc)"}: ${i.message}`).join("; ")}`);
  const phut = LUU_PHUT[key] ?? LUU_MAC_DINH_PHUT;
  const r = await luu(khoaLuu(key, parsed.data), phut * 60_000, async () => n.handler(parsed.data as Record<string, unknown>), (v) => !v.isError);
  const { _at, ...out } = r;
  const at = _at ?? now();
  const ghi = `[nguồn ${key} · số lấy lúc ${VN(at)} giờ VN · các phòng dùng chung bản lưu ${phut} phút, gọi khi cần, không gọi liên tục]`;
  return { ...out, content: [{ type: "text", text: ghi }, ...(out.content ?? [])] };
}

/** tham_so là chuỗi JSON (hoặc object nếu client gửi thẳng). Rỗng = {}. */
export function docThamSo(v: unknown): { v: Record<string, unknown> } | { loi: string } {
  if (v == null || v === "") return { v: {} };
  if (typeof v === "object" && !Array.isArray(v)) return { v: v as Record<string, unknown> };
  try {
    const o = JSON.parse(String(v));
    if (o && typeof o === "object" && !Array.isArray(o)) return { v: o };
  } catch {
    /* rơi xuống báo lỗi */
  }
  return { loi: 'tham_so phải là chuỗi JSON dạng object, vd {"ngay":"2026-11-28"}' };
}

export function registerDocPhanMemTool(server: McpServer, ctx: ApiKeyContext): void {
  const nguon = gomNguon(ctx, [registerKhoTools, registerNoiBoTools, registerSanXuatTools, registerMagickidsTools]);
  server.registerTool(
    "mk_doc_phan_mem",
    {
      title: "Magickids: đọc phần mềm nội bộ (một cửa chung)",
      description:
        "Một cửa đọc số mọi phần mềm nội bộ để soi chiếu báo cáo: kho/đóng hàng, sự cố kho, hàng hoàn, tồn, xưởng/sản xuất, CSKH, mẫu/media, FB Magic Tool, số báo cáo sáng, bảng việc… " +
        'Gọi nguon="danh_sach" trước để xem các nguồn và tham số của từng nguồn; sau đó gọi nguon=<tên> với tham_so={…}. ' +
        "Phần mềm mới chỉ thêm nguồn mới, tên công cụ không đổi. Chỉ đọc, không ghi gì. Không trả tên, SĐT, địa chỉ khách.",
      inputSchema: {
        nguon: z.string().max(60).describe('Tên nguồn, vd "kho_dong_hang", "sx_progress"; "danh_sach" để xem tất cả'),
        // Chuỗi JSON, không dùng z.record: schema có propertyNames làm connector claude.ai bỏ cả schema công cụ (28/11).
        tham_so: z.string().max(4000).optional().describe('Tham số của nguồn dạng chuỗi JSON, vd {"ngay":"2026-11-28","toi_da":20}; xem tham số từng nguồn trong danh_sach'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ nguon: ten, tham_so }) => {
      const t = docThamSo(tham_so);
      return "loi" in t ? loi(t.loi) : docNguon(nguon, ten, t.v);
    }
  );
}
