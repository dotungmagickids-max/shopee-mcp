import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { supabaseEnv } from "./env";

let client: SupabaseClient | undefined;

/** Server-only Supabase client using the service role key. */
export function db(): SupabaseClient {
  if (!client) {
    const { url, serviceRoleKey } = supabaseEnv();
    client = createClient(url, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return client;
}

/**
 * Đọc hết mọi dòng của một truy vấn. Supabase (PostgREST) trả tối đa 1.000 dòng mỗi lần, `.limit(10000)` không vượt được,
 * nên phải lật trang bằng range. `make` tạo truy vấn mới mỗi trang và phải có `.order(...)` ổn định.
 */
export async function allRows<T = any>(make: () => any, pageSize = 1000, maxPages = 100): Promise<T[]> {
  const out: T[] = [];
  for (let page = 0; page < maxPages; page++) {
    const { data, error } = await make().range(page * pageSize, page * pageSize + pageSize - 1);
    if (error) throw new Error(error.message);
    out.push(...((data ?? []) as T[]));
    if (!data || data.length < pageSize) break;
  }
  return out;
}
