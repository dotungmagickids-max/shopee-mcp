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
let seq = 0;
let editBodies: any[] = [];

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
    autopilot_settings: [{ shop_id: 111, daily_cap_normal: null, mode: "suggest", emergency_stop: false, max_increase_pct: 30, max_edits_per_day: 6, start_budget: 100000, rule_params: {} }],
    autopilot_actions: [],
    audit_log: [],
  };
  shopeeCalls = [];
  refreshCalls = 0;
  telegramCalls = [];
  editBodies = [];
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
    telegramCalls.push({ method: url.pathname.split("/").pop()!, body: JSON.parse(String(init.body ?? "{}")) });
    return json({ ok: true, result: { message_id: 900 + telegramCalls.length } });
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
    const msg = telegramCalls.find((t) => t.method === "sendMessage")!;
    assert.deepEqual(msg.body.reply_markup.inline_keyboard[0].map((b: any) => b.callback_data), [`a:${a.id}`, `r:${a.id}`]);
    assert.equal(editBodies.length, 0);
    // Chạy lại ngay: cooldown, không đề xuất trùng.
    assert.equal((await rules.evaluateIntraday(111)).proposals, 0);
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
    assert.ok(telegramCalls.some((t) => t.method === "editMessageText"));
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
