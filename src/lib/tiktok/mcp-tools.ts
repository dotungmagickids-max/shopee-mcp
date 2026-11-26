import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { ApiKeyContext } from "../api-keys";
import { db } from "../supabase";
import { isReadOnly, listAccounts, tiktokCall, tiktokConfigured, type HttpMethod } from "./client";
import { contentConfigured, draftStatus, uploadDraft } from "./content";

const text = (v: unknown): CallToolResult => ({
  content: [{ type: "text", text: typeof v === "string" ? v : JSON.stringify(v, null, 2) }],
});
const fail = (msg: string): CallToolResult => ({ isError: true, content: [{ type: "text", text: msg }] });

const target = {
  shop: z.string().optional().describe("Shop id, code or name; omit when only one TikTok shop is authorized"),
  creator: z
    .boolean()
    .default(false)
    .describe("true = call as the authorized TikTok creator account (affiliate_creator APIs) instead of the shop"),
};
const request = {
  path: z.string().describe("API path incl. version, e.g. /order/202309/orders/search or /product/202309/products/{id}"),
  query: z.record(z.string(), z.any()).optional().describe("Query params (app_key, timestamp, sign, shop_cipher are added automatically)"),
  body: z.any().optional().describe("JSON body for POST/PUT/DELETE"),
};

