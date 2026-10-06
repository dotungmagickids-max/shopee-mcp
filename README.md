# Shopee MCP

A demo **remote MCP server** for the [Shopee Open Platform](https://open.shopee.com), built on
[`@congminh1254/shopee-sdk`](https://github.com/congminh1254/shopee-sdk). Sellers connect their shop,
choose **read-only** or **read + write** access, and get an API key that works with Claude and
other MCP clients.

Runs on **Vercel** (Next.js) with **Supabase** (Postgres) for tokens and keys.

```
Seller ──► / (choose region + access) ──► Shopee login ──► /api/auth/callback
                                                              │ exchange code → tokens (Supabase)
                                                              └► shows API key smcp_… (once)

MCP client ──(Authorization: Bearer smcp_…)──► /api/mcp ──► ShopeeSDK ──► Shopee API v2
                                                  │ checks key, shop list, access level
                                                  └► audit_log
```

## Features

- **Multiple regions**: Global (SG/MY/TH/VN/PH/ID/TW/MX/CO/CL/PL…), Brazil, China (CNSC), and both sandboxes.
- **Multiple shops**: a key covers one shop, or every shop under a main account.
- **Access levels**: write tools are not even listed for read-only keys, and every write
  endpoint is rejected server-side.
- **Full API coverage**: all 344 shop-level endpoints in the SDK through
  `search_endpoints` → `describe_endpoint` → `call_read_endpoint` / `call_write_endpoint`, plus
  task-specific tools for everyday work.
- **Automatic token refresh**: the SDK refreshes expired Shopee tokens, which are persisted to Supabase.
- **Audit log** of every Shopee call: key, shop, endpoint, success, duration.
- Stateless Streamable HTTP transport, which fits serverless functions.

### Tools

| Tool | Access | Shopee endpoint |
| --- | --- | --- |
| `list_shops` | read | shop.get_shop_info for each shop |
| `get_shop_info` | read | shop.get_shop_info |
| `list_orders` | read | order.get_order_list |
| `get_order_details` | read | order.get_order_detail |
| `get_order_income` | read | payment.get_escrow_detail |
| `get_tracking_info` | read | logistics.get_tracking_info |
| `list_products` | read | product.get_item_list |
| `get_products` | read | product.get_item_base_info |
| `get_product_models` | read | product.get_model_list |
| `list_returns` | read | returns.get_return_list |
| `list_api_modules`, `search_endpoints`, `describe_endpoint` | read | catalog lookups |
| `call_read_endpoint` | read | any `get_/search_/check_/…` endpoint |
| `update_stock` | write | product.update_stock |
| `update_price` | write | product.update_price |
| `set_order_note` | write | order.set_note |
| `cancel_order` | write | order.cancel_order |
| `call_write_endpoint` | write | any other endpoint |

Write tools carry `destructiveHint`, so clients such as Claude ask for confirmation before running them.

## Setup

### 1. Supabase

1. Create a project.
2. Run [`supabase/migrations/0001_init.sql`](supabase/migrations/0001_init.sql) in the SQL editor, or
   use `supabase db push`.
3. From **Settings → API**, copy the project URL and the **service role** key.

RLS is enabled on every table with no policies, so only the service role, used server-side, can
read them.

### 2. Shopee partner app

1. In the [Open Platform console](https://open.shopee.com), open your app and note its
   **Partner ID** and **Partner Key**. Sandbox and live apps have different credentials.
2. Set the app's redirect URL domain to your deployment's domain, e.g. `your-app.vercel.app`.
   The callback is `https://<domain>/api/auth/callback`.

### 3. Vercel

Import the repository into Vercel and set these environment variables (see [`.env.example`](.env.example)):

| Variable | Required | |
| --- | --- | --- |
| `SHOPEE_PARTNER_ID`, `SHOPEE_PARTNER_KEY` | yes | Default credentials for all regions |
| `SHOPEE_PARTNER_ID_<REGION>`, `SHOPEE_PARTNER_KEY_<REGION>` | no | Per-region override; `<REGION>` is `GLOBAL`, `BRAZIL`, `CHINA`, `TEST_GLOBAL` or `TEST_CHINA` |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | yes | |
| `APP_URL` | no | Public URL; defaults to the request origin |

A region is selectable on the home page only when it has credentials.

### 4. Connect a shop

Open the deployment, pick a region and access level, sign in on Shopee, and copy the key that is
shown. Then, for example with Claude Code:

```bash
claude mcp add --transport http shopee https://your-app.vercel.app/api/mcp \
  --header "Authorization: Bearer smcp_…"
```

JSON-config clients (Cursor, VS Code, …):

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

Revoke a key:

```bash
curl -X POST https://your-app.vercel.app/api/keys/revoke -H "Authorization: Bearer smcp_…"
```

## Development

```bash
npm install
cp .env.example .env.local   # fill in
npm run dev                  # http://localhost:3000
npm test                     # end-to-end tests with Supabase and Shopee faked at the fetch level
npm run typecheck
```

Inspect the server with the MCP Inspector: `npx @modelcontextprotocol/inspector`, then connect to
`http://localhost:3000/api/mcp` with the `Authorization` header.

### Endpoint catalog

`src/lib/catalog.generated.ts` lists every SDK method with its Shopee path, HTTP method,
read/write classification and parameter docs. It is generated from a checkout of the SDK repo.
Re-run this after upgrading the SDK:

```bash
git clone https://github.com/congminh1254/shopee-sdk ../shopee-sdk
npm run gen:catalog -- ../shopee-sdk
```

Only endpoints whose spec `api_type` is `Shop` are included. Partner-, merchant- and user-level
endpoints (e.g. `public.get_shops_by_partner`) are excluded, because they could expose data
beyond the shops a key was issued for.

An endpoint counts as **read** when its name starts with `get_`, `search_`, `check_`, `query_`,
`list_`, `view_` or `download_`. Everything else is **write**.

## Demo limitations

This is a demo, not production-hardened:

- Shopee tokens are stored in plain text in Postgres. For production, encrypt them, e.g. with
  Supabase Vault or app-level AES-GCM.
- Two concurrent requests for the same shop can both try to refresh an expired token. Add a row
  lock or advisory lock if that matters.
- There is no rate limiting per key or shop.
- Endpoints that upload files (`media.*`, invoice uploads) need binary bodies, which can't be
  passed as JSON tool arguments.
- Clients that only support OAuth (e.g. claude.ai custom connectors) can't send the API key
  header. Supporting them would need an OAuth authorization server in front of `/api/mcp`.
