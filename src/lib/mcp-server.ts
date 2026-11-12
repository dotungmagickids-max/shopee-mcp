import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { ApiKeyContext } from "./api-keys";
import { catalog } from "./catalog.generated";
import type { CatalogEntry, CatalogParam } from "./catalog-types";
import { registerMagickidsTools } from "./magickids-tools";
import { shopSdk } from "./shopee";
import { db } from "./supabase";

const MAX_RESULT_CHARS = 100_000;
const MAX_BINARY_BYTES = 2 * 1024 * 1024;
const DAY = 24 * 60 * 60;

const endpointsById = new Map(catalog.map((e) => [e.id, e]));

class ToolError extends Error {}

/**
 * Duck-typed check for the SDK's ShopeeApiError, which isn't exposed through the
 * package's `exports` map.
 */
function isShopeeApiError(err: unknown): err is Error & { status: number; data: unknown } {
  return err instanceof Error && err.name === "ShopeeApiError" && "status" in err && "data" in err;
}

function text(value: unknown): CallToolResult {
  let body = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  if (body.length > MAX_RESULT_CHARS) {
    body =
      body.slice(0, MAX_RESULT_CHARS) +
      `\n\n[truncated ${body.length - MAX_RESULT_CHARS} characters — narrow the request, e.g. smaller page_size]`;
  }
  return { content: [{ type: "text", text: body }] };
}

function errorResult(err: unknown): CallToolResult {
  let message: string;
  if (isShopeeApiError(err)) {
    message = `Shopee API error (HTTP ${err.status}): ${JSON.stringify(err.data)}`;
  } else if (err instanceof Error) {
    message = err.message;
  } else {
    message = String(err);
  }
  return { isError: true, content: [{ type: "text", text: message }] };
}

