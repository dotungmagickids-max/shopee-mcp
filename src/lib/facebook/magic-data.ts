/**
 * FB Magic Tool — đọc số thật (chỉ đọc): Meta (chi, tin nhắn, ngân sách) + Pancake POS (đơn theo ad_id)
 * + tồn kho (pancake_variations) + bảng trần (fb_ceilings). Không có lệnh ghi lên Meta.
 */
import { unstable_cache } from "next/cache";
import { db } from "../supabase";
import { loadStock } from "./jobs";
import { DEFAULT_CEILING, type AdRow, type Ceiling } from "./magic";
import { adInsightsRange, adsInfo, listAccounts } from "./meta";
import { ordersByAdRange } from "./orders";

export const PAGES: Record<string, string> = {
  "159993608025607": "Magic Kids",
  "458712413984606": "Magickids Store",
  "341841645677834": "Magickids.Official",
  "103086665933895": "Annie Baby",
};

export async function loadCeilings(): Promise<Map<string, Ceiling>> {
  const m = new Map<string, Ceiling>([["*", DEFAULT_CEILING]]);
  const { data, error } = await db().from("fb_ceilings").select("product_code, profit_ceiling, breakeven");
  if (error) return m; // chưa chạy migration 0023: dùng mặc định
  for (const r of data ?? []) {
    m.set(String(r.product_code).toUpperCase(), { profit_ceiling: Number(r.profit_ceiling), breakeven: Number(r.breakeven) });
  }
  return m;
}

export type CeilingRow = { product_code: string; profit_ceiling: number; breakeven: number; note: string | null; updated_at: string };

export async function listCeilings(): Promise<{ rows: CeilingRow[]; error: string | null }> {
  const { data, error } = await db().from("fb_ceilings").select("*").order("product_code");
  return { rows: (data ?? []) as CeilingRow[], error: error?.message ?? null };
}

export type Loaded = {
  ads: AdRow[];
  accounts: { id: string; name: string }[];
  stockDays: Map<string, number | null>;
  ceilings: Map<string, Ceiling>;
  errors: string[];
};

export async function loadRange(since: string, until: string): Promise<Loaded> {
  const errors: string[] = [];
  const accounts = await listAccounts();
  const [metaRows, orders, stock, ceilings] = await Promise.all([
    Promise.all(
      accounts.map((a) =>
        adInsightsRange(a.id, since, until).catch((e) => {
          errors.push(`${a.name}: ${e instanceof Error ? e.message : String(e)}`);
          return [];
        })
      )
    ).then((x) => x.flat()),
    ordersByAdRange(since, until).catch((e) => {
      errors.push(`Pancake: ${e instanceof Error ? e.message : String(e)}`);
      return new Map();
    }),
    loadStock().catch(() => new Map()),
    loadCeilings(),
  ]);
  const info = await adsInfo(metaRows.map((r) => r.ad_id)).catch((e) => {
    errors.push(`Trạng thái/ngân sách: ${e instanceof Error ? e.message : String(e)}`);
    return new Map();
  });
  const accName = new Map(accounts.map((a) => [a.id, a.name]));
  const ads: AdRow[] = metaRows.map((r) => {
    const i = info.get(r.ad_id);
    const o = orders.get(r.ad_id);
    return {
      ...r,
      account_name: accName.get(r.account_id) ?? r.account_id,
      page_id: i?.page_id ?? null,
      status: i?.status ?? "",
      adset_status: i?.adset_status ?? "",
      campaign_status: i?.campaign_status ?? "",
      adset_daily: i?.adset_daily ?? null,
      campaign_daily: i?.campaign_daily ?? null,
      orders: o?.orders ?? 0,
      revenue: Math.round(o?.revenue ?? 0),
    };
  });
  const stockDays = new Map<string, number | null>();
  for (const [code, v] of stock as Map<string, { days: number | null }>) stockDays.set(code, v.days);
  return { ads, accounts: accounts.map((a) => ({ id: a.id, name: a.name })), stockDays, ceilings, errors };
}

/**
 * Bản lưu tạm cho màn /fb (Hải thêm 25/11/2026: mở /fb mất 3,5–4 giây vì mỗi lần mở hỏi lại Meta + Pancake).
 * Giữ 5 phút; nút "Làm mới" trên màn xóa ngay (updateTag). Map không lưu được dạng JSON nên đổi qua mảng.
 */
export const FB_CACHE_TAG = "fb-so";
type LoadedJson = Omit<Loaded, "stockDays" | "ceilings"> & {
  stockDays: [string, number | null][];
  ceilings: [string, Ceiling][];
  at: number;
};
const loadRangeJson = unstable_cache(
  async (since: string, until: string): Promise<LoadedJson> => {
    const d = await loadRange(since, until);
    return { ...d, stockDays: [...d.stockDays], ceilings: [...d.ceilings], at: Date.now() };
  },
  ["fb-load-range-v1"],
  { revalidate: 300, tags: [FB_CACHE_TAG] }
);

export async function loadRangeCached(since: string, until: string): Promise<Loaded & { at: number }> {
  const j = await loadRangeJson(since, until);
  return { ...j, stockDays: new Map(j.stockDays), ceilings: new Map(j.ceilings) };
}
