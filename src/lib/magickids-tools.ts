import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { ApiKeyContext } from "./api-keys";
import { db } from "./supabase";

/**
 * Magickids company data: "Bản đồ" (core: rules, products, sales, profit) and "Trí nhớ" (brain: decisions,
 * knowledge, cases). Every tool calls a `public.mk_*` Postgres function (security definer, service role only),
 * which also writes `core.ai_audit_log`. Nothing here touches Shopee, Meta or Pancake; proposals only queue
 * work for the owner to approve.
 */

const ro = { readOnlyHint: true, openWorldHint: false } as const;
const MAX_CHARS = 100_000;

function agentOf(ctx: ApiKeyContext): string {
  return ctx.label?.trim() || `key:${ctx.id.slice(0, 8)}`;
}

async function call(fn: string, args: Record<string, unknown>): Promise<CallToolResult> {
  try {
    const { data, error } = await db().rpc(fn, args);
    if (error) throw new Error(error.message);
    let body = JSON.stringify(data, null, 2);
    if (body.length > MAX_CHARS) body = `${body.slice(0, MAX_CHARS)}\n\n[truncated: narrow the request]`;
    return { content: [{ type: "text", text: body }] };
  } catch (err) {
    return { isError: true, content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }] };
  }
}

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD");

export function registerMagickidsTools(server: McpServer, ctx: ApiKeyContext): void {
  const agent = agentOf(ctx);

  server.registerTool(
    "mk_get_rules",
    {
      title: "Magickids: luật, kênh, quyền AI",
      description:
        "Company rules (real ad cost multipliers, return fee, taxes, approval thresholds, catalog source), " +
        "sales channels and what each AI may do. Read this before computing cost, profit or proposing ad changes.",
      inputSchema: {},
      annotations: ro,
    },
    async () => call("mk_get_rules", { p_agent: agent })
  );

  server.registerTool(
    "mk_list_decisions",
    {
      title: "Magickids: quyết định của chủ shop",
      description:
        "Owner decisions with reasons (Trí nhớ công ty). By default only decisions still in force; " +
        "superseded ones point to their replacement via `supersedes`.",
      inputSchema: {
        query: z.string().optional().describe("Text to search in title, content, reason, area"),
        include_old: z.boolean().default(false),
        limit: z.number().int().min(1).max(100).default(20),
      },
      annotations: ro,
    },
    async ({ query, include_old, limit }) =>
      call("mk_decisions", { p_agent: agent, p_query: query ?? null, p_include_old: include_old, p_limit: limit })
  );

  server.registerTool(
    "mk_search_knowledge",
    {
      title: "Magickids: SOP, kiến thức, brand",
      description: "SOPs, product knowledge, brand guide, size charts. status 'nhap' = draft, 'chuan' = approved.",
      inputSchema: {
        query: z.string().optional(),
        kind: z.enum(["sop", "kien_thuc", "brand", "bang_size", "quy_trinh", "khac"]).optional(),
      },
      annotations: ro,
    },
    async ({ query, kind }) => call("mk_knowledge", { p_agent: agent, p_query: query ?? null, p_kind: kind ?? null })
  );

  server.registerTool(
    "mk_find_cases",
    {
      title: "Magickids: ca khó và bài học",
      description: "How past hard cases were handled (size exchange, defects, difficult customers, returns) and lessons learned.",
      inputSchema: { query: z.string().optional(), limit: z.number().int().min(1).max(100).default(20) },
      annotations: ro,
    },
    async ({ query, limit }) => call("mk_cases", { p_agent: agent, p_query: query ?? null, p_limit: limit })
  );

  server.registerTool(
    "mk_get_products",
    {
      title: "Magickids: mã mẫu và tồn kho",
      description:
        "Product codes (e.g. AO26012) from the Pancake catalog with current stock, stock value at cost and sales/day.",
      inputSchema: {
        query: z.string().optional().describe("Code or name fragment"),
        in_stock_only: z.boolean().default(true),
        limit: z.number().int().min(1).max(500).default(100),
      },
      annotations: ro,
    },
    async ({ query, in_stock_only, limit }) =>
      call("mk_products", { p_agent: agent, p_query: query ?? null, p_in_stock_only: in_stock_only, p_limit: limit })
  );

  server.registerTool(
    "mk_query_sales",
    {
      title: "Magickids: doanh số và lãi thật",
      description:
        "Sales and true profit by period × channel (Shopee from Shopee data, Facebook/TikTok from Pancake). " +
        "Read `ghi_chu` in the result: some channels lack fees or ad spend (null, never 0).",
      inputSchema: {
        from: date,
        to: date,
        group: z.enum(["channel", "day", "day_channel", "month", "month_channel", "total"]).default("channel"),
      },
      annotations: ro,
    },
    async ({ from, to, group }) => call("mk_sales", { p_agent: agent, p_from: from, p_to: to, p_group: group })
  );

  server.registerTool(
    "mk_product_profit",
    {
      title: "Magickids: lãi theo mẫu",
      description: "Profit before ads per product code over whole months, with flags for missing or estimated cost.",
      inputSchema: {
        from: date,
        to: date,
        code: z.string().optional().describe("Product code or prefix, e.g. AO26 or BD24066"),
        limit: z.number().int().min(1).max(500).default(50),
      },
      annotations: ro,
    },
    async ({ from, to, code, limit }) =>
      call("mk_product_profit", { p_agent: agent, p_from: from, p_to: to, p_code: code ?? null, p_limit: limit })
  );

  server.registerTool(
    "mk_list_proposals",
    {
      title: "Magickids: đề xuất chờ duyệt",
      description: "Proposals queued by AIs for the owner (status cho_duyet / duyet / tu_choi / da_lam / loi).",
      inputSchema: { status: z.enum(["cho_duyet", "duyet", "tu_choi", "da_lam", "loi"]).optional() },
      annotations: ro,
    },
    async ({ status }) => call("mk_list_proposals", { p_agent: agent, p_status: status ?? null })
  );

  if (ctx.access !== "read_write") return;
  const add = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const;

  server.registerTool(
    "mk_add_to_inbox",
    {
      title: "Magickids: ghi vào hộp thư Trí nhớ",
      description:
        "Save a raw note (a decision heard in chat, how a case was handled, a lesson) for the owner to review " +
        "into Trí nhớ. Only work-related content; no customer phone numbers or addresses.",
      inputSchema: {
        content: z.string().min(5).max(5000),
        source: z.string().max(100).optional().describe("e.g. telegram:<group>, zalo:<group>, claude"),
        author: z.string().max(100).optional(),
      },
      annotations: add,
    },
    async ({ content, source, author }) =>
      call("mk_add_inbox", { p_agent: agent, p_source: source ?? null, p_content: content, p_author: author ?? null })
  );

  server.registerTool(
    "mk_create_proposal",
    {
      title: "Magickids: tạo đề xuất chờ anh duyệt",
      description:
        "Queue a proposed change (e.g. raise a Meta/Shopee budget, change a price) for the owner to approve. " +
        "Does not execute anything. Increasing an ad budget 2x or more always needs approval.",
      inputSchema: {
        action: z.string().min(3).max(100).describe("e.g. meta.change_budget, shopee.change_budget, pancake.update_price"),
        target: z.string().max(200).optional().describe("Campaign, order, product code…"),
        reason: z.string().min(10).max(2000),
        payload: z.record(z.string(), z.unknown()).default({}),
      },
      annotations: add,
    },
    async ({ action, target, reason, payload }) =>
      call("mk_create_proposal", { p_agent: agent, p_action: action, p_target: target ?? null, p_reason: reason, p_payload: payload })
  );

  const taskStatus = z.enum(["moi", "dang_lam", "xong", "cham", "khong_lam_duoc", "huy"]);

  server.registerTool(
    "mk_task_create",
    {
      title: "Magickids: giao việc (bảng việc chung)",
      description:
        "Assign a task on the shared team board to a person (Hiền, Vân, Hường, Anh Tùng) or an AI employee " +
        "(Kiều Giao, Thu Hương, Kiều Trang, Vận hành, CSKH, Content, Tài chính, Kiều Trinh, Hải). The assignee is told on " +
        "Telegram within ~10 minutes. Write the title as one clear action with what to send back; put numbers in detail.",
      inputSchema: {
        assignee: z.string().min(2).max(50),
        title: z.string().min(5).max(300),
        detail: z.string().max(3000).optional(),
        due: date.optional(),
        priority: z.number().int().min(1).max(3).default(2).describe("1 = gấp, 2 = thường, 3 = khi rảnh"),
        department: z.enum(["facebook", "shopee", "van_hanh", "cskh", "content", "tai_chinh", "rd", "ceo", "he_thong"]).optional(),
      },
      annotations: add,
    },
    async ({ assignee, title, detail, due, priority, department }) =>
      call("mk_task_create", {
        p_agent: agent,
        p_assignee: assignee,
        p_title: title,
        p_detail: detail ?? null,
        p_due: due ?? null,
        p_priority: priority,
        p_department: department ?? null,
      })
  );

  server.registerTool(
    "mk_task_list",
    {
      title: "Magickids: xem bảng việc chung",
      description: "Open tasks by default (moi, dang_lam, cham). Filter by assignee or by who created them, or by one status.",
      inputSchema: {
        assignee: z.string().max(50).optional(),
        created_by: z.string().max(100).optional(),
        status: taskStatus.optional(),
        limit: z.number().int().min(1).max(200).default(50),
      },
      annotations: ro,
    },
    async ({ assignee, created_by, status, limit }) =>
      call("mk_task_list", {
        p_agent: agent,
        p_assignee: assignee ?? null,
        p_created_by: created_by ?? null,
        p_status: status ?? null,
        p_limit: limit,
      })
  );

  server.registerTool(
    "mk_task_update",
    {
      title: "Magickids: cập nhật việc",
      description: "Change a task's status, add a note (appended with time and who), or move its due date.",
      inputSchema: {
        id: z.number().int().positive(),
        status: taskStatus.optional(),
        note: z.string().max(2000).optional(),
        due: date.optional(),
      },
      annotations: add,
    },
    async ({ id, status, note, due }) =>
      call("mk_task_update", { p_agent: agent, p_id: id, p_status: status ?? null, p_note: note ?? null, p_due: due ?? null })
  );
}
