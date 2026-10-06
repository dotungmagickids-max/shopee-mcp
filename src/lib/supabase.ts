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
