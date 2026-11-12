/**
 * End-to-end test of the /api/mcp route handler. Supabase's REST API and the
 * Shopee API are faked at the fetch level, so the real SDK, MCP transport and
 * access-control code paths all run.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { beforeEach, describe, it } from "node:test";

process.env.SUPABASE_URL = "https://supabase.test";
process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role";
process.env.SHOPEE_PARTNER_ID = "1000";
process.env.SHOPEE_PARTNER_KEY = "partner-key";

const READ_KEY = "smcp_readkey";
const RW_KEY = "smcp_rwkey";
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

type Row = Record<string, unknown>;
let apiKeys: Row[];
let tokens: Row[];
let audit: Row[];
let authRequests: Row[];
let shopeeCalls: { path: string; method: string; query: URLSearchParams; body: unknown }[];
let rpcCalls: { fn: string; args: Row }[];

function reset() {
  apiKeys = [
    { id: "k1", key_hash: sha(READ_KEY), access: "read", region: "GLOBAL", shop_ids: [111, 222], label: null, revoked_at: null },
    { id: "k2", key_hash: sha(RW_KEY), access: "read_write", region: "GLOBAL", shop_ids: [111], label: null, revoked_at: null },
  ];
  tokens = [
    { region: "GLOBAL", shop_id: 111, access_token: "at-111", refresh_token: "rt-111", expired_at: Date.now() + 3_600_000 },
    { region: "GLOBAL", shop_id: 222, access_token: "at-222", refresh_token: "rt-222", expired_at: Date.now() - 1000 },
  ];
  audit = [];
  authRequests = [];
  shopeeCalls = [];
  rpcCalls = [];
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/** Applies PostgREST `col=eq.value` filters from the query string. */
function filterRows(rows: Row[], query: URLSearchParams): Row[] {
  return rows.filter((row) =>
    [...query.entries()].every(([col, expr]) => {
      if (["select", "on_conflict"].includes(col)) return true;
      if (expr.startsWith("eq.")) return String(row[col]) === expr.slice(3);
      if (expr === "is.null") return row[col] == null;
      return true;
    })
  );
}

async function fakeSupabase(url: URL, init: RequestInit): Promise<Response> {
  const table = url.pathname.replace("/rest/v1/", "");
  if (table.startsWith("rpc/")) {
    const fn = table.slice(4);
    rpcCalls.push({ fn, args: JSON.parse(String(init.body ?? "{}")) });
    return json({ fn, ok: true });
  }
  const rows =
    { api_keys: apiKeys, shopee_tokens: tokens, audit_log: audit, auth_requests: authRequests }[table] ?? [];
  const method = init.method ?? "GET";
  const wantsObject = new Headers(init.headers).get("accept")?.includes("vnd.pgrst.object");
  if (method === "GET") {
    const found = filterRows(rows, url.searchParams);
    return wantsObject ? (found[0] ? json(found[0]) : json({}, 406)) : json(found);
  }
  const body = JSON.parse(String(init.body ?? "{}"));
  if (method === "POST") {
    const items = Array.isArray(body) ? body : [body];
    for (const item of items) {
      if (table === "auth_requests") Object.assign(item, { id: `req-${rows.length + 1}`, consumed_at: null });
      if (table === "shopee_tokens") {
        const i = rows.findIndex((r) => r.region === item.region && r.shop_id === item.shop_id);
        if (i >= 0) rows.splice(i, 1);
      }
      rows.push(item);
    }
    if (url.searchParams.has("select")) {
      return wantsObject ? json(items[0], 201) : json(items, 201);
    }
    return new Response(null, { status: 201 });
  }
  if (method === "PATCH") {
    const found = filterRows(rows, url.searchParams);
    found.forEach((r) => Object.assign(r, body));
    if (wantsObject) return found[0] ? json(found[0]) : json({}, 406);
    return json(found);
  }
  return new Response(null, { status: 204 });
}

function fakeShopee(url: URL, init: RequestInit): Response {
  const path = url.pathname.replace("/api/v2", "");
  const body = init.body ? JSON.parse(String(init.body)) : undefined;
  shopeeCalls.push({ path, method: init.method ?? "GET", query: url.searchParams, body });
  if (path === "/auth/token/get") {
    return json({
      access_token: "at-main",
      refresh_token: "rt-main",
      expire_in: 14400,
      shop_id_list: body.main_account_id ? [301, 302] : undefined,
      error: "",
      request_id: "r",
    });
  }
  if (path === "/auth/access_token/get") {
    return json({ access_token: "at-new", refresh_token: "rt-new", expire_in: 14400, shop_id: body.shop_id, error: "", request_id: "r" });
  }
  if (path === "/shop/get_shop_info") {
    return json({ shop_name: `Shop ${url.searchParams.get("shop_id")}`, region: "VN", status: "NORMAL", error: "", request_id: "r" });
  }
  return json({ error: "", message: "", request_id: "r", response: { ok: true } });
}

