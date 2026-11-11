/**
 * Autopilot: mã hóa token, khóa refresh, job collect và xác thực job route.
 * Supabase và Shopee được giả lập ở tầng fetch (giống mcp.test.ts).
 */
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

process.env.SUPABASE_URL = "https://supabase.test";
process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role";
process.env.SHOPEE_PARTNER_ID = "1000";
process.env.SHOPEE_PARTNER_KEY = "partner-key";
process.env.TOKEN_ENC_KEY = "test-encryption-key-0123456789abcdef";
process.env.JOB_SECRET = "job-secret";
process.env.AUTOPILOT_SHOPS = "111:Shop A";
delete process.env.TELEGRAM_BOT_TOKEN;

type Row = Record<string, any>;
let tables: Record<string, Row[]>;
let shopeeCalls: string[];
let refreshCalls = 0;

function reset() {
  tables = {
    shopee_tokens: [{ region: "GLOBAL", shop_id: 111, access_token: "at-plain", refresh_token: "rt-plain", expired_at: Date.now() + 3_600_000, refresh_lock_until: null }],
    ads_campaigns: [],
    ads_campaign_history: [],
    ads_campaign_hourly: [],
    ads_shop_hourly: [],
    ads_balance_snapshots: [],
    orders: [],
    job_runs: [],
    alert_state: [],
    autopilot_settings: [{ shop_id: 111, daily_cap_normal: null }],
    audit_log: [],
  };
  shopeeCalls = [];
  refreshCalls = 0;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const PK: Record<string, string[]> = {
  shopee_tokens: ["region", "shop_id"],
  ads_campaigns: ["shop_id", "campaign_id"],
  ads_campaign_hourly: ["shop_id", "campaign_id", "date", "hour"],
  ads_shop_hourly: ["shop_id", "date", "hour"],
  orders: ["order_sn"],
  alert_state: ["key"],
};

function match(row: Row, col: string, expr: string): boolean {
  if (expr.startsWith("eq.")) return String(row[col]) === expr.slice(3);
  if (expr.startsWith("in.(")) return expr.slice(4, -1).split(",").map((s) => s.replace(/"/g, "")).includes(String(row[col]));
  if (expr.startsWith("gte.")) return String(row[col]) >= expr.slice(4);
  if (expr === "is.null") return row[col] == null;
  return true;
}

function filterRows(rows: Row[], q: URLSearchParams) {
  return rows.filter((row) =>
    [...q.entries()].every(([col, expr]) => {
      if (["select", "on_conflict", "order", "limit", "offset", "columns"].includes(col)) return true;
      if (col === "or") {
        // or=(refresh_lock_until.is.null,refresh_lock_until.lt.<iso>)
        return expr
          .slice(1, -1)
          .split(/,(?=refresh_lock_until)/)
          .some((cond) => {
            const [c, op, ...rest] = cond.split(".");
            if (op === "is") return row[c] == null;
            if (op === "lt") return row[c] != null && row[c] < rest.join(".");
            return false;
          });
      }
      return match(row, col, expr);
    })
  );
}

async function fakeSupabase(url: URL, init: RequestInit): Promise<Response> {
  const table = url.pathname.replace("/rest/v1/", "");
  const rows = (tables[table] ??= []);
  const method = init.method ?? "GET";
  const wantsObject = new Headers(init.headers).get("accept")?.includes("vnd.pgrst.object");
  if (method === "GET") {
    const found = filterRows(rows, url.searchParams);
    return wantsObject ? (found[0] ? json(found[0]) : json(null)) : json(found);
  }
  const body = init.body ? JSON.parse(String(init.body)) : {};
  if (method === "POST") {
    const items = Array.isArray(body) ? body : [body];
    for (const item of items) {
      if (table === "job_runs" && item.id == null) item.id = rows.length + 1;
      const pk = PK[table];
      if (pk) {
        const i = rows.findIndex((r) => pk.every((k) => String(r[k]) === String(item[k])));
        if (i >= 0) rows.splice(i, 1, { ...rows[i], ...item });
        else rows.push(item);
      } else rows.push(item);
    }
    return wantsObject ? json(items[0], 201) : json(items, 201);
  }
  if (method === "PATCH") {
    const found = filterRows(rows, url.searchParams);
    found.forEach((r) => Object.assign(r, body));
    return wantsObject ? json(found[0] ?? null) : json(found);
  }
  return new Response(null, { status: 204 });
}

function fakeShopee(url: URL, init: RequestInit): Response {
  const path = url.pathname.replace("/api/v2", "");
  shopeeCalls.push(path);
  const ok = (response: unknown) => json({ error: "", message: "", request_id: "r", response });
  if (path === "/auth/access_token/get") {
    refreshCalls++;
    const body = JSON.parse(String(init.body));
    return json({ access_token: `at-new-${refreshCalls}`, refresh_token: `rt-new-${refreshCalls}`, expire_in: 14400, shop_id: body.shop_id, error: "", request_id: "r" });
  }
  switch (path) {
    case "/ads/get_product_level_campaign_id_list":
      return ok({ has_next_page: false, campaign_list: [{ ad_type: "manual", campaign_id: 1 }, { ad_type: "manual", campaign_id: 2 }] });
    case "/ads/get_product_level_campaign_setting_info":
      return ok({
        campaign_list: [
          { campaign_id: 1, common_info: { ad_name: "Váy A", campaign_status: "ongoing", bidding_method: "auto", campaign_budget: 0, item_id_list: [9] }, auto_bidding_info: { roas_target: 10 } },
          { campaign_id: 2, common_info: { ad_name: "Cũ", campaign_status: "ended", bidding_method: "auto", campaign_budget: 50000, item_id_list: [8] }, auto_bidding_info: { roas_target: 8 } },
        ],
      });
    case "/ads/get_product_campaign_hourly_performance":
      return ok([{ campaign_list: [{ campaign_id: 1, metrics_list: [{ date: url.searchParams.get("performance_date"), hour: 9, impression: 100, clicks: 5, expense: 20000, broad_order: 1, broad_gmv: 250000, direct_order: 1, direct_gmv: 250000 }] }] }]);
    case "/ads/get_all_cpc_ads_hourly_performance":
      return ok([{ date: url.searchParams.get("performance_date"), hour: 9, impression: 100, clicks: 5, expense: 20000, broad_order: 1, broad_gmv: 250000, direct_order: 1, direct_gmv: 250000 }]);
    case "/ads/get_total_balance":
      return ok({ data_timestamp: 1794400000, total_balance: 30000 });
    case "/order/get_order_list":
      return ok({ more: false, next_cursor: "", order_list: [{ order_sn: "SN1", order_status: "READY_TO_SHIP" }] });
    case "/order/get_order_detail":
      assert.equal(url.searchParams.getAll("order_sn_list").length, 1, "order_sn_list must be one comma-joined value");
      return ok({ order_list: [{ order_sn: "SN1", order_status: "READY_TO_SHIP", create_time: 1794400000, total_amount: 250000, item_list: [{ item_id: 9, model_id: 1, model_sku: "V-A-1", model_quantity_purchased: 1, model_discounted_price: 250000 }] }] });
    default:
      return json({ error: "not_found", message: path, request_id: "r" }, 404);
  }
}

globalThis.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
  const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  if (url.hostname === "supabase.test") return fakeSupabase(url, init);
  if (url.hostname === "partner.shopeemobile.com") return fakeShopee(url, init);
  throw new Error(`Unexpected fetch to ${url}`);
}) as typeof fetch;

const { encryptToken, decryptToken } = await import("../src/lib/token-crypto");
const { shopSdk } = await import("../src/lib/shopee");
const { collectJob } = await import("../src/lib/autopilot/jobs");
const { callShopee } = await import("../src/lib/autopilot/shopee-call");
const jobsRoute = await import("../src/app/api/jobs/[job]/route");
const time = await import("../src/lib/autopilot/time");

describe("token encryption", () => {
  beforeEach(reset);

  it("round-trips and still reads plaintext tokens", () => {
    const enc = encryptToken("secret-token");
    assert.match(enc, /^enc:v1:/);
    assert.notEqual(enc, encryptToken("secret-token"));
    assert.equal(decryptToken(enc), "secret-token");
    assert.equal(decryptToken("legacy-plain"), "legacy-plain");
  });

  it("refreshes once under the lock and stores encrypted tokens", async () => {
    tables.shopee_tokens[0].expired_at = Date.now() - 1000;
    const sdk = shopSdk("GLOBAL" as any, 111);
    await sdk.shop.getShopInfo().catch(() => undefined);
    assert.equal(refreshCalls, 1);
    const row = tables.shopee_tokens[0];
    assert.match(row.access_token, /^enc:v1:/);
    assert.equal(decryptToken(row.access_token), "at-new-1");
    assert.equal(row.refresh_lock_until, null);
  });

  it("does not refresh while another process holds the lock", async () => {
    tables.shopee_tokens[0].expired_at = Date.now() - 1000;
    tables.shopee_tokens[0].refresh_lock_until = new Date(Date.now() + 30_000).toISOString();
    const sdk = shopSdk("GLOBAL" as any, 111);
    // Giả lập process khác refresh xong sau 1,5 giây.
    setTimeout(() => {
      Object.assign(tables.shopee_tokens[0], { access_token: encryptToken("at-other"), expired_at: Date.now() + 3_600_000 });
    }, 1500);
    const token = await sdk.refreshToken();
    assert.equal(token?.access_token, "at-other");
    assert.equal(refreshCalls, 0);
  });
});

describe("autopilot collect", () => {
  beforeEach(reset);

  it("collects campaigns, hourly performance, balance and orders", async () => {
    const [result] = await collectJob();
    assert.ok(result.ok, JSON.stringify(result.errors));
    assert.deepEqual(
      tables.ads_campaigns.map((c) => [c.campaign_id, c.campaign_status, c.campaign_budget, c.roas_target]),
      [[1, "ongoing", 0, 10], [2, "ended", 50000, 8]]
    );
    // Lịch sử chỉ ghi chiến dịch đang chạy mới thấy lần đầu.
    assert.equal(tables.ads_campaign_history.length, 1);
    assert.equal(tables.ads_campaign_hourly[0].expense, 20000);
    assert.equal(tables.ads_campaign_hourly[0].date, time.vnDate());
    assert.equal(tables.ads_shop_hourly.length, 1);
    assert.equal(tables.ads_balance_snapshots[0].total_balance, 30000);
    assert.equal(tables.orders[0].items[0].model_sku, "V-A-1");
    assert.equal(tables.job_runs[0].ok, true);
    // Không có lệnh ghi nào được gửi tới Shopee.
    assert.ok(shopeeCalls.every((p) => !/edit|update|create|delete/.test(p)));
  });

  it("skips the hourly campaign scan when the list is fresh", async () => {
    await collectJob();
    const before = shopeeCalls.filter((p) => p.includes("campaign_id_list")).length;
    await collectJob();
    assert.equal(shopeeCalls.filter((p) => p.includes("campaign_id_list")).length, before);
  });

  it("refuses write endpoints in phase 1", async () => {
    await assert.rejects(() => callShopee(111, "ads.edit_gms_product_campaign", {}), /không được phép/);
    assert.equal(shopeeCalls.length, 0);
  });
});

describe("job route", () => {
  beforeEach(reset);

  it("requires the job secret", async () => {
    const call = (auth?: string) =>
      jobsRoute.POST(new Request("https://app.test/api/jobs/collect", { method: "POST", headers: auth ? { Authorization: auth } : {} }), {
        params: Promise.resolve({ job: "collect" }),
      });
    assert.equal((await call()).status, 401);
    assert.equal((await call("Bearer wrong")).status, 401);
    assert.equal((await call("Bearer job-secret")).status, 200);
  });
});

describe("time helpers", () => {
  it("uses Vietnam time", () => {
    // 2026-11-10T17:30:00Z = 00:30 ngày 11/11 giờ VN
    const d = new Date("2026-11-10T17:30:00Z");
    assert.equal(time.vnDate(d), "2026-11-11");
    assert.equal(time.vnHour(d), 0);
    assert.equal(time.apiDate("2026-11-11"), "11-11-2026");
    assert.equal(time.vnDayStartUnix("2026-11-11"), Date.parse("2026-11-10T17:00:00Z") / 1000);
  });
});
