# Shopee MCP

[![CI](https://github.com/congminh1254/shopee-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/congminh1254/shopee-mcp/actions/workflows/ci.yml)

A ready-to-deploy **remote MCP server** for the [Shopee Open Platform](https://open.shopee.com) that lets
Claude, Cursor, VS Code and other MCP clients work with a Shopee shop. It's built on
[`@congminh1254/shopee-sdk`](https://github.com/congminh1254/shopee-sdk) and runs on **Vercel** + **Supabase**.
Both have free tiers that are enough for this demo.

Sellers open your deployment, choose **read-only** or **read + write** access, sign in with Shopee, and
get an API key for their MCP client:

```
Seller ──► your-app.vercel.app ──► Shopee login ──► /api/auth/callback ──► API key smcp_… (shown once)

Claude / Cursor ──(Authorization: Bearer smcp_…)──► /api/mcp ──► Shopee API v2
```

> **Fork it for your own Shopee app.** You need your own Shopee partner app, a Supabase project and a
> Vercel account. Setup takes about 15 minutes; see [Quick start](#quick-start).

## Features

- **Multiple regions**: Global (SG, MY, TH, VN, PH, ID, TW, MX, CO, CL, PL…), Brazil, China (CNSC), and both sandboxes.
- **Multiple shops**: one key covers a shop, or every shop under a Shopee main account.
- **Read-only or read + write keys**, chosen by the seller. Write tools are hidden from read-only keys, and
  write calls from them are rejected on the server.
- **The whole shop-level API**: 344 endpoints reachable via `search_endpoints` → `describe_endpoint` →
  `call_read_endpoint` / `call_write_endpoint`, plus task-specific tools for everyday work.
- **Automatic Shopee token refresh**, with tokens stored per shop in Supabase.
- **Audit log** of every Shopee call.
- **Stateless Streamable HTTP**, so it runs as a normal serverless function.

### Tools

| Tool | Access | What it does |
| --- | --- | --- |
| `list_shops`, `get_shop_info` | read | Shops on this key, shop profile |
| `list_orders`, `get_order_details` | read | Orders in a time window, full order data |
| `get_order_income` | read | Escrow breakdown: fees, commission, payout |
| `get_tracking_info` | read | Logistics tracking history |
| `list_products`, `get_products`, `get_product_models` | read | Items, base info, variations |
| `list_returns` | read | Return/refund requests |
| `list_api_modules`, `search_endpoints`, `describe_endpoint` | read | Explore the API catalog |
| `call_read_endpoint` | read | Any read endpoint |
| `update_stock`, `update_price` | write | Inventory and pricing |
| `set_order_note`, `cancel_order` | write | Order actions |
| `call_write_endpoint` | write | Any other endpoint |

Write tools are marked `destructiveHint`, so clients ask for confirmation before running them.

## Quick start

You need:

- A **Shopee partner app** from [open.shopee.com](https://open.shopee.com). A sandbox app is fine to start with.
- A **Supabase** project.
- A **Vercel** account.
- Node.js 20+ for local setup.

The [detailed setup guide](docs/SETUP.md) has every step and a troubleshooting table.

### Option A: deploy to Vercel

1. **Fork or "Use this template"** to get your own copy of this repo.
2. **Create the database.** In your Supabase project, open the **SQL Editor**, paste
   [`supabase/migrations/0001_init.sql`](supabase/migrations/0001_init.sql) and run it.
3. **Deploy.** In Vercel choose **Add New → Project** and import your copy. Set these environment variables:

   | Variable | Where to find it |
   | --- | --- |
   | `SHOPEE_PARTNER_ID`, `SHOPEE_PARTNER_KEY` | Shopee console → your app |
   | `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | Supabase → Project Settings → API |

   For a sandbox-only setup, use `SHOPEE_PARTNER_ID_TEST_GLOBAL` / `SHOPEE_PARTNER_KEY_TEST_GLOBAL`
   instead (see [regions](#regions-and-credentials)).

   Or use the button. It works once your copy is public; replace the repo URL with your own:

   [![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fcongminh1254%2Fshopee-mcp&project-name=shopee-mcp&repository-name=shopee-mcp&env=SHOPEE_PARTNER_ID,SHOPEE_PARTNER_KEY,SUPABASE_URL,SUPABASE_SERVICE_ROLE_KEY&envDescription=Shopee%20partner%20app%20credentials%20and%20Supabase%20API%20keys&envLink=https%3A%2F%2Fgithub.com%2Fcongminh1254%2Fshopee-mcp%2Fblob%2Fmain%2Fdocs%2FSETUP.md)
4. **Register the redirect domain.** In the Shopee console, set your app's redirect URL domain to the
   Vercel production domain, e.g. `shopee-mcp-yourname.vercel.app`.
5. **Connect a shop.** Open the deployment, pick a region and access level, sign in, and copy the key.

### Option B: run locally

```bash
git clone https://github.com/<you>/shopee-mcp && cd shopee-mcp
npm install
npm run setup    # asks for your credentials, writes .env.local, creates tables, runs checks
npm run dev      # http://localhost:3000
```

`npm run setup` can create the tables if you give it the Supabase **Session pooler** connection
string. Otherwise run the SQL by hand as in step 2 above. `npm run doctor` re-checks everything at any
time: env vars, Supabase tables, and whether Shopee accepts your partner credentials for each region.

Shopee only redirects to the domain registered in the console. To finish the sign-in flow locally,
expose the dev server through a tunnel (e.g. `cloudflared tunnel --url http://localhost:3000`),
register that domain, and set `APP_URL` to it.

## Connect an MCP client

The success page shows these snippets with your real URL and key.

**Claude Code**

```bash
claude mcp add --transport http shopee https://your-app.vercel.app/api/mcp \
  --header "Authorization: Bearer smcp_…"
```

**Cursor, VS Code and other clients with a JSON config**

```json
{
  "mcpServers": {
    "shopee": {
      "type": "http",
      "url": "https://your-app.vercel.app/api/mcp",
      "headers": { "Authorization": "Bearer smcp_…" }
    }
  }
}
```

**MCP Inspector**: run `npx @modelcontextprotocol/inspector`, choose Streamable HTTP, enter the URL, and add the
`Authorization` header.

**Revoke a key**:
`curl -X POST https://your-app.vercel.app/api/keys/revoke -H "Authorization: Bearer smcp_…"`

## Regions and credentials

| Region on the connect page | API host | Credentials used |
| --- | --- | --- |
| Global | partner.shopeemobile.com | `SHOPEE_PARTNER_ID[_GLOBAL]` |
| Brazil | openplatform.shopee.com.br | `SHOPEE_PARTNER_ID[_BRAZIL]` |
| China (CNSC) | openplatform.shopee.cn | `SHOPEE_PARTNER_ID[_CHINA]` |
| Sandbox (Global) | openplatform.sandbox.test-stable.shopee.sg | `SHOPEE_PARTNER_ID[_TEST_GLOBAL]` |
| Sandbox (China) | openplatform.test-stable.shopee.cn | `SHOPEE_PARTNER_ID[_TEST_CHINA]` |

A region-specific variable (e.g. `SHOPEE_PARTNER_KEY_TEST_GLOBAL`) wins over the shared
`SHOPEE_PARTNER_ID` / `SHOPEE_PARTNER_KEY`. A region only appears on the connect page when it has
credentials, so set only the regions you actually support. See [`.env.example`](.env.example) for all
variables.

## Scripts

| Command | |
| --- | --- |
| `npm run setup` | Interactive first-time setup: writes `.env.local`, runs `db:migrate` and `doctor` |
| `npm run doctor` | Checks env vars, Supabase tables and Shopee credentials per region |
| `npm run db:migrate` | Applies `supabase/migrations/*.sql` (needs `SUPABASE_DB_URL`) |
| `npm run dev` / `build` / `start` | Next.js |
| `npm test` | End-to-end tests (Supabase and Shopee faked at the `fetch` level, no credentials needed) |
| `npm run typecheck` | TypeScript |
| `npm run gen:catalog` | Regenerates the endpoint catalog from the latest SDK |

## Project layout

```
src/app/page.tsx                   Connect page (region + access level)
src/app/api/auth/start/route.ts    Saves the choice, redirects to Shopee
src/app/api/auth/callback/route.ts Exchanges the code, stores tokens, shows the API key
src/app/api/mcp/route.ts           MCP endpoint (Streamable HTTP, stateless)
src/app/api/keys/revoke/route.ts   Revokes a key
src/lib/mcp-server.ts              Tools, access checks, audit logging
src/lib/shopee.ts                  ShopeeSDK factory + Supabase-backed TokenStorage
src/lib/api-keys.ts                Key generation, hashing, verification
src/lib/catalog.generated.ts       All shop-level endpoints (generated)
supabase/migrations/               Database schema
scripts/                           setup, doctor, db:migrate, gen:catalog
test/mcp.test.ts                   End-to-end tests
```

## Customizing

**Add a tool.** Register it in `src/lib/mcp-server.ts` and route the call through `callEndpoint`, so the
shop and access checks and the audit log apply automatically:

```ts
server.registerTool(
  "get_shop_performance",
  {
    title: "Get shop performance",
    description: "Shop performance metrics (late shipment rate, ratings, …).",
    inputSchema: { shop_id: shopIdArg },
    annotations: ro,
  },
  safe(async ({ shop_id }) => callEndpoint("account_health.get_shop_performance", shop_id, {}))
);
```

Read or write access is decided by the endpoint's entry in the catalog, not by the tool.

**Upgrade the SDK.** Run `npm i @congminh1254/shopee-sdk@latest && npm run gen:catalog` to pick up new endpoints.

**Change the read/write rule.** An endpoint counts as *read* when its name starts with `get_`, `search_`,
`check_`, `query_`, `list_`, `view_` or `download_`; everything else is *write*. The rule is in
`scripts/build-catalog.ts`.

Only endpoints whose spec type is `Shop` are exposed. Partner-, merchant- and user-level endpoints
(e.g. `public.get_shops_by_partner`) are excluded, because they could reveal shops a key wasn't issued for.

## Limitations

This is a demo. Before running it for real sellers, consider:

- **Token encryption.** Shopee tokens are stored in plain text, so encrypt them, e.g. with Supabase Vault or AES-GCM.
- **Concurrent refreshes.** Two requests for the same shop can both refresh an expired token. Add a row lock.
- **Rate limiting.** There is none per key or shop.
- **File uploads.** Endpoints that take files (`media.*`, invoice uploads) can't receive binary data as JSON tool arguments.
- **OAuth.** OAuth-only clients (claude.ai custom connectors) are supported: the server publishes
  `/.well-known/oauth-protected-resource` and `/.well-known/oauth-authorization-server`, supports dynamic client
  registration and PKCE (S256), and on the consent page the seller pastes one or more `smcp_` keys. The OAuth
  session gets the union of those keys' shops (same region only) and write access only if every key has it.
  Revoking a key also cuts off OAuth sessions built on it. Requires migration `0002_oauth.sql`.

## License

[MIT](LICENSE)