// Must be installed before the SDK is imported: it captures globalThis.fetch at load time.
globalThis.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
  const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  if (url.hostname === "supabase.test") return fakeSupabase(url, init);
  if (url.hostname === "partner.shopeemobile.com") return fakeShopee(url, init);
  throw new Error(`Unexpected fetch to ${url}`);
}) as typeof fetch;

const { POST } = await import("../src/app/api/mcp/route");
const authStart = await import("../src/app/api/auth/start/route");
const authCallback = await import("../src/app/api/auth/callback/route");

let rpcId = 0;
async function rpc(key: string | null, method: string, params: unknown = {}) {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    "MCP-Protocol-Version": "2025-06-18",
  };
  if (key) headers.Authorization = `Bearer ${key}`;
  const res = await POST(
    new Request("https://app.test/api/mcp", {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
    })
  );
  return { status: res.status, body: (await res.json()) as any };
}

async function callTool(key: string, name: string, args: Record<string, unknown> = {}) {
  const { body } = await rpc(key, "tools/call", { name, arguments: args });
  assert.ok(body.result, `tools/call ${name} failed: ${JSON.stringify(body)}`);
  return body.result as { isError?: boolean; content: { text: string }[] };
}

describe("/api/mcp", () => {
  beforeEach(reset);

  it("rejects requests without a valid key", async () => {
    assert.equal((await rpc(null, "tools/list")).status, 401);
    assert.equal((await rpc("smcp_nope", "tools/list")).status, 401);
    apiKeys[0].revoked_at = new Date().toISOString();
    assert.equal((await rpc(READ_KEY, "tools/list")).status, 401);
  });

  it("hides write tools from read-only keys", async () => {
    const read = (await rpc(READ_KEY, "tools/list")).body.result.tools.map((t: any) => t.name);
    const rw = (await rpc(RW_KEY, "tools/list")).body.result.tools.map((t: any) => t.name);
    for (const name of ["call_write_endpoint", "update_stock", "update_price", "cancel_order", "set_order_note"]) {
      assert.ok(!read.includes(name), `${name} should be hidden`);
      assert.ok(rw.includes(name), `${name} should be visible`);
    }
    assert.ok(read.includes("list_orders") && read.includes("call_read_endpoint"));
  });

  it("exposes Magickids data tools; proposals and inbox only to read_write keys", async () => {
    const read = (await rpc(READ_KEY, "tools/list")).body.result.tools.map((t: any) => t.name);
    const rw = (await rpc(RW_KEY, "tools/list")).body.result.tools.map((t: any) => t.name);
    for (const name of ["mk_get_rules", "mk_query_sales", "mk_list_decisions", "mk_get_products"]) {
      assert.ok(read.includes(name) && rw.includes(name), `${name} should be visible`);
    }
    for (const name of ["mk_create_proposal", "mk_add_to_inbox"]) {
      assert.ok(!read.includes(name), `${name} should be hidden`);
      assert.ok(rw.includes(name), `${name} should be visible`);
    }
  });

  it("calls the mk_* database function with the key as agent", async () => {
    apiKeys[0].label = "chatgpt";
    const result = await callTool(READ_KEY, "mk_query_sales", { from: "2026-11-01", to: "2026-11-11" });
    assert.ok(!result.isError, result.content[0].text);
    assert.deepEqual(rpcCalls.at(-1), {
      fn: "mk_sales",
      args: { p_agent: "chatgpt", p_from: "2026-11-01", p_to: "2026-11-11", p_group: "channel" },
    });
    assert.equal(shopeeCalls.length, 0);
    const bad = await rpc(READ_KEY, "tools/call", { name: "mk_query_sales", arguments: { from: "11/2026", to: "x" } });
    assert.ok(bad.body.error || bad.body.result?.isError);
  });

  it("calls Shopee with the shop's token and writes an audit row", async () => {
    const result = await callTool(READ_KEY, "list_orders", { shop_id: 111, days: 3, order_status: "READY_TO_SHIP" });
    assert.ok(!result.isError, result.content[0].text);
    const call = shopeeCalls.at(-1)!;
    assert.equal(call.path, "/order/get_order_list");
    assert.equal(call.query.get("shop_id"), "111");
    assert.equal(call.query.get("access_token"), "at-111");
    assert.equal(call.query.get("order_status"), "READY_TO_SHIP");
    const from = Number(call.query.get("time_from"));
    const to = Number(call.query.get("time_to"));
    assert.equal(to - from, 3 * 86400);
    assert.deepEqual(
      { endpoint: audit[0].endpoint, shop_id: audit[0].shop_id, ok: audit[0].ok, api_key_id: audit[0].api_key_id },
      { endpoint: "order.get_order_list", shop_id: 111, ok: true, api_key_id: "k1" }
    );
  });

  it("refreshes an expired token before calling Shopee", async () => {
    const result = await callTool(READ_KEY, "get_shop_info", { shop_id: 222 });
    assert.ok(!result.isError, result.content[0].text);
    assert.equal(shopeeCalls[0].path, "/auth/access_token/get");
    assert.equal(shopeeCalls[1].query.get("access_token"), "at-new");
    assert.equal(tokens.find((t) => t.shop_id === 222)?.access_token, "at-new");
  });

  it("enforces the key's shop list", async () => {
    const result = await callTool(RW_KEY, "get_shop_info", { shop_id: 222 });
    assert.ok(result.isError);
    assert.match(result.content[0].text, /not authorized/);
    assert.equal(shopeeCalls.length, 0);
  });

  it("defaults shop_id when the key has a single shop, and requires it otherwise", async () => {
    assert.ok(!(await callTool(RW_KEY, "get_shop_info")).isError);
    const multi = await callTool(READ_KEY, "get_shop_info");
    assert.ok(multi.isError);
    assert.match(multi.content[0].text, /shop_id is required/);
  });

  it("blocks write endpoints for read-only keys via the generic tool", async () => {
    const result = await callTool(READ_KEY, "call_read_endpoint", {
      endpoint: "product.update_stock",
      shop_id: 111,
      params: { item_id: 1 },
    });
    assert.ok(result.isError);
    assert.equal(shopeeCalls.length, 0);
  });

  it("does not expose partner-level endpoints", async () => {
    const result = await callTool(RW_KEY, "call_write_endpoint", {
      endpoint: "public.get_shops_by_partner",
      params: {},
    });
    assert.ok(result.isError);
    assert.match(result.content[0].text, /Unknown endpoint/);
  });

  it("sends write requests with the documented body shape", async () => {
    const result = await callTool(RW_KEY, "update_stock", {
      item_id: 42,
      stock_list: [{ model_id: 7, stock: 5 }, { stock: 1 }],
    });
    assert.ok(!result.isError, result.content[0].text);
    const call = shopeeCalls.at(-1)!;
    assert.equal(call.method, "POST");
    assert.equal(call.path, "/product/update_stock");
    assert.deepEqual(call.body, {
      item_id: 42,
      stock_list: [
        { model_id: 7, seller_stock: [{ stock: 5 }] },
        { model_id: 0, seller_stock: [{ stock: 1 }] },
      ],
    });
    assert.equal(audit.at(-1)?.access, "write");
  });

  it("describes and searches endpoints from the catalog", async () => {
    const search = await callTool(READ_KEY, "search_endpoints", { query: "tracking number" });
    assert.match(search.content[0].text, /logistics\.get_tracking_number/);
    assert.doesNotMatch(search.content[0].text, /"access": "write"/);
    const described = await callTool(READ_KEY, "describe_endpoint", { endpoint: "order.get_order_list" });
    assert.match(described.content[0].text, /time_range_field \(string, required\)/);
  });
});

