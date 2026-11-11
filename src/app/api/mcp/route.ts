import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { keyFromRequest, verifyApiKey } from "@/lib/api-keys";
import { appUrl } from "@/lib/env";
import { createMcpServer } from "@/lib/mcp-server";
import { contextFromAccessToken, isAccessToken } from "@/lib/oauth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

function unauthorized(request: Request): Response {
  // resource_metadata lets OAuth clients (claude.ai connectors) discover how to sign in.
  const metadataUrl = `${appUrl(request)}/.well-known/oauth-protected-resource`;
  return Response.json(
    {
      jsonrpc: "2.0",
      error: {
        code: -32001,
        message: "Missing or invalid credentials. Sign in with OAuth or send 'Authorization: Bearer smcp_…'.",
      },
      id: null,
    },
    {
      status: 401,
      headers: { "WWW-Authenticate": `Bearer realm="shopee-mcp", resource_metadata="${metadataUrl}"` },
    }
  );
}

/**
 * Stateless Streamable HTTP endpoint: each request gets a fresh MCP server bound
 * to the caller's API key (or OAuth token built on API keys), which fits Vercel's
 * serverless functions.
 */
async function handle(request: Request): Promise<Response> {
  const token = keyFromRequest(request);
  const ctx = isAccessToken(token) ? await contextFromAccessToken(token) : await verifyApiKey(token);
  if (!ctx) return unauthorized(request);

  const server = createMcpServer(ctx);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  try {
    return await transport.handleRequest(request);
  } finally {
    // Responses are fully buffered (enableJsonResponse), so it's safe to close.
    await server.close();
  }
}

export { handle as GET, handle as POST, handle as DELETE };
