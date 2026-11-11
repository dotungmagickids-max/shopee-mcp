/**
 * Pure OAuth helpers (no I/O), kept separate so they can be unit-tested without
 * Supabase or Next.js. Storage lives in ./oauth.ts.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { ApiKeyContext } from "./api-keys";

export const ACCESS_TOKEN_PREFIX = "smat_";
export const REFRESH_TOKEN_PREFIX = "smrt_";
export const CODE_PREFIX = "smac_";
export const CLIENT_PREFIX = "smcl_";

export const ACCESS_TOKEN_TTL_S = 60 * 60; // 1 hour
export const REFRESH_TOKEN_TTL_S = 60 * 60 * 24 * 90; // 90 days, rotated on every use
export const CODE_TTL_MS = 5 * 60 * 1000;

export function randomToken(prefix: string): string {
  return prefix + randomBytes(32).toString("base64url");
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

const VERIFIER_RE = /^[A-Za-z0-9\-._~]{43,128}$/;
const CHALLENGE_RE = /^[A-Za-z0-9\-_]{43}$/;

export function isValidCodeChallenge(challenge: string | null | undefined): challenge is string {
  return !!challenge && CHALLENGE_RE.test(challenge);
}

/** PKCE S256 check (RFC 7636). Plain is not supported. */
export function verifyPkce(verifier: string | null | undefined, challenge: string): boolean {
  if (!verifier || !VERIFIER_RE.test(verifier)) return false;
  const computed = Buffer.from(createHash("sha256").update(verifier).digest("base64url"));
  const expected = Buffer.from(challenge);
  return computed.length === expected.length && timingSafeEqual(computed, expected);
}

/** Redirect URIs must be https, or http on a loopback host (native/desktop clients). No fragments. */
export function isAllowedRedirectUri(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 2000) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.hash) return false;
  if (url.protocol === "https:") return true;
  return url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
}

export function authorizationServerMetadata(base: string) {
  return {
    issuer: base,
    authorization_endpoint: `${base}/api/oauth/authorize`,
    token_endpoint: `${base}/api/oauth/token`,
    registration_endpoint: `${base}/api/oauth/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: ["shopee"],
  };
}

export function protectedResourceMetadata(base: string) {
  return {
    resource: `${base}/api/mcp`,
    authorization_servers: [base],
    bearer_methods_supported: ["header"],
    scopes_supported: ["shopee"],
    resource_name: "Shopee MCP",
  };
}

/** Splits pasted text into candidate smcp_ keys (one per line, comma or space separated). */
export function parsePastedKeys(text: string): string[] {
  const keys = text
    .split(/[\s,;]+/)
    .map((s) => s.trim())
    .filter((s) => s.startsWith("smcp_"));
  return [...new Set(keys)].slice(0, 20);
}

/**
 * Combines several API keys into one context for an OAuth session.
 * All keys must share a region. Write access only if every key allows it,
 * so a read-only key can never be upgraded by pairing it with another.
 */
export function mergeContexts(ctxs: ApiKeyContext[]): ApiKeyContext | { error: string } {
  if (ctxs.length === 0) return { error: "No valid API key." };
  const regions = new Set(ctxs.map((c) => c.region));
  if (regions.size > 1) {
    return { error: `Keys belong to different regions (${[...regions].join(", ")}). Connect one region at a time.` };
  }
  return {
    id: ctxs[0].id,
    access: ctxs.every((c) => c.access === "read_write") ? "read_write" : "read",
    region: ctxs[0].region,
    shopIds: [...new Set(ctxs.flatMap((c) => c.shopIds))],
    label: ctxs.map((c) => c.label).filter(Boolean).join(" + ") || null,
  };
}

export function oauthError(error: string, description: string, status = 400): Response {
  return Response.json(
    { error, error_description: description },
    { status, headers: { "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" } }
  );
}

export const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, mcp-protocol-version",
};