describe("connect flow", () => {
  beforeEach(reset);

  async function start(access: string) {
    const form = new FormData();
    form.set("region", "GLOBAL");
    form.set("access", access);
    form.set("label", "demo");
    const res = await authStart.POST(new Request("https://app.test/api/auth/start", { method: "POST", body: form }));
    assert.equal(res.status, 303);
    const location = new URL(res.headers.get("location")!);
    assert.equal(location.origin + location.pathname, "https://open.shopee.com/auth");
    const redirect = new URL(location.searchParams.get("redirect_uri")!);
    assert.equal(redirect.pathname, "/api/auth/callback");
    return redirect.searchParams.get("request_id")!;
  }

  async function callback(query: string) {
    const res = await authCallback.GET(new Request(`https://app.test/api/auth/callback?${query}`));
    return { status: res.status, html: await res.text() };
  }

  it("issues a key for a single shop and stores its token", async () => {
    const requestId = await start("read_write");
    const { status, html } = await callback(`request_id=${requestId}&code=abc&shop_id=111`);
    assert.equal(status, 200, html);
    const key = html.match(/smcp_[A-Za-z0-9_-]+/)?.[0];
    assert.ok(key);
    const stored = apiKeys.find((k) => k.key_hash === sha(key));
    assert.deepEqual([stored?.access, stored?.shop_ids, stored?.label], ["read_write", [111], "demo"]);
    assert.equal(tokens.find((t) => t.shop_id === 111)?.access_token, "at-main");
    // The new key works against the MCP endpoint.
    const tools = (await rpc(key, "tools/list")).body.result.tools.map((t: any) => t.name);
    assert.ok(tools.includes("update_stock"));
  });

  it("covers every shop of a main account", async () => {
    const requestId = await start("read");
    const { status, html } = await callback(`request_id=${requestId}&code=abc&main_account_id=9`);
    assert.equal(status, 200, html);
    const key = html.match(/smcp_[A-Za-z0-9_-]+/)![0];
    assert.deepEqual(apiKeys.find((k) => k.key_hash === sha(key))?.shop_ids, [301, 302]);
    assert.deepEqual(tokens.map((t) => t.shop_id).sort(), [111, 222, 301, 302]);
  });

  it("refuses to reuse an authorization request", async () => {
    const requestId = await start("read");
    assert.equal((await callback(`request_id=${requestId}&code=abc&shop_id=111`)).status, 200);
    const again = await callback(`request_id=${requestId}&code=abc&shop_id=111`);
    assert.equal(again.status, 400);
    assert.match(again.html, /expired or was already used/);
  });
});
