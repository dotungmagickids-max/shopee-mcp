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
process.env.TELEGRAM_BOT_TOKEN = "bot-token";
process.env.TELEGRAM_CHAT_ID = "42";
process.env.TELEGRAM_WEBHOOK_SECRET = "wh-secret";
delete process.env.AUTOPILOT_DRY_RUN;

type Row = Record<string, any>;
let tables: Record<string, Row[]>;
let shopeeCalls: string[];
let refreshCalls = 0;
let telegramCalls: { method: string; body: any }[] = [];
const photoMessages = new Set<number>();
let seq = 0;
let editBodies: any[] = [];
let createBodies: any[] = [];
let itemStock = 10;
let returnList: any[] = [];

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
    autopilot_settings: [{ shop_id: 111, daily_cap_normal: null, mode: "suggest", emergency_stop: false, max_increase_pct: 30, max_edits_per_day: 6, start_budget: 100000, rule_params: { auto_scale_up: 0 } }],
    autopilot_actions: [],
    audit_log: [],
  };
  shopeeCalls = [];
  refreshCalls = 0;
  telegramCalls = [];
  editBodies = [];
  createBodies = [];
  itemStock = 10;
  returnList = [];
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
  pancake_variations: ["sku"],
  shopee_returns: ["return_sn"],
  product_classes: ["shop_id", "item_id"],
};