/** Wraps a tool handler so thrown errors become MCP error results instead of protocol errors. */
function safe<A>(fn: (args: A) => Promise<CallToolResult>) {
  return async (args: A): Promise<CallToolResult> => {
    try {
      return await fn(args);
    } catch (err) {
      return errorResult(err);
    }
  };
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function visibleEndpoints(ctx: ApiKeyContext): CatalogEntry[] {
  return ctx.access === "read_write" ? catalog : catalog.filter((e) => e.access === "read");
}

function summarize(e: CatalogEntry) {
  return {
    endpoint: e.id,
    access: e.access,
    description: e.description.length > 160 ? `${e.description.slice(0, 159)}…` : e.description,
  };
}

function formatParams(params: CatalogParam[], indent = ""): string {
  return params
    .map((p) => {
      const line = `${indent}- ${p.name} (${p.type}${p.required ? ", required" : ""})${
        p.description ? `: ${p.description}` : ""
      }`;
      return p.children?.length ? `${line}\n${formatParams(p.children, `${indent}  `)}` : line;
    })
    .join("\n");
}

function normalizeResult(result: unknown): unknown {
  if (Buffer.isBuffer(result)) {
    if (result.length > MAX_BINARY_BYTES) {
      return { binary: true, size_bytes: result.length, note: "File too large to return inline." };
    }
    return { binary: true, size_bytes: result.length, base64: result.toString("base64") };
  }
  return result;
}

/**
 * Builds a per-request MCP server bound to one API key.
 * Every Shopee call goes through `callEndpoint`, which enforces the key's
 * shop list and access level and writes an audit log row.
 */
export function createMcpServer(ctx: ApiKeyContext): McpServer {
  const server = new McpServer(
    { name: "shopee-mcp", version: "0.1.0" },
    {
      instructions: [
        "Tools for a Shopee seller's shop(s), backed by the Shopee Open Platform API v2.",
        `This key has ${ctx.access === "read_write" ? "read + write" : "read-only"} access to ${
          ctx.shopIds.length
        } shop(s) in region ${ctx.region}.`,
        "Prefer the task-specific tools (list_orders, get_order_details, …).",
        "For anything else use search_endpoints → describe_endpoint → call_read_endpoint / call_write_endpoint.",
        "Timestamps in requests are unix seconds. Always confirm with the user before calling write tools.",
        "Magickids company data (all channels, not only Shopee): mk_get_rules first, then mk_query_sales, " +
          "mk_product_profit, mk_get_products, mk_list_decisions, mk_search_knowledge, mk_find_cases. " +
          "Changes to real systems go through mk_create_proposal for the owner to approve.",
      ].join("\n"),
    }
  );

  const canWrite = ctx.access === "read_write";
  const shopIdArg = z
    .number()
    .int()
    .optional()
    .describe("Shop to act on. May be omitted when the key has exactly one shop (see list_shops).");

  function resolveShop(shopId: number | undefined): number {
    if (shopId === undefined) {
      if (ctx.shopIds.length === 1) return ctx.shopIds[0];
      throw new ToolError(`shop_id is required; this key has shops ${ctx.shopIds.join(", ")}.`);
    }
    if (!ctx.shopIds.includes(shopId)) {
      throw new ToolError(`Shop ${shopId} is not authorized for this key.`);
    }
    return shopId;
  }

  async function callEndpoint(
    endpointId: string,
    shopIdInput: number | undefined,
    params: Record<string, unknown>
  ): Promise<CallToolResult> {
    const entry = endpointsById.get(endpointId);
    if (!entry) {
      throw new ToolError(`Unknown endpoint "${endpointId}". Use search_endpoints to find one.`);
    }
    if (entry.access === "write" && !canWrite) {
      throw new ToolError(`"${endpointId}" modifies shop data and this key is read-only.`);
    }
    const shopId = resolveShop(shopIdInput);
    const sdk = shopSdk(ctx.region, shopId);
    const manager = (sdk as unknown as Record<string, Record<string, unknown>>)[entry.sdkProperty];
    const method = manager?.[entry.sdkMethod];
    if (typeof method !== "function") {
      throw new ToolError(`The installed SDK has no method for "${endpointId}".`);
    }

    const started = Date.now();
    let ok = false;
    let errorMessage: string | null = null;
    try {
      const result = await (method as (p: unknown) => Promise<unknown>).call(manager, params);
      ok = true;
      return text(normalizeResult(result));
    } catch (err) {
      errorMessage = isShopeeApiError(err) ? JSON.stringify(err.data) : String(err);
      throw err;
    } finally {
      await db()
        .from("audit_log")
        .insert({
          api_key_id: ctx.id,
          shop_id: shopId,
          endpoint: endpointId,
          access: entry.access,
          ok,
          error: errorMessage?.slice(0, 1000) ?? null,
          duration_ms: Date.now() - started,
        })
        .then(undefined, () => undefined);
    }
  }

  // ---------------------------------------------------------------------------
  // Discovery
  // ---------------------------------------------------------------------------

  server.registerTool(
    "list_shops",
    {
      title: "List shops",
      description: "List the shops this API key can access, with basic shop info.",
      annotations: { readOnlyHint: true },
    },
    safe(async () => {
      const shops = await Promise.all(
        ctx.shopIds.map(async (shopId) => {
          try {
            const info = (await shopSdk(ctx.region, shopId).shop.getShopInfo()) as unknown as Record<
              string,
              unknown
            >;
            return { shop_id: shopId, shop_name: info.shop_name, region: info.region, status: info.status };
          } catch (err) {
            return { shop_id: shopId, error: errorResult(err).content[0] };
          }
        })
      );
      return text({ api_region: ctx.region, access: ctx.access, shops });
    })
  );

  server.registerTool(
    "list_api_modules",
    {
      title: "List API modules",
      description: "List Shopee API modules (order, product, logistics, …) with endpoint counts.",
      annotations: { readOnlyHint: true },
    },
    safe(async () => {
      const modules = new Map<string, { read: number; write: number }>();
      for (const e of visibleEndpoints(ctx)) {
        const m = modules.get(e.module) ?? { read: 0, write: 0 };
        m[e.access]++;
        modules.set(e.module, m);
      }
      return text(
        [...modules.entries()].map(([module, counts]) => ({ module, ...counts }))
      );
    })
  );

  server.registerTool(
    "search_endpoints",
    {
      title: "Search endpoints",
      description:
        "Search Shopee API endpoints by keyword (matches name and description). Returns endpoint ids for describe_endpoint.",
      inputSchema: {
        query: z.string().optional().describe("Keywords, e.g. 'shipping label' or 'discount'"),
        module: z.string().optional().describe("Limit to one module, e.g. 'order'"),
        limit: z.number().int().min(1).max(100).default(30),
      },
      annotations: { readOnlyHint: true },
    },
    safe(async ({ query, module, limit }) => {
      const words = (query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
      const matches = visibleEndpoints(ctx)
        .filter((e) => !module || e.module === module)
        .map((e) => {
          const haystack = `${e.id.replace(/_/g, " ")} ${e.description}`.toLowerCase();
          const nameHits = words.filter((w) => e.id.includes(w)).length;
          const hits = words.filter((w) => haystack.includes(w)).length;
          return { e, score: hits * 2 + nameHits };
        })
        .filter((m) => words.length === 0 || m.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit)
        .map((m) => summarize(m.e));
      return text(matches.length ? matches : "No matching endpoints.");
    })
  );

  server.registerTool(
    "describe_endpoint",
    {
      title: "Describe endpoint",
      description: "Show the request parameters and response fields of a Shopee endpoint.",
      inputSchema: { endpoint: z.string().describe("Endpoint id, e.g. 'order.get_order_list'") },
      annotations: { readOnlyHint: true },
    },
    safe(async ({ endpoint }) => {
      const e = endpointsById.get(endpoint);
      if (!e) throw new ToolError(`Unknown endpoint "${endpoint}".`);
      return text(
        [
          `# ${e.id} (${e.access}, ${e.httpMethod} /api/v2${e.path})`,
          e.description,
          `Call with: ${e.access === "read" ? "call_read_endpoint" : "call_write_endpoint"}${
            e.access === "write" && !canWrite ? " (not available: this key is read-only)" : ""
          }`,
          "## Request params (shop_id/access_token/sign are added automatically)",
          e.request.length ? formatParams(e.request) : "(none)",
          "## Response fields",
          e.response.length ? formatParams(e.response) : "(not documented)",
        ].join("\n\n")
      );
    })
  );

  const callArgs = {
    endpoint: z.string().describe("Endpoint id from search_endpoints, e.g. 'order.get_order_list'"),
    shop_id: shopIdArg,
    params: z
      .record(z.string(), z.unknown())
      .default({})
      .describe("Request parameters as documented by describe_endpoint (timestamps in unix seconds)"),
  };

  server.registerTool(
    "call_read_endpoint",
    {
      title: "Call a read endpoint",
      description: "Call any read-only Shopee endpoint (get_/search_/check_… endpoints).",
      inputSchema: callArgs,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    safe(async ({ endpoint, shop_id, params }) => {
      if (endpointsById.get(endpoint)?.access === "write") {
        throw new ToolError(`"${endpoint}" modifies data; use call_write_endpoint.`);
      }
      return callEndpoint(endpoint, shop_id, params);
    })
  );

  if (canWrite) {
    server.registerTool(
      "call_write_endpoint",
      {
        title: "Call a write endpoint",
        description:
          "Call any Shopee endpoint that changes shop data (update, add, delete, ship, cancel…). Confirm with the user first.",
        inputSchema: callArgs,
        annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
      },
      safe(async ({ endpoint, shop_id, params }) => callEndpoint(endpoint, shop_id, params))
    );
  }

  // ---------------------------------------------------------------------------
  // Task-specific read tools
  // ---------------------------------------------------------------------------

  const ro = { readOnlyHint: true, openWorldHint: true } as const;

  server.registerTool(
    "get_shop_info",
    {
      title: "Get shop info",
      description: "Shop name, region, status and account flags.",
      inputSchema: { shop_id: shopIdArg },
      annotations: ro,
    },
    safe(async ({ shop_id }) => callEndpoint("shop.get_shop_info", shop_id, {}))
  );

  server.registerTool(
    "list_orders",
    {
      title: "List orders",
      description:
        "List order numbers (order_sn) in a time window of at most 15 days. Use get_order_details for full data.",
      inputSchema: {
        shop_id: shopIdArg,
        days: z.number().int().min(1).max(15).default(7).describe("Look back this many days (ignored if time_from is set)"),
        time_from: z.number().int().optional().describe("Unix seconds"),
        time_to: z.number().int().optional().describe("Unix seconds, defaults to now"),
        time_range_field: z.enum(["create_time", "update_time"]).default("create_time"),
        order_status: z
          .enum([
            "UNPAID",
            "READY_TO_SHIP",
            "PROCESSED",
            "SHIPPED",
            "COMPLETED",
            "IN_CANCEL",
            "CANCELLED",
            "INVOICE_PENDING",
          ])
          .optional(),
        page_size: z.number().int().min(1).max(100).default(50),
        cursor: z.string().optional(),
      },
      annotations: ro,
    },
    safe(async (a) => {
      const timeTo = a.time_to ?? nowSeconds();
      return callEndpoint("order.get_order_list", a.shop_id, {
        time_range_field: a.time_range_field,
        time_from: a.time_from ?? timeTo - a.days * DAY,
        time_to: timeTo,
        page_size: a.page_size,
        cursor: a.cursor,
        order_status: a.order_status,
        response_optional_fields: "order_status",
      });
    })
  );

  server.registerTool(
    "get_order_details",
    {
      title: "Get order details",
      description: "Full details (buyer, items, amounts, shipping, status) for up to 50 orders.",
      inputSchema: {
        shop_id: shopIdArg,
        order_sn_list: z.array(z.string()).min(1).max(50),
      },
      annotations: ro,
    },
    safe(async ({ shop_id, order_sn_list }) =>
      callEndpoint("order.get_order_detail", shop_id, {
        order_sn_list,
        response_optional_fields: [
          "buyer_user_id",
          "buyer_username",
          "estimated_shipping_fee",
          "recipient_address",
          "actual_shipping_fee",
          "note",
          "item_list",
          "pay_time",
          "buyer_cancel_reason",
          "cancel_by",
          "cancel_reason",
          "fulfillment_flag",
          "pickup_done_time",
          "package_list",
          "shipping_carrier",
          "payment_method",
          "total_amount",
          "return_request_due_date",
        ].join(","),
      })
    )
  );

  server.registerTool(
    "get_order_income",
    {
      title: "Get order income",
      description: "Escrow/income breakdown of an order: buyer paid, fees, commissions, seller payout.",
      inputSchema: { shop_id: shopIdArg, order_sn: z.string() },
      annotations: ro,
    },
    safe(async ({ shop_id, order_sn }) => callEndpoint("payment.get_escrow_detail", shop_id, { order_sn }))
  );

  server.registerTool(
    "get_tracking_info",
    {
      title: "Get tracking info",
      description: "Logistics tracking history of an order.",
      inputSchema: {
        shop_id: shopIdArg,
        order_sn: z.string(),
        package_number: z.string().optional(),
      },
      annotations: ro,
    },
    safe(async ({ shop_id, ...params }) => callEndpoint("logistics.get_tracking_info", shop_id, params))
  );

  server.registerTool(
    "list_products",
    {
      title: "List products",
      description: "List item ids in the shop. Use get_products for names, prices and stock.",
      inputSchema: {
        shop_id: shopIdArg,
        item_status: z
          .array(z.enum(["NORMAL", "BANNED", "UNLIST", "REVIEWING", "SELLER_DELETE", "SHOPEE_DELETE"]))
          .default(["NORMAL"]),
        offset: z.number().int().min(0).default(0),
        page_size: z.number().int().min(1).max(100).default(50),
      },
      annotations: ro,
    },
    safe(async ({ shop_id, ...params }) => callEndpoint("product.get_item_list", shop_id, params))
  );

  server.registerTool(
    "get_products",
    {
      title: "Get products",
      description: "Base info (name, status, price, stock, images, attributes) for up to 50 items.",
      inputSchema: { shop_id: shopIdArg, item_id_list: z.array(z.number().int()).min(1).max(50) },
      annotations: ro,
    },
    safe(async ({ shop_id, item_id_list }) =>
      callEndpoint("product.get_item_base_info", shop_id, { item_id_list })
    )
  );

  server.registerTool(
    "get_product_models",
    {
      title: "Get product variations",
      description: "Variations (models) of an item with their model_id, price and stock.",
      inputSchema: { shop_id: shopIdArg, item_id: z.number().int() },
      annotations: ro,
    },
    safe(async ({ shop_id, item_id }) => callEndpoint("product.get_model_list", shop_id, { item_id }))
  );

  server.registerTool(
    "list_returns",
    {
      title: "List returns",
      description: "Return/refund requests, newest first.",
      inputSchema: {
        shop_id: shopIdArg,
        days: z.number().int().min(1).max(15).default(15).describe("Created within the last N days"),
        status: z
          .enum(["REQUESTED", "ACCEPTED", "CANCELLED", "JUDGING", "CLOSED", "PROCESSING", "SELLER_DISPUTE"])
          .optional(),
        page_no: z.number().int().min(0).default(0),
        page_size: z.number().int().min(1).max(100).default(20),
      },
      annotations: ro,
    },
    safe(async ({ shop_id, days, ...params }) => {
      const now = nowSeconds();
      return callEndpoint("returns.get_return_list", shop_id, {
        ...params,
        create_time_from: now - days * DAY,
        create_time_to: now,
      });
    })
  );

  // ---------------------------------------------------------------------------
  // Task-specific write tools (read_write keys only)
  // ---------------------------------------------------------------------------

  if (canWrite) {
    const rw = { readOnlyHint: false, destructiveHint: true, openWorldHint: true } as const;

    server.registerTool(
      "update_stock",
      {
        title: "Update stock",
        description: "Set seller stock of an item or of specific variations (model_id from get_product_models).",
        inputSchema: {
          shop_id: shopIdArg,
          item_id: z.number().int(),
          stock_list: z
            .array(
              z.object({
                model_id: z.number().int().optional().describe("Omit or 0 for items without variations"),
                stock: z.number().int().min(0),
                location_id: z.string().optional(),
              })
            )
            .min(1),
        },
        annotations: rw,
      },
      safe(async ({ shop_id, item_id, stock_list }) =>
        callEndpoint("product.update_stock", shop_id, {
          item_id,
          stock_list: stock_list.map((s) => ({
            model_id: s.model_id ?? 0,
            seller_stock: [{ stock: s.stock, ...(s.location_id ? { location_id: s.location_id } : {}) }],
          })),
        })
      )
    );

    server.registerTool(
      "update_price",
      {
        title: "Update price",
        description: "Set the original price of an item or of specific variations.",
        inputSchema: {
          shop_id: shopIdArg,
          item_id: z.number().int(),
          price_list: z
            .array(
              z.object({
                model_id: z.number().int().optional().describe("Omit or 0 for items without variations"),
                original_price: z.number().positive(),
              })
            )
            .min(1),
        },
        annotations: rw,
      },
      safe(async ({ shop_id, item_id, price_list }) =>
        callEndpoint("product.update_price", shop_id, {
          item_id,
          price_list: price_list.map((p) => ({ model_id: p.model_id ?? 0, original_price: p.original_price })),
        })
      )
    );

    server.registerTool(
      "set_order_note",
      {
        title: "Set order note",
        description: "Set the seller's private note on an order.",
        inputSchema: { shop_id: shopIdArg, order_sn: z.string(), note: z.string().max(500) },
        annotations: { ...rw, destructiveHint: false, idempotentHint: true },
      },
      safe(async ({ shop_id, ...params }) => callEndpoint("order.set_note", shop_id, params))
    );

    server.registerTool(
      "cancel_order",
      {
        title: "Cancel order",
        description: "Cancel an unshipped order. Irreversible — confirm with the user first.",
        inputSchema: {
          shop_id: shopIdArg,
          order_sn: z.string(),
          cancel_reason: z.enum(["OUT_OF_STOCK", "UNDELIVERABLE_AREA"]),
          item_list: z
            .array(z.object({ item_id: z.number().int(), model_id: z.number().int() }))
            .optional()
            .describe("Required when cancel_reason is OUT_OF_STOCK: the out-of-stock items"),
        },
        annotations: rw,
      },
      safe(async ({ shop_id, ...params }) => callEndpoint("order.cancel_order", shop_id, params))
    );
  }

  registerMagickidsTools(server, ctx);

  return server;
}
