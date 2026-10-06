/**
 * Interactive first-time setup: writes .env.local, applies the database
 * migration and runs the doctor checks.
 */
import { spawnSync } from "node:child_process";
import { stdin as input, stdout as output } from "node:process";
import readline from "node:readline/promises";
import { ENV_FILE, readEnvFile, writeEnvFile } from "./lib/env-file";

const rl = readline.createInterface({ input, output });
// Read lines through the iterator rather than rl.question(), so piped input
// (e.g. `printf … | npm run setup`) isn't dropped before a prompt is shown.
const lines = rl[Symbol.asyncIterator]();
const env = readEnvFile();
let inputEnded = false;

async function prompt(question: string): Promise<string> {
  output.write(question);
  const next = await lines.next();
  if (next.done) {
    inputEnded = true;
    output.write("\n");
  }
  return next.done ? "" : String(next.value).trim();
}

function mask(value: string): string {
  return value.length <= 8 ? "****" : `${value.slice(0, 4)}…${value.slice(-4)}`;
}

async function ask(key: string, question: string, opts: { secret?: boolean; optional?: boolean } = {}) {
  const current = env[key] ?? "";
  const hint = current ? ` [${opts.secret ? mask(current) : current}]` : opts.optional ? " (optional, Enter to skip)" : "";
  for (;;) {
    const answer = await prompt(`${question}${hint}: `);
    const value = answer || current;
    if (value || opts.optional) {
      env[key] = value;
      return value;
    }
    if (inputEnded) {
      console.error(`\nInput ended before ${key} was provided; nothing was saved.`);
      process.exit(1);
    }
    console.log("  This value is required.");
  }
}

async function confirm(question: string): Promise<boolean> {
  const answer = (await prompt(`${question} [Y/n]: `)).toLowerCase();
  return answer === "" || answer.startsWith("y");
}

console.log(`
Shopee MCP setup — answers are saved to ${ENV_FILE}
Press Enter to keep the value shown in [brackets].

1) Shopee partner app — open.shopee.com → Console → App List → your app
   Live credentials cover Global, Brazil and China unless you override them later.`);
await ask("SHOPEE_PARTNER_ID", "   Live Partner ID", { optional: true });
await ask("SHOPEE_PARTNER_KEY", "   Live Partner Key", { secret: true, optional: true });
console.log("   Sandbox app (test-stable environment), if you have one:");
await ask("SHOPEE_PARTNER_ID_TEST_GLOBAL", "   Sandbox Partner ID", { optional: true });
await ask("SHOPEE_PARTNER_KEY_TEST_GLOBAL", "   Sandbox Partner Key", { secret: true, optional: true });
if (!env.SHOPEE_PARTNER_ID && !env.SHOPEE_PARTNER_ID_TEST_GLOBAL) {
  console.log("   ⚠ No partner credentials entered; no region will be available until you add some.");
}

console.log(`
2) Supabase — supabase.com/dashboard → your project`);
await ask("SUPABASE_URL", "   Project URL (Settings → API, https://xxxx.supabase.co)");
await ask("SUPABASE_SERVICE_ROLE_KEY", "   service_role key (Settings → API Keys)", { secret: true });
await ask(
  "SUPABASE_DB_URL",
  "   Postgres connection string for migrations (Connect → Session pooler)",
  { secret: true, optional: true }
);

console.log(`
3) Public URL of this app (only needed if it differs from the browser origin)`);
await ask("APP_URL", "   APP_URL", { optional: true });

writeEnvFile(env);
console.log(`\nSaved ${ENV_FILE}\n`);

const run = (script: string) => spawnSync("npm", ["run", "--silent", script], { stdio: "inherit" }).status === 0;

if (env.SUPABASE_DB_URL) {
  if (await confirm("Create the database tables now (npm run db:migrate)?")) run("db:migrate");
} else {
  console.log("No connection string given: run supabase/migrations/0001_init.sql in the Supabase SQL editor.");
}
rl.close();

console.log("\nChecking configuration (npm run doctor)…\n");
run("doctor");