function cmp(a: unknown, b: string): number {
  const na = Number(a);
  const nb = Number(b);
  if (a != null && a !== "" && Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
  return String(a) < b ? -1 : String(a) > b ? 1 : 0;
}

function match(row: Row, col: string, expr: string): boolean {
  if (expr.startsWith("eq.")) return String(row[col]) === expr.slice(3);
  if (expr.startsWith("gt.")) return row[col] != null && cmp(row[col], expr.slice(3)) > 0;
  if (expr.startsWith("lt.")) return row[col] != null && cmp(row[col], expr.slice(3)) < 0;
  if (expr.startsWith("lte.")) return row[col] != null && cmp(row[col], expr.slice(4)) <= 0;
  if (expr.startsWith("like.")) return new RegExp("^" + expr.slice(5).replace(/[%*]/g, ".*") + "$").test(String(row[col] ?? ""));
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
  if (method === "HEAD") {
    const found = filterRows(rows, url.searchParams);
    return new Response(null, { status: 200, headers: { "Content-Range": `0-0/${found.length}` } });
  }
  if (method === "GET") {
    const found = filterRows(rows, url.searchParams);
    return wantsObject ? (found[0] ? json(found[0]) : json(null)) : json(found);
  }
  const body = init.body ? JSON.parse(String(init.body)) : {};
  if (method === "POST") {
    const items = Array.isArray(body) ? body : [body];
    for (const item of items) {
      if (table === "job_runs" && item.id == null) item.id = rows.length + 1;
      if (table === "autopilot_actions") {
        item.id ??= ++seq;
        item.reference_id ??= `ref-${item.id}`;
        item.created_at ??= new Date().toISOString();
        item.parent_id ??= null;
        item.telegram_message_id ??= null;
      }
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
    case "/product/get_item_base_info":
      return ok({ item_list: [{ item_id: Number(url.searchParams.get("item_id_list")), item_status: "NORMAL", image: { image_url_list: ["https://cf.shopee.test/file/a.jpg"] }, stock_info_v2: { summary_info: { total_available_stock: itemStock } } }] });
    case "/returns/get_return_list":
      return ok({ more: false, return: returnList });
    case "/ads/get_product_recommended_roi_target":
      return ok({ exact: { value: 3.5 } });
    case "/ads/create_manual_product_ads":
      createBodies.push(JSON.parse(String(init.body)));
      return ok([{ campaign_id: 999 }]);
    case "/ads/edit_manual_product_ads":
      editBodies.push(JSON.parse(String(init.body)));
      return ok([{ campaign_id: 1 }]);
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
  if (url.hostname === "api.telegram.org") {
    const method = url.pathname.split("/").pop()!;
    const body = JSON.parse(String(init.body ?? "{}"));
    telegramCalls.push({ method, body });
    // Như Telegram thật: tin có ảnh không sửa được bằng editMessageText.
    if (method === "editMessageText" && photoMessages.has(body.message_id)) {
      return json({ ok: false, description: "Bad Request: there is no text in the message to edit" }, 400);
    }
    const messageId = 900 + telegramCalls.length;
    if (method === "sendPhoto") photoMessages.add(messageId);
    return json({ ok: true, result: { message_id: messageId } });
  }
  if (url.hostname === "pos.pages.fm") {
    assert.equal(url.searchParams.get("api_key"), "pancake-key");
    return json({
      success: true,
      total_pages: 1,
      data: [
        { display_id: "BD1 TRANG 130", average_imported_price: 9000, last_imported_price: 100000, retail_price: 250000, product: { name: "Bộ 1" }, variations_warehouses: [{ remain_quantity: 4, selling_avg: 0.5 }, { remain_quantity: 1, selling_avg: 0 }] },
        { display_id: "BD1TRANG140", average_imported_price: 100000, last_imported_price: 0, retail_price: 250000, product: { name: "Bộ 1" }, variations_warehouses: [] },
      ],
    });
  }
  throw new Error(`Unexpected fetch to ${url}`);
}) as typeof fetch;

const { encryptToken, decryptToken } = await import("../src/lib/token-crypto");
const { shopSdk } = await import("../src/lib/shopee");
const { collectJob } = await import("../src/lib/autopilot/jobs");
const { callShopee } = await import("../src/lib/autopilot/shopee-call");
const jobsRoute = await import("../src/app/api/jobs/[job]/route");
const time = await import("../src/lib/autopilot/time");
const actions = await import("../src/lib/autopilot/actions");
const rules = await import("../src/lib/autopilot/rules");
const webhook = await import("../src/app/api/telegram/webhook/route");
const refresh = await import("../src/lib/autopilot/refresh");

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

describe("good hours setting", () => {
  it("parses and formats hour ranges", async () => {
    const { parseHours, formatHours } = await import("../src/lib/autopilot/settings");
    assert.deepEqual(parseHours("0, 8-12, 20-22"), [0, 8, 9, 10, 11, 12, 20, 21, 22]);
    assert.deepEqual(parseHours("0h 8h-12h; 25, x"), [0, 8, 9, 10, 11, 12]);
    assert.equal(formatHours([0, 8, 9, 10, 11, 12, 20, 21, 22]), "0h, 8h–12h, 20h–22h");
  });
});

describe("sale calendar", () => {
  it("classifies days and loosens limits on peak days", async () => {
    const { saleTier, isPeakDay, dailyCap, increaseLimit, editsLimit, DEFAULT_RULE_PARAMS } = await import(
      "../src/lib/autopilot/settings"
    );
    const s: any = {
      sale_dates: ["2026-11-27"],
      mini_sale_days: [1, 15, 20, 25],
      pre_sale_days: 2,
      daily_cap_normal: 30_000_000,
      daily_cap_sale: 80_000_000,
      max_increase_pct: 30,
      max_edits_per_day: 6,
      params: DEFAULT_RULE_PARAMS,
    };
    assert.equal(saleTier(s, "2026-11-11"), "lon");
    assert.equal(saleTier(s, "2026-11-27"), "lon");
    assert.equal(saleTier(s, "2026-11-10"), "truoc");
    assert.equal(saleTier(s, "2026-11-09"), "truoc");
    assert.equal(saleTier(s, "2026-11-25"), "truoc"); // 2 ngày trước 27/11
    assert.equal(saleTier(s, "2026-11-15"), "nho");
    assert.equal(saleTier(s, "2026-11-08"), "thuong");
    assert.equal(saleTier(s, "2026-12-01"), "nho");
    assert.equal(isPeakDay(s, "2026-11-15"), false);
    assert.equal(dailyCap(s, "2026-11-10"), 80_000_000);
    assert.equal(dailyCap(s, "2026-11-15"), 30_000_000);
    assert.equal(increaseLimit(s, "2026-11-11"), 100);
    assert.equal(increaseLimit(s, "2026-11-08"), 30);
    assert.equal(editsLimit(s, "2026-11-11"), 12);
  });
});

describe("fast scale-up helpers", () => {
  it("estimates burn rate, start budgets and auto-run scope", async () => {
    const { burnRate, normalDailySpend, startBudgetFor } = await import("../src/lib/autopilot/rules");
    const { autoRunnable, increaseLimit, DEFAULT_RULE_PARAMS } = await import("../src/lib/autopilot/settings");
    // 0h05: tiêu 30k trong 5 phút → 360k/giờ
    assert.equal(Math.round(burnRate([{ hour: 0, expense: 30_000 }], 0, 5).rate), 360_000);
    // Đã hết tiền (giờ này ~0) → lấy mức tiêu mạnh nhất 3 giờ gần nhất
    assert.equal(burnRate([{ hour: 0, expense: 82_000 }, { hour: 1, expense: 1_000 }], 1, 30).peak, 82_000);
    const s: any = {
      sale_dates: [],
      mini_sale_days: [1, 15, 20, 25],
      pre_sale_days: 2,
      start_budget: 100_000,
      max_increase_pct: 30,
      max_edits_per_day: 6,
      params: DEFAULT_RULE_PARAMS,
    };
    const days = [
      { date: "2026-11-03", exp: 1_000_000, gmv: 0 },
      { date: "2026-11-04", exp: 1_200_000, gmv: 0 },
      { date: "2026-11-11", exp: 30_000_000, gmv: 0 }, // ngày sale lớn: bỏ
      { date: "2026-11-15", exp: 5_000_000, gmv: 0 }, // sale nhỏ: bỏ
    ];
    assert.equal(normalDailySpend(s, days), 1_100_000);
    assert.equal(startBudgetFor(s, 1_100_000), 100_000, "mặc định: mọi chiến dịch về 100k");
    assert.equal(startBudgetFor({ ...s, params: { ...DEFAULT_RULE_PARAMS, start_share_pct: 40 } }, 1_100_000), 440_000);
    assert.equal(startBudgetFor(s, 50_000), 100_000);
    assert.equal(startBudgetFor(s, null), 100_000);
    assert.equal(autoRunnable(s, "rule:scale_up", "change_budget", { budget: 100_000 }, { budget: 200_000 }), true);
    assert.equal(autoRunnable(s, "rule:throttle", "change_budget", { budget: 200_000 }, { budget: 50_000 }), false);
    assert.equal(autoRunnable(s, "rule:reset", "change_budget", { budget: 100_000 }, { budget: 400_000 }), false);
    const { scaleTargetFor } = await import("../src/lib/autopilot/classes");
    // Bộ đồ Annie Baby 12/11: hòa vốn 6,5; lãi 10% cần 12,4; lãi 5% ≈ 8,5; xả kho 3,6
    const e: any = { margin: 0.167, payout: 0.637, cancel_rate: 0.15, return_rate: 0.064, return_fee_ratio: 0.001, ad_fee_pct: 8, class: "thuong" };
    assert.equal(scaleTargetFor(e, DEFAULT_RULE_PARAMS)!.target, 12.4, "bò sữa: tăng khi đủ lãi 10%");
    assert.equal(scaleTargetFor({ ...e, class: "chu_luc" }, DEFAULT_RULE_PARAMS)!.target, 8.5, "ngôi sao: lãi ≥ 5%");
    assert.equal(scaleTargetFor({ ...e, class: "moi" }, DEFAULT_RULE_PARAMS)!.target, 6.5, "dấu hỏi: hòa vốn");
    assert.equal(scaleTargetFor({ ...e, class: "xa_kho" }, DEFAULT_RULE_PARAMS)!.target, 3.6, "chó: QC ≤ 60% tiền thu");
    assert.equal(scaleTargetFor(null, DEFAULT_RULE_PARAMS), null);
    assert.equal(increaseLimit(s, "2026-11-04", true), 100);
    assert.equal(increaseLimit(s, "2026-11-04"), 30);
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

// ---------------------------------------------------------------------------
// Giai đoạn 2: luật, duyệt, thực thi
// ---------------------------------------------------------------------------

function seedCampaign(over: Row = {}) {
  tables.ads_campaigns.push({
    shop_id: 111,
    campaign_id: 1,
    ad_name: "Váy A",
    campaign_status: "ongoing",
    bidding_method: "auto",
    campaign_budget: 100000,
    roas_target: 10,
    item_ids: [9],
    autopilot_excluded: false,
    tool_paused_at: null,
    ...over,
  });
}

function seedHour(hour: number, m: Row) {
  tables.ads_campaign_hourly.push({ shop_id: 111, campaign_id: 1, date: time.vnDate(), hour, impression: 100, clicks: 0, expense: 0, broad_gmv: 0, ...m });
}

describe("rules and actions", () => {
  beforeEach(() => {
    reset();
    delete process.env.AUTOPILOT_DRY_RUN;
  });

  it("proposes a budget increase with Telegram buttons, never sending writes in suggest mode", async () => {
    seedCampaign();
    seedHour(0, { clicks: 20, expense: 85000, broad_gmv: 1_200_000 });
    const res = await rules.evaluateIntraday(111);
    assert.equal(res.proposals, 1);
    const a = tables.autopilot_actions[0];
    assert.deepEqual([a.action, a.status, a.before.budget, a.after.budget, a.source], ["change_budget", "proposed", 100000, 150000, "rule:scale_up"]);
    const msg = telegramCalls.find((t) => t.method === "sendPhoto")!;
    assert.equal(msg.body.photo, "https://cf.shopee.test/file/a.jpg", "đề xuất gửi kèm ảnh đại diện sản phẩm");
    assert.match(msg.body.caption, /Váy A/);
    assert.deepEqual(msg.body.reply_markup.inline_keyboard[0].map((b: any) => b.callback_data), [`a:${a.id}`, `r:${a.id}`]);
    assert.equal(tables.ads_campaigns[0].image_url, "https://cf.shopee.test/file/a.jpg", "ảnh được lưu lại");
    assert.equal(editBodies.length, 0);
    // Chạy lại ngay: cooldown, không đề xuất trùng.
    assert.equal((await rules.evaluateIntraday(111)).proposals, 0);
  });

  it("auto-runs budget increases without Telegram buttons when auto_scale_up is on", async () => {
    process.env.AUTOPILOT_DRY_RUN = "false";
    tables.autopilot_settings[0].rule_params = { auto_scale_up: 1 };
    seedCampaign();
    seedHour(0, { clicks: 20, expense: 99000, broad_gmv: 1_400_000 });
    assert.equal((await rules.evaluateIntraday(111)).proposals, 1);
    const a = tables.autopilot_actions[0];
    assert.deepEqual([a.status, a.decided_by, a.after.fast], ["executed", "auto", true]);
    assert.ok(a.after.budget > 130000, "tiêu hết tiền: được tăng quá 30%");
    assert.equal(editBodies.length, 1);
    assert.equal(telegramCalls.filter((t) => t.method === "sendPhoto").length, 0, "không gửi nút duyệt");
  });

  it("approves in dry-run without calling Shopee and caps the increase", async () => {
    seedCampaign();
    seedHour(0, { clicks: 20, expense: 85000, broad_gmv: 1_200_000 });
    await rules.evaluateIntraday(111);
    const a = tables.autopilot_actions[0];
    const res = await actions.decide(a.id, true, "test");
    assert.ok(res.ok);
    assert.equal(a.status, "dry_run");
    assert.equal(a.after.budget, 130000, "+50% bị giới hạn còn +30%");
    assert.equal(editBodies.length, 0);
    const cap = telegramCalls.find((t) => t.method === "editMessageCaption");
    assert.ok(cap, "tin có ảnh được cập nhật bằng chú thích");
    assert.match(cap.body.caption, /Dry-run/);
  });

  it("executes once with reference_id when dry-run is off, even if approved twice", async () => {
    process.env.AUTOPILOT_DRY_RUN = "false";
    seedCampaign();
    seedHour(0, { clicks: 20, expense: 85000, broad_gmv: 1_200_000 });
    await rules.evaluateIntraday(111);
    const a = tables.autopilot_actions[0];
    await Promise.all([actions.decide(a.id, true, "web"), actions.decide(a.id, true, "telegram")]);
    assert.equal(editBodies.length, 1);
    assert.deepEqual(editBodies[0], { reference_id: a.reference_id, campaign_id: 1, edit_action: "change_budget", budget: 130000 });
    assert.equal(a.status, "executed");
    assert.equal(tables.ads_campaigns[0].campaign_budget, 130000);
  });

  it("respects campaign cap, daily cap and emergency stop", async () => {
    process.env.AUTOPILOT_DRY_RUN = "false";
    seedCampaign({ campaign_budget: 200000 });
    seedCampaign({ campaign_id: 2, campaign_budget: 300000 });
    Object.assign(tables.autopilot_settings[0], { campaign_cap: 220000, daily_cap_normal: 600000, daily_cap_sale: 600000 });
    const s = await (await import("../src/lib/autopilot/settings")).loadSettings(111);
    assert.equal((await actions.guardBudget(s, 1, 200000, 260000)).budget, 220000);
    tables.autopilot_settings[0].campaign_cap = null;
    const s2 = await (await import("../src/lib/autopilot/settings")).loadSettings(111);
    assert.equal((await actions.guardBudget(s2, 1, 200000, 400000)).budget, 260000, "tối đa +30%");
    Object.assign(tables.autopilot_settings[0], { daily_cap_normal: 450000, daily_cap_sale: 450000 });
    const s3 = await (await import("../src/lib/autopilot/settings")).loadSettings(111);
    assert.equal((await actions.guardBudget(s3, 1, 200000, 260000)).budget, null, "trần tổng: 300k + 200k đã vượt 450k");

    tables.autopilot_settings[0].emergency_stop = true;
    const row = (await actions.adminChange({ shop_id: 111, campaign_id: 1, action: "pause", before: {}, after: {}, reason: "t", source: "admin" }));
    assert.equal(row.status, "skipped");
    assert.equal(editBodies.length, 0);
    assert.equal((await rules.evaluateIntraday(111)).proposals, 0);
  });

  it("throttles the budget (instead of pausing) only on a full window of poor hours", async (t) => {
    const hour = time.vnHour();
    if (hour < 3) return t.skip("cần ≥ 3 giờ trọn trong ngày");
    seedCampaign({ campaign_budget: 0 });
    // Chỉ 1 giờ xấu: không phạt.
    seedHour(hour - 1, { clicks: 40, expense: 80000, broad_gmv: 10000 });
    assert.equal((await rules.evaluateIntraday(111)).proposals, 0);
    seedHour(hour - 2, { clicks: 5, expense: 20000, broad_gmv: 0 });
    seedHour(hour - 3, { clicks: 5, expense: 20000, broad_gmv: 0 });
    // Khung 3 giờ trọn: 50 click, chi 120k, ROAS ~0,08 < 40% × 10.
    assert.equal((await rules.evaluateIntraday(111)).proposals, 1);
    const a = tables.autopilot_actions[0];
    // Ngân sách = đã chi hôm nay (120k) + 10k; nhớ mức để nới lại.
    assert.deepEqual(
      [a.action, a.after.budget, a.after.throttle, a.after.restore_budget, a.source],
      ["change_budget", 130000, true, 100000, "rule:throttle"]
    );

    // Thực thi thật → đánh dấu đang siết; 0h nới về mức khởi điểm.
    process.env.AUTOPILOT_DRY_RUN = "false";
    await actions.decide(a.id, true, "test");
    const camp = tables.ads_campaigns[0];
    assert.equal(camp.campaign_budget, 130000);
    assert.ok(camp.throttled_at);
    assert.deepEqual(editBodies[0], { reference_id: a.reference_id, campaign_id: 1, edit_action: "change_budget", budget: 130000 });
    // Đang siết thì luật trong ngày không siết/tăng thêm.
    assert.equal((await rules.evaluateIntraday(111)).proposals, 0);
    const reset = await rules.proposeMidnightReset(111);
    assert.equal(reset.items, 1);
    const child = tables.autopilot_actions.find((r) => r.parent_id === reset.group)!;
    assert.deepEqual([child.action, child.after.budget, child.after.restore], ["change_budget", 100000, true]);
  });

  it("does not pause a campaign whose whole day is still good", async (t) => {
    const hour = time.vnHour();
    if (hour < 4) return t.skip("cần ≥ 4 giờ trong ngày");
    seedCampaign({ campaign_budget: 0 });
    seedHour(hour - 4, { clicks: 50, expense: 200000, broad_gmv: 4_000_000 }); // sáng rất tốt
    seedHour(hour - 1, { clicks: 40, expense: 80000, broad_gmv: 10000 });
    seedHour(hour - 2, { clicks: 5, expense: 20000, broad_gmv: 0 });
    assert.equal((await rules.evaluateIntraday(111)).proposals, 0);
  });

  it("handles Telegram approve buttons only from the configured chat", async () => {
    seedCampaign();
    seedHour(0, { clicks: 20, expense: 85000, broad_gmv: 1_200_000 });
    await rules.evaluateIntraday(111);
    const a = tables.autopilot_actions[0];
    const call = (chat: number, secret = "wh-secret") =>
      webhook.POST(
        new Request("https://app.test/api/telegram/webhook", {
          method: "POST",
          headers: { "X-Telegram-Bot-Api-Secret-Token": secret },
          body: JSON.stringify({ callback_query: { id: "cb1", data: `a:${a.id}`, message: { chat: { id: chat } } } }),
        })
      );
    assert.equal((await call(42, "bad")).status, 403);
    await call(7);
    assert.equal(a.status, "proposed");
    await call(42);
    assert.equal(a.status, "dry_run");
    assert.ok(telegramCalls.some((t) => t.method === "answerCallbackQuery"));
  });
});

describe("campaign refresh", () => {
  beforeEach(() => {
    reset();
    delete process.env.AUTOPILOT_DRY_RUN;
    // Chiến dịch chạy từ 30 ngày trước, 14 ngày qua không có số liệu chi tiêu → "không chạy".
    tables.ads_campaigns.push({
      shop_id: 111, campaign_id: 5, ad_name: "Váy chết", campaign_status: "ongoing", bidding_method: "auto",
      campaign_budget: 0, roas_target: 10, item_ids: [77], start_time: Math.floor(Date.now() / 1000) - 30 * 86400,
      autopilot_excluded: false,
    });
    tables.ads_campaign_daily = [];
  });

  it("proposes a refresh for a dead campaign and needs a human to approve", async () => {
    const res = await refresh.proposeRefresh(111);
    assert.equal((res as any).items, 1);
    const child = tables.autopilot_actions.find((a) => a.action === "refresh")!;
    assert.equal(child.after.item_id, 77);
    assert.equal(child.after.roas_target, 8.5, "không chạy → hạ mục tiêu 15%");
    assert.match(child.after.why, /Shopee gợi ý ROAS 3.5/);
    // Duyệt tự động (chế độ auto) không được làm mới.
    process.env.AUTOPILOT_DRY_RUN = "false";
    await actions.decide(child.parent_id, true, "auto");
    assert.equal(child.status, "skipped");
    assert.equal(editBodies.length + createBodies.length, 0);
  });

  it("stops the old campaign then creates a new one when approved", async () => {
    process.env.AUTOPILOT_DRY_RUN = "false";
    await refresh.proposeRefresh(111);
    const child = tables.autopilot_actions.find((a) => a.action === "refresh")!;
    await actions.decide(child.parent_id, true, "telegram");
    assert.equal(child.status, "executed", child.error);
    assert.deepEqual(editBodies[0], { reference_id: child.reference_id, campaign_id: 5, edit_action: "stop" });
    assert.equal(createBodies[0].item_id, 77);
    assert.equal(createBodies[0].bidding_method, "auto");
    assert.equal(createBodies[0].roas_target, 8.5);
    assert.equal(createBodies[0].budget, 100000);
    assert.equal(createBodies[0].start_date, time.apiDate(time.vnDate()));
    assert.notEqual(createBodies[0].reference_id, child.reference_id);
    assert.equal(tables.ads_campaigns.find((c) => c.campaign_id === 5)!.campaign_status, "ended");
    assert.equal(tables.ads_campaigns.find((c) => c.campaign_id === 999)!.campaign_status, "ongoing");
    assert.equal(child.after.new_campaign_id, 999);
    // Không đề xuất lại cùng sản phẩm trong 14 ngày.
    assert.equal(((await refresh.proposeRefresh(111)) as any).items, 0);
  });

  it("flags out-of-stock products instead of refreshing", async () => {
    itemStock = 0;
    const res = (await refresh.proposeRefresh(111)) as any;
    assert.equal(res.items, 0);
    assert.equal(res.productIssues, 1);
    assert.ok(telegramCalls.some((t) => /HẾT HÀNG/.test(t.body.text ?? "")));
  });
});

describe("live actions while dry-run", () => {
  beforeEach(() => {
    reset();
    delete process.env.AUTOPILOT_DRY_RUN;
    process.env.AUTOPILOT_LIVE_ACTIONS = "change_budget";
    tables.ads_campaigns.push({
      shop_id: 111, campaign_id: 1, ad_name: "Váy A", campaign_status: "ongoing", bidding_method: "auto",
      campaign_budget: 0, roas_target: 10, item_ids: [9], start_time: Math.floor(Date.now() / 1000) - 30 * 86400,
      autopilot_excluded: false,
    });
  });

  it("sends only budget changes to Shopee", async () => {
    const budget = await actions.adminChange({ shop_id: 111, campaign_id: 1, action: "change_budget", before: { budget: 0 }, after: { budget: 200000 }, reason: "t", source: "admin" });
    assert.equal(budget.status, "executed");
    assert.deepEqual(editBodies.map((b) => [b.edit_action, b.budget]), [["change_budget", 200000]]);
    const pause = await actions.adminChange({ shop_id: 111, campaign_id: 1, action: "pause", before: {}, after: {}, reason: "t", source: "admin" });
    assert.equal(pause.status, "dry_run");
    tables.ads_campaign_daily = [];
    await (await import("../src/lib/autopilot/refresh")).proposeRefresh(111);
    const child = tables.autopilot_actions.find((a) => a.action === "refresh")!;
    await actions.decide(child.parent_id, true, "telegram");
    assert.equal(child.status, "dry_run");
    assert.equal(editBodies.length, 1);
    assert.equal(createBodies.length, 0);
    delete process.env.AUTOPILOT_LIVE_ACTIONS;
  });
});

describe("profit from Pancake costs", () => {
  beforeEach(() => {
    reset();
    delete process.env.AUTOPILOT_DRY_RUN;
    process.env.PANCAKE_API_KEY = "pancake-key";
    // Các phép tính cơ bản không có phí nạp / phí hoàn; test riêng bên dưới bật lại.
    tables.autopilot_settings[0].rule_params = { ad_fee_pct: 0, return_fee_per_order: 0 };
    const now = Math.floor(Date.now() / 1000);
    tables.orders = Array.from({ length: 10 }, (_, i) => ({
      shop_id: 111,
      order_sn: `P${i}`,
      create_time: now - 86400,
      order_status: "COMPLETED",
      total_amount: 250000,
      items: [{ item_id: 9, model_sku: i % 2 ? "BD1TRANG130" : "bd1trang140", qty: 1, price: 250000 }],
    }));
  });

  it("syncs Pancake costs and computes break-even and profit ROAS per campaign", async () => {
    const pancake = await import("../src/lib/autopilot/pancake");
    const profit = await import("../src/lib/autopilot/profit");
    const sync = await pancake.syncPancakeVariations();
    assert.deepEqual(sync, { variations: 2, pages: 1 });
    const v = tables.pancake_variations.find((r) => r.sku === "BD1TRANG130")!;
    assert.deepEqual([v.cost, v.stock], [100000, 5], "mã chuẩn hóa, tồn cộng các kho; dùng giá nhập gần nhất, bỏ bình quân bị lệch");
    assert.equal(tables.pancake_variations.find((r) => r.sku === "BD1TRANG140")!.cost, 100000, "không có giá nhập gần nhất thì dùng bình quân");

    seedCampaign({ roas_target: 10 });
    const res: any = await profit.computeEconomics(111);
    assert.equal(res.item_level, 1);
    const econ = tables.ads_campaigns[0].econ;
    // Chưa có escrow: tiền về ước 70%. Giá vốn 40%, lãi mong muốn 10%: hòa vốn 1/0,30 = 3,3; theo lãi 1/0,20 = 5,0
    assert.deepEqual([econ.cost_ratio, econ.payout_estimated, econ.breakeven, econ.target, econ.source], [0.4, true, 3.3, 5, "item"]);
  });

  it("uses real Shopee fees from escrow and cancel/return rates", async () => {
    const pancake = await import("../src/lib/autopilot/pancake");
    const profit = await import("../src/lib/autopilot/profit");
    await pancake.syncPancakeVariations();
    const iso = new Date().toISOString();
    const raw = {
      order_selling_price: 100000,
      commission_fee: 16500,
      service_fee: 6000,
      seller_transaction_fee: 6000,
      ads_escrow_top_up_fee_or_technical_support_fee: 1000,
      withholding_vat_tax: 1000,
      withholding_pit_tax: 500,
    };
    tables.order_escrow = [
      ...Array.from({ length: 25 }, (_, i) => ({ order_sn: `E${i}`, shop_id: 111, escrow_amount: 69000, refund_amount: 0, raw, updated_at: iso })),
      // Đơn bị hoàn tiền: không tính vào tỉ lệ tiền về (đã tính vào tỉ lệ hoàn).
      // (dữ liệu cũ lưu số âm như Shopee trả về)
      { order_sn: "O7", shop_id: 111, escrow_amount: 0, refund_amount: -100000, raw, updated_at: iso },
    ];
    const old = Math.floor(Date.now() / 1000) - 20 * 86400;
    const statuses = ["CANCELLED", "CANCELLED", "TO_RETURN", "COMPLETED", "COMPLETED", "COMPLETED", "COMPLETED", "COMPLETED", "COMPLETED", "COMPLETED", "UNPAID"];
    statuses.forEach((st, i) => tables.orders.push({ shop_id: 111, order_sn: `O${i}`, create_time: old, order_status: st, items: [] }));
    tables.orders.find((o) => o.order_sn === "O0")!.pickup_done_time = old + 3600; // giao thất bại
    // Hủy vì không thanh toán: không tính là đơn đã đặt.
    tables.orders.push({ shop_id: 111, order_sn: "OU", create_time: old, order_status: "CANCELLED", cancel_reason: "Unpaid Order", items: [] });
    seedCampaign({ roas_target: 10 });
    await profit.computeEconomics(111);
    const s0 = tables.autopilot_settings[0].econ_summary;
    assert.deepEqual([s0.cancel_rate, s0.cancel_before_ship_rate, s0.failed_delivery_rate], [0.2, 0.1, 0.1]);
    const econ = tables.ads_campaigns[0].econ;
    // tiền về 69%, hủy 2/10, hoàn 2/8 (1 TO_RETURN + 1 hoàn tiền); giữ = 0,8 × 0,75 = 0,6
    // margin = 0,6 × (0,69 − 0,4) = 0,174 → hòa vốn 5,7; theo lãi 1/(0,174 − 0,06) = 8,8
    assert.deepEqual(
      [econ.payout, econ.payout_estimated, econ.cancel_rate, econ.return_rate, econ.breakeven, econ.target],
      [0.69, false, 0.2, 0.25, 5.7, 8.8]
    );
    const sum = tables.autopilot_settings[0].econ_summary;
    assert.deepEqual(
      sum.fees.fees.map((f: any) => [f.key, Math.round(f.ratio * 1000) / 1000]),
      [["commission", 0.165], ["service", 0.06], ["transaction", 0.06], ["infra", 0.01], ["tax", 0.015]]
    );
  });

  it("measures returns by refunded value from the Shopee returns API", async () => {
    const pancake = await import("../src/lib/autopilot/pancake");
    const profit = await import("../src/lib/autopilot/profit");
    const returns = await import("../src/lib/autopilot/returns");
    await pancake.syncPancakeVariations();
    const old = Math.floor(Date.now() / 1000) - 20 * 86400;
    const statuses = ["CANCELLED", "CANCELLED", "COMPLETED", "COMPLETED", "COMPLETED", "COMPLETED", "COMPLETED", "COMPLETED", "COMPLETED", "COMPLETED"];
    statuses.forEach((st, i) =>
      tables.orders.push({ shop_id: 111, order_sn: `O${i}`, create_time: old, order_status: st, items: [{ item_id: 9, model_sku: "BD1TRANG130", qty: 1, price: 250000 }] })
    );
    const ret = (sn: string, order: string, status: string, refund: number, extra: Record<string, unknown>) => ({
      return_sn: sn, order_sn: order, status, refund_amount: refund, reason: "DIFFERENT_DESCRIPTION", create_time: old + 86400, update_time: old + 2 * 86400,
      needs_logistics: true, return_solution: 0, item: [{ item_id: 9, variation_sku: "BD1TRANG130", amount: 1, refund_amount: refund, item_price: 250000 }], ...extra,
    });
    returnList = [
      ret("R1", "O3", "ACCEPTED", 250000, {}),
      ret("R2", "O4", "ACCEPTED", 100000, { reason: "WRONG_SIZE", needs_logistics: false, return_solution: 1 }),
      ret("R3", "O5", "CANCELLED", 250000, {}), // yêu cầu bị hủy: không tính
    ];
    assert.deepEqual(await returns.syncReturns(111), { returns: 3 });
    assert.equal(tables.shopee_returns.find((r) => r.return_sn === "R2")!.create_time, old + 86400);

    seedCampaign({ roas_target: 10 });
    await profit.computeEconomics(111);
    const econ = tables.ads_campaigns[0].econ;
    // hủy 0,2; hoàn 350k / 2tr = 0,175, trong đó có hàng về 250k = 0,125; tiền về ước 0,7; giá vốn 0,4
    // margin = 0,8 × (0,7 × 0,825 − 0,4 × 0,875) = 0,182 → hòa vốn 5,5; theo lãi 1/(0,182 − 0,8 × 0,825 × 0,1) = 8,6
    assert.deepEqual([econ.cancel_rate, econ.return_rate, econ.return_back_rate, econ.breakeven, econ.target], [0.2, 0.175, 0.125, 5.5, 8.6]);
    const sum = tables.autopilot_settings[0].econ_summary;
    assert.equal(sum.return_source, "returns");
    assert.deepEqual(sum.return_reasons.map((r: any) => [r.label, r.ratio]), [["Khác mô tả", 0.714], ["Sai size", 0.286]]);

    // Bật phí nạp ví 8% và phí hoàn 2.700đ/đơn (1 đơn có hàng gửi về trên 2tr giá bán = 0,135%).
    tables.autopilot_settings[0].rule_params = { ad_fee_pct: 8, return_fee_per_order: 2700 };
    await profit.computeEconomics(111);
    const e2 = tables.ads_campaigns[0].econ;
    // margin = 0,8 × (0,5775 − 0,35 − 0,00135) = 0,1809 → hòa vốn 1,08/0,1809 = 6,0; theo lãi 1,08/(0,1809 − 0,066) = 9,4
    assert.deepEqual([e2.return_fee_ratio, e2.ad_fee_pct, e2.breakeven, e2.target], [0.0014, 8, 6, 9.4]);
  });

  it("uses profit ROAS in rules and walks the ROAS target down toward it", async () => {
    const pancake = await import("../src/lib/autopilot/pancake");
    const profit = await import("../src/lib/autopilot/profit");
    await pancake.syncPancakeVariations();
    seedCampaign({ roas_target: 10 });
    await profit.computeEconomics(111);

    // ROAS hôm nay 5,3: dưới mục tiêu đang đặt (10) nhưng trên ROAS theo lãi (5) → được tăng ngân sách.
    seedHour(0, { clicks: 20, expense: 85000, broad_gmv: 450000 });
    assert.equal((await rules.evaluateIntraday(111)).proposals, 1);
    const up = tables.autopilot_actions[0];
    assert.equal(up.source, "rule:scale_up");
    assert.match(up.reason, /thường \(bò sữa\): lãi 10%/);

    tables.ads_campaign_daily = [];
    await rules.proposeRoasTargets(111);
    const roas = tables.autopilot_actions.find((a) => a.action === "change_roas_target")!;
    assert.deepEqual([roas.before.roas_target, roas.after.roas_target], [10, 8.5], "hạ tối đa 15% mỗi lần, hướng về 5");
    assert.match(roas.after.why, /hòa vốn 3.3/);
  });

  it("classifies products and sets the ROAS target per class", async () => {
    const classes = await import("../src/lib/autopilot/classes");
    const settings = await import("../src/lib/autopilot/settings");
    const p = settings.DEFAULT_RULE_PARAMS;
    const base = { units30: 10, stock: 30, dailySales: 1, categories: new Set<string>(), ageDays: 200, costRatio: 0.3, month: 11 };
    assert.equal(classes.classify({ ...base, ageDays: 10 }, p).cls, "moi");
    assert.equal(classes.classify({ ...base, stock: 200, dailySales: 1 }, p).cls, "xa_kho", "tồn đủ bán 200 ngày");
    assert.equal(classes.classify({ ...base, categories: new Set(["Bé trai", "Xuân hè"]) }, p).cls, "xa_kho", "hàng hè vào tháng 11");
    assert.equal(classes.classify({ ...base, categories: new Set(["Thu đông"]) }, p).cls, "thuong");
    assert.equal(classes.classify({ ...base, units30: 80, stock: 100, dailySales: 3 }, p).cls, "chu_luc");
    assert.equal(classes.classify({ ...base, units30: 80, costRatio: 0.45 }, p).cls, "thuong", "giá vốn cao không vào chủ lực");

    // Xả kho: tiền thu về 0,7/1đ GMV, QC được dùng 60% → ROAS 1/0,42 = 2,4
    const e = { margin: 0.3, cancel_rate: 0, return_rate: 0, payout: 0.7, return_fee_ratio: 0, ad_fee_pct: 0 };
    assert.equal(classes.targetForClass(e, "xa_kho", p).target, 2.4);
    assert.equal(classes.targetForClass(e, "moi", p).target, 3.3, "mới: hòa vốn");
    assert.equal(classes.targetForClass(e, "chu_luc", p).target, 4.5, "chủ lực lãi 8%: 1/(0,3 − 0,08)");

    // Chọn tay trên dashboard: áp ngay ROAS mục tiêu của nhóm mới.
    const pancake = await import("../src/lib/autopilot/pancake");
    const profit = await import("../src/lib/autopilot/profit");
    await pancake.syncPancakeVariations();
    seedCampaign({ roas_target: 10 });
    await profit.computeEconomics(111);
    assert.equal(tables.ads_campaigns[0].econ.class, "thuong");
    await profit.setProductClass(111, 1, "xa_kho");
    const econ = tables.ads_campaigns[0].econ;
    assert.deepEqual([econ.class, econ.class_source, econ.target], ["xa_kho", "manual", 2.4]);
    await profit.computeEconomics(111);
    assert.equal(tables.ads_campaigns[0].econ.class, "xa_kho", "job đêm giữ lựa chọn của anh");
    await profit.setProductClass(111, 1, null);
    assert.deepEqual([tables.ads_campaigns[0].econ.class, tables.ads_campaigns[0].econ.target], ["thuong", 5]);
  });

  it("falls back to the configured ROAS target when profit ROAS is turned off", async () => {
    tables.autopilot_settings[0].rule_params = { use_profit_roas: 0 };
    const pancake = await import("../src/lib/autopilot/pancake");
    const profit = await import("../src/lib/autopilot/profit");
    await pancake.syncPancakeVariations();
    seedCampaign({ roas_target: 10 });
    await profit.computeEconomics(111);
    seedHour(0, { clicks: 20, expense: 85000, broad_gmv: 450000 });
    assert.equal((await rules.evaluateIntraday(111)).proposals, 0);
  });
});
