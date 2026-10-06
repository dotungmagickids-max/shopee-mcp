/**
 * Checks that the configuration works: env vars, Supabase tables and Shopee
 * partner credentials for each configured region.
 */
import { loadEnv } from "./lib/env-file";

loadEnv();

const { partnerCredentials } = await import("../src/lib/env");
const { REGIONS } = await import("../src/lib/regions");
const { partnerSdk } = await import("../src/lib/shopee");
const { db } = await import("../src/lib/supabase");

let failures = 0;
const ok = (msg: string) => console.log(`  ✔ ${msg}`);
const fail = (msg: string) => {
  failures++;
  console.log(`  ✘ ${msg}`);
};
const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

console.log("Environment");
for (const name of ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"]) {
  if (process.env[name]) ok(name);
  else fail(`${name} is missing`);
}
console.log(
  `  • APP_URL ${process.env.APP_URL ? `= ${process.env.APP_URL}` : "not set (falls back to the request origin)"}`
);

console.log("\nSupabase");
if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
  for (const table of ["auth_requests", "shopee_tokens", "api_keys", "audit_log"]) {
    try {
      const { error } = await db().from(table).select("*", { count: "exact", head: true });
      if (error) {
        const missing = error.code === "PGRST205" || error.code === "42P01" || /does not exist|schema cache/.test(error.message);
        fail(`${table}: ${error.message || error.code}${missing ? " — run `npm run db:migrate` or the SQL in supabase/migrations/" : ""}`);
      }
      else ok(`table ${table}`);
    } catch (err) {
      fail(`${table}: ${message(err)}`);
    }
  }
} else {
  fail("skipped (credentials missing)");
}

console.log("\nShopee partner credentials");
let configured = 0;
for (const region of REGIONS) {
  const creds = partnerCredentials(region.value);
  if (!creds) {
    console.log(`  • ${region.value}: not configured (hidden on the connect page)`);
    continue;
  }
  configured++;
  try {
    // A signed partner-level call: fails with error_sign / invalid partner if the id/key are wrong.
    const res = await partnerSdk(region.value).public.getShopsByPartner({ page_size: 1, page_no: 1 });
    ok(`${region.value}: partner ${creds.partnerId} OK (${res.authed_shop_list?.length ? "has" : "no"} authorized shops yet)`);
  } catch (err) {
    fail(`${region.value}: partner ${creds.partnerId} rejected — ${message(err)}`);
  }
}
if (configured === 0) fail("no region has SHOPEE_PARTNER_ID / SHOPEE_PARTNER_KEY");

console.log(failures ? `\n${failures} problem(s) found.` : "\nAll good. Run `npm run dev` and open http://localhost:3000");
process.exit(failures ? 1 : 0);
