/** Một cửa đọc chung phần mềm nội bộ (mk_doc_phan_mem): gom công cụ chỉ đọc, kiểm tham số, dùng chung bản lưu. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { ApiKeyContext } from "../src/lib/api-keys";
import { danhSachNguon, docNguon, gomNguon, khoaLuu, tenNguon, type GoiLuu } from "../src/lib/doc-phan-mem-tool";
import { registerKhoTools } from "../src/lib/kho-tools";
import { registerMagickidsTools } from "../src/lib/magickids-tools";
import { registerNoiBoTools } from "../src/lib/noi-bo-tools";
import { registerSanXuatTools } from "../src/lib/san-xuat-tools";

const ctx = { id: "00000000-0000-0000-0000-000000000000", label: "test", access: "read_write" } as unknown as ApiKeyContext;

function fakeRegister(calls: unknown[]) {
  return (s: McpServer) => {
    s.registerTool("mk_thu_doc", { title: "Thử", description: "đọc thử", inputSchema: { ngay: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), toi_da: z.coerce.number().int().default(5) }, annotations: { readOnlyHint: true } }, async (a: unknown) => {
      calls.push(a);
      return { content: [{ type: "text", text: JSON.stringify(a) }] };
    });
    s.registerTool("mk_thu_ghi", { title: "Ghi", description: "ghi", inputSchema: {}, annotations: { readOnlyHint: false } }, async () => ({ content: [] }));
  };
}

/** Bản lưu giả trong bộ nhớ: giống cached() của kho-store. */
function luuGia(): GoiLuu & { store: Map<string, CallToolResult & { _at: number }> } {
  const store = new Map<string, CallToolResult & { _at: number }>();
  const f = (async (key, ttl, fn, keep) => {
    const old = store.get(key);
    if (old && Date.now() - old._at < ttl) return old;
    const v = { ...(await fn()), _at: Date.now() };
    if (keep(v)) store.set(key, v);
    return v;
  }) as GoiLuu & { store: typeof store };
  f.store = store;
  return f;
}

describe("mk_doc_phan_mem", () => {
  it("gom đủ công cụ chỉ đọc thật, bỏ công cụ ghi", () => {
    const m = gomNguon(ctx, [registerKhoTools, registerNoiBoTools, registerSanXuatTools, registerMagickidsTools]);
    for (const k of ["kho_dong_hang", "kho_su_co", "kho_hang_hoan", "kho_ton", "cskh_chat_luong", "mau_media", "fb_quang_cao", "sx_orders", "sx_progress", "so_sang", "task_list", "hom_nay", "shopee_autopilot"]) assert.ok(m.has(k), k);
    for (const k of ["task_create", "task_update", "sx_order_save", "tin_cho_anh_da_chuyen"]) assert.equal(m.has(k), false, k);
    const ds = danhSachNguon(m);
    const dh = ds.find((d) => d.nguon === "kho_dong_hang") as any;
    assert.ok(dh.tham_so.properties.ngay);
    assert.equal(tenNguon("mk_kho_ton"), "kho_ton");
  });

  it("kiểm tham số, báo nguồn sai, danh_sach", async () => {
    const calls: unknown[] = [];
    const m = gomNguon(ctx, [fakeRegister(calls)]);
    assert.equal(m.has("thu_ghi"), false);
    const luu = luuGia();
    const sai = await docNguon(m, "thu_doc", { ngay: "27/11" }, luu);
    assert.equal(sai.isError, true);
    assert.match((sai.content[0] as any).text, /ngay/);
    const khong = await docNguon(m, "khong_co", {}, luu);
    assert.equal(khong.isError, true);
    assert.match((khong.content[0] as any).text, /danh_sach/);
    const ds = await docNguon(m, "danh_sach", undefined, luu);
    assert.match((ds.content[0] as any).text, /thu_doc/);
    assert.equal(calls.length, 0);
  });

  it("nhiều phòng gọi cùng nguồn, cùng tham số thì dùng chung một bản lưu", async () => {
    const calls: unknown[] = [];
    const m = gomNguon(ctx, [fakeRegister(calls)]);
    const luu = luuGia();
    const a = await docNguon(m, "thu_doc", { ngay: "2026-11-27" }, luu);
    const b = await docNguon(m, "mk_thu_doc", { ngay: "2026-11-27", toi_da: 5 }, luu);
    assert.equal(calls.length, 1, "lần 2 dùng bản lưu");
    assert.deepEqual(calls[0], { ngay: "2026-11-27", toi_da: 5 });
    assert.match((a.content[0] as any).text, /số lấy lúc .* dùng chung bản lưu 3 phút/);
    assert.equal((b.content[1] as any).text, (a.content[1] as any).text);
    await docNguon(m, "thu_doc", { ngay: "2026-11-26" }, luu);
    assert.equal(calls.length, 2, "tham số khác thì gọi riêng");
    assert.notEqual(khoaLuu("thu_doc", { ngay: "2026-11-27" }), khoaLuu("thu_doc", { ngay: "2026-11-26" }));
  });

  it("kết quả lỗi không lưu lại", async () => {
    let n = 0;
    const m = gomNguon(ctx, [
      (s: McpServer) =>
        s.registerTool("mk_loi", { title: "", description: "", inputSchema: {}, annotations: { readOnlyHint: true } }, async () => {
          n++;
          return { isError: true, content: [{ type: "text", text: "Pancake 429" }] };
        }),
    ]);
    const luu = luuGia();
    await docNguon(m, "loi", {}, luu);
    await docNguon(m, "loi", {}, luu);
    assert.equal(n, 2);
  });
});
