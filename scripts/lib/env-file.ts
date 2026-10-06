import fs from "node:fs";
import path from "node:path";
import { config } from "dotenv";

export const ENV_FILE = path.resolve(".env.local");

/** Loads .env.local, then .env, the same files `next dev` reads. */
export function loadEnv(): void {
  config({ path: ENV_FILE, quiet: true });
  config({ path: path.resolve(".env"), quiet: true });
}

/** Reads KEY=value pairs from .env.local (empty object if missing). */
export function readEnvFile(): Record<string, string> {
  if (!fs.existsSync(ENV_FILE)) return {};
  const out: Record<string, string> = {};
  for (const line of fs.readFileSync(ENV_FILE, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
  }
  return out;
}

export function writeEnvFile(values: Record<string, string>): void {
  const body = Object.entries(values)
    .filter(([, v]) => v !== "")
    .map(([k, v]) => `${k}=${/[\s#"']/.test(v) ? JSON.stringify(v) : v}`)
    .join("\n");
  fs.writeFileSync(ENV_FILE, `${body}\n`, { mode: 0o600 });
}