/** TikTok Shop tools (app "Magickids Gateway"). Every call writes audit_log with endpoint "tiktok:<METHOD> <path>". */
export function registerTikTokTools(server: McpServer, ctx: ApiKeyContext): void {
  async function run(method: HttpMethod, a: { path: string; query?: Record<string, unknown>; body?: unknown; shop?: string; creator?: boolean }, access: "read" | "write") {
    if (!tiktokConfigured()) return fail("TikTok Shop chưa cấu hình trên máy chủ (TIKTOK_APP_KEY / TIKTOK_APP_SECRET).");
    const started = Date.now();
    let ok = false;
    let errorMessage: string | null = null;
    try {
      const r = await tiktokCall({ method, path: a.path, query: a.query as never, body: a.body, shop: a.shop, creator: a.creator });
      ok = true;
      return text(r);
    } catch (err) {
      errorMessage = err instanceof Error ? err.message : String(err);
      return fail(errorMessage);
    } finally {
      await db()
        .from("audit_log")
        .insert({
          api_key_id: ctx.id,
          shop_id: null,
          endpoint: `tiktok:${method} ${a.path}`,
          access,
          ok,
          error: errorMessage?.slice(0, 2000) ?? null,
          duration_ms: Date.now() - started,
        })
        .then(undefined, () => undefined);
    }
  }

  server.registerTool(
    "tiktok_shops",
    {
      title: "TikTok Shop: authorized shops and accounts",
      description: "Lists TikTok Shop sellers (with shops) and creator accounts authorized for the Magickids Gateway app, their scopes and token expiry.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      if (!tiktokConfigured()) return fail("TikTok Shop chưa cấu hình trên máy chủ.");
      try {
        const accounts = await listAccounts();
        return text(
          accounts.map((a) => ({
            type: a.user_type === 1 ? "creator" : "seller",
            name: a.seller_name,
            region: a.region,
            shops: (a.shops ?? []).map((s) => ({ id: s.id, name: s.name, code: s.code, region: s.region })),
            scopes: a.scopes,
            access_token_expires: new Date(Number(a.access_expire_at)).toISOString(),
            refresh_token_expires: a.refresh_expire_at ? new Date(Number(a.refresh_expire_at)).toISOString() : null,
          }))
        );
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    }
  );

  server.registerTool(
    "tiktok_orders",
    {
      title: "TikTok Shop: search orders",
      description: "Orders created in a time window (Order Search API 202309). Times are unix seconds. Returns one page; pass next_page_token for more.",
      inputSchema: {
        create_time_ge: z.number().int().describe("Unix seconds, inclusive"),
        create_time_lt: z.number().int().describe("Unix seconds, exclusive"),
        order_status: z.string().optional().describe("e.g. AWAITING_SHIPMENT, IN_TRANSIT, DELIVERED, COMPLETED, CANCELLED"),
        page_size: z.number().int().min(1).max(100).default(50),
        next_page_token: z.string().optional(),
        shop: target.shop,
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (a) =>
      run(
        "POST",
        {
          path: "/order/202309/orders/search",
          query: { page_size: a.page_size, ...(a.next_page_token ? { page_token: a.next_page_token } : {}) },
          body: { create_time_ge: a.create_time_ge, create_time_lt: a.create_time_lt, ...(a.order_status ? { order_status: a.order_status } : {}) },
          shop: a.shop,
        },
        "read"
      )
  );

  server.registerTool(
    "tiktok_products",
    {
      title: "TikTok Shop: search products",
      description: "Products of the shop (Product Search API 202309), one page at a time.",
      inputSchema: {
        status: z.string().optional().describe("ALL, DRAFT, PENDING, FAILED, ACTIVATE, SELLER_DEACTIVATED, PLATFORM_DEACTIVATED, FREEZE, DELETED"),
        page_size: z.number().int().min(1).max(100).default(50),
        next_page_token: z.string().optional(),
        shop: target.shop,
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (a) =>
      run(
        "POST",
        {
          path: "/product/202309/products/search",
          query: { page_size: a.page_size, ...(a.next_page_token ? { page_token: a.next_page_token } : {}) },
          body: a.status ? { status: a.status } : {},
          shop: a.shop,
        },
        "read"
      )
  );

  server.registerTool(
    "tiktok_read",
    {
      title: "TikTok Shop: call a read API",
      description:
        "Calls any TikTok Shop Open API that only reads data: GET, or POST search/query endpoints. " +
        "Docs: partner.tiktokshop.com/docv2 (API Reference). Use for finance, returns, promotions, analytics, logistics, affiliate data.",
      inputSchema: { method: z.enum(["GET", "POST"]).default("GET"), ...request, ...target },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (a) => {
      if (!isReadOnly(a.method, a.path)) return fail(`${a.method} ${a.path} thay đổi dữ liệu; dùng tiktok_write (cần quyền ghi và anh duyệt).`);
      return run(a.method, a, "read");
    }
  );

  const contentRun = (fn: () => Promise<unknown>) => async (): Promise<CallToolResult> => {
    if (!contentConfigured()) return fail("App Magickids Content chưa cấu hình trên máy chủ (TIKTOK_CONTENT_CLIENT_KEY / SECRET).");
    try {
      return text(await fn());
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  };

  server.registerTool(
    "tiktok_video_status",
    {
      title: "TikTok channel: draft upload status",
      description: "Status of a video pushed to the TikTok channel's drafts (publish_id from tiktok_video_draft).",
      inputSchema: { publish_id: z.string(), channel: z.string().optional().describe("Channel name or open_id; omit if only one") },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (a) => contentRun(() => draftStatus(a.publish_id, a.channel))()
  );

  if (ctx.access !== "read_write") return;

  server.registerTool(
    "tiktok_video_draft",
    {
      title: "TikTok channel: push video to drafts",
      description:
        "Downloads a video from a public direct URL (MP4/MOV/WEBM, 3s–10min) and uploads it to the authorized TikTok " +
        "channel's inbox as a DRAFT (Content Posting API, Upload to TikTok). Nothing goes public: the owner opens the " +
        "TikTok app notification, adds the product link and posts. Tell the owner which video and channel first.",
      inputSchema: {
        video_url: z.string().describe("Public direct link to the video file"),
        channel: z.string().optional().describe("Channel name or open_id; omit if only one"),
        note: z.string().max(500).optional().describe("Internal note, e.g. product code"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async (a) => contentRun(() => uploadDraft({ videoUrl: a.video_url, channel: a.channel, note: a.note, createdBy: `mcp:${ctx.label ?? ctx.id}` }))()
  );


  server.registerTool(
    "tiktok_write",
    {
      title: "TikTok Shop: call a write API",
      description:
        "Calls a TikTok Shop Open API that changes data (edit product/price/stock, promotions, ship orders, " +
        "affiliate, delete). ALWAYS show the owner exactly what will change and get approval before calling.",
      inputSchema: { method: z.enum(["POST", "PUT", "DELETE"]), ...request, ...target },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    async (a) => run(a.method, a, "write")
  );
}
