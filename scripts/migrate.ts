/**
 * Applies supabase/migrations/*.sql in filename order.
 * Migrations are written to be idempotent, so re-running is safe.
 *
 * Needs SUPABASE_DB_URL: Supabase → Connect → "Session pooler" connection string.
 */
import fs from "node:fs";
import path from "node:path";
import postgres from "postgres";
import { loadEnv } from "./lib/env-file";

loadEnv();

const url = process.env.SUPABASE_DB_URL;
if (!url) {
  console.error(
    "SUPABASE_DB_URL is not set.\n" +
      "Find it in Supabase → Connect → Session pooler, put it in .env.local, or run the SQL in\n" +
      "supabase/migrations/ by hand in the Supabase SQL editor."
  );
  process.exit(1);
}

const dir = path.resolve("supabase/migrations");
const files = fs.readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
const sql = postgres(url, { max: 1, onnotice: () => undefined });

try {
  for (const file of files) {
    process.stdout.write(`Applying ${file}… `);
    await sql.unsafe(fs.readFileSync(path.join(dir, file), "utf8"));
    console.log("done");
  }
  console.log("Database is up to date.");
} catch (err) {
  console.error(`\nMigration failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
} finally {
  await sql.end();
}
