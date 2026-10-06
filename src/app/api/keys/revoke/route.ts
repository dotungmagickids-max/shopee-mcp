import { keyFromRequest, revokeApiKey } from "@/lib/api-keys";

export const runtime = "nodejs";

/** Revoke the key sent in the Authorization header: `curl -X POST -H "Authorization: Bearer smcp_…"`. */
export async function POST(request: Request): Promise<Response> {
  const key = keyFromRequest(request);
  if (!key) return Response.json({ error: "Missing API key" }, { status: 401 });
  const revoked = await revokeApiKey(key);
  return Response.json({ revoked }, { status: revoked ? 200 : 404 });
}
