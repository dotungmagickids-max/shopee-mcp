# Setup guide

This guide walks you through running your own copy of Shopee MCP: create a Shopee partner app,
set up Supabase, deploy to Vercel, and connect a shop. Setup takes about 15 minutes.

- [1. Get your own copy of the repo](#1-get-your-own-copy-of-the-repo)
- [2. Shopee partner app](#2-shopee-partner-app)
- [3. Supabase](#3-supabase)
- [4. Deploy to Vercel](#4-deploy-to-vercel)
- [5. Register the redirect domain on Shopee](#5-register-the-redirect-domain-on-shopee)
- [6. Connect a shop and an MCP client](#6-connect-a-shop-and-an-mcp-client)
- [Local development](#local-development)
- [Troubleshooting](#troubleshooting)

## 1. Get your own copy of the repo

On GitHub, click **Use this template → Create a new repository** (or **Fork**). Then:

```bash
git clone https://github.com/<you>/shopee-mcp && cd shopee-mcp
npm install
```

## 2. Shopee partner app

1. Sign in at [open.shopee.com](https://open.shopee.com) and register as a developer if you haven't already.
2. In the console, create an app. Choose an app type that can access seller shops, such as a seller
   in-house system or ERP.
3. Open the app and note its credentials:
   - **Test (sandbox)**: a partner ID and key for the `test-stable` environment. These are usually
     available right away, along with sandbox test shops.
   - **Live**: a partner ID and key for production. These are usually available after the app goes live.

Sandbox and live credentials are different. Using one environment's credentials against the other
fails with `invalid_partner_id`.

## 3. Supabase

1. Create a project at [supabase.com](https://supabase.com/dashboard).
2. **Create the tables.** Either:
   - open **SQL Editor**, paste [`supabase/migrations/0001_init.sql`](../supabase/migrations/0001_init.sql) and click **Run**; or
   - copy the connection string from **Connect → Session pooler**, put it in `.env.local` as
     `SUPABASE_DB_URL`, and run `npm run db:migrate`.

   The migration is idempotent, so running it twice is safe.
3. From **Project Settings → API**, copy the **Project URL** and the **service_role** secret key.

The service role key bypasses Row Level Security. It is only used server-side and must never be
exposed to the browser. Every table has RLS enabled with no policies, so the public anon key can't read them.

Tables:

| Table | Contents |
| --- | --- |
| `auth_requests` | Pending "connect shop" attempts (valid for 15 minutes, single use) |
| `shopee_tokens` | Shopee access and refresh token per `(region, shop_id)` |
| `api_keys` | SHA-256 hash of each MCP key, its access level, region and shop list |
| `audit_log` | One row per Shopee call made through MCP |

## 4. Deploy to Vercel

1. In Vercel, choose **Add New → Project**, import your repository and keep the defaults.
   Vercel detects Next.js automatically.
2. Under **Environment Variables**, add:

   | Variable | Value |
   | --- | --- |
   | `SHOPEE_PARTNER_ID` | Live partner ID |
   | `SHOPEE_PARTNER_KEY` | Live partner key |
   | `SHOPEE_PARTNER_ID_TEST_GLOBAL` | *(optional)* Sandbox partner ID |
   | `SHOPEE_PARTNER_KEY_TEST_GLOBAL` | *(optional)* Sandbox partner key |
   | `SUPABASE_URL` | Supabase Project URL |
   | `SUPABASE_SERVICE_ROLE_KEY` | Supabase service_role key |

   To use the sandbox only, set just the `_TEST_GLOBAL` pair. Regions without credentials are
   greyed out on the connect page. The full list of variables is in [`.env.example`](../.env.example).
3. Click **Deploy**.

If you change environment variables later, redeploy (**Deployments → ⋯ → Redeploy**) for them to take effect.

`APP_URL` is optional. On Vercel the Shopee redirect URL defaults to your production domain
(`VERCEL_PROJECT_PRODUCTION_URL`), so preview deployments also redirect to the domain Shopee knows.
If you add a custom domain, set `APP_URL=https://your-domain`.

## 5. Register the redirect domain on Shopee

In the Shopee console, open your app and set the **redirect URL domain** to your production domain,
for example `shopee-mcp-yourname.vercel.app` or your custom domain. Do this for both the test and live
settings if you use both.

The callback is `https://<domain>/api/auth/callback?request_id=…`. Shopee checks the domain, and the
query string carries the pending request.

## 6. Connect a shop and an MCP client

1. Open your deployment.
2. Pick the shop's region and the access level (**Read only** or **Read + write**), optionally add a
   label, and click **Connect with Shopee**.
3. Sign in with the shop account (or a sandbox test shop) and approve.
4. Copy the API key from the success page. It's shown only once.
5. Add the server to your client. The success page shows ready-made snippets, for example:

   ```bash
   claude mcp add --transport http shopee https://<domain>/api/mcp \
     --header "Authorization: Bearer smcp_…"
   ```

6. Try asking: *"List my orders from the last 3 days that are ready to ship"*, or *"What did I earn on order 2410…?"*

Each authorization creates a new key. To give someone read-only access to the same shop, connect again
with **Read only**. Shopee tokens are shared per shop, so the existing keys keep working.

## Local development

```bash
npm run setup   # writes .env.local, optionally runs db:migrate, then runs doctor
npm run dev
```

`npm run doctor` shows what's wrong, for example:

```
Supabase
  ✔ table auth_requests
  ...
Shopee partner credentials
  ✔ TEST_GLOBAL: partner 1234567 OK (no authorized shops yet)
  ✘ GLOBAL: partner 2001234 rejected — API Error: 403 - {"error":"error_sign","message":"Wrong sign."}
```

The connect page works on `localhost`, but Shopee can only redirect back to the domain registered
for your app. To test the whole flow locally, use a tunnel:

```bash
cloudflared tunnel --url http://localhost:3000    # or: ngrok http 3000
```

Then register the tunnel's domain in the Shopee console and set `APP_URL` in `.env.local` to it.

To run with the same variables as Vercel, use `vercel env pull .env.local`.

## Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| A region is greyed out | No credentials for it. Set `SHOPEE_PARTNER_ID`/`KEY` (or the `_<REGION>` pair) and redeploy. |
| `invalid_partner_id` | Wrong partner ID, or sandbox credentials used for a live region (or the reverse). |
| `error_sign` / "Wrong sign" | Wrong partner key for that partner ID. |
| Shopee shows a redirect / domain error after login | The deployment's domain isn't registered in the Shopee console (step 5), or `APP_URL` points elsewhere. |
| "This authorization link has expired or was already used" | More than 15 minutes passed, or the page was refreshed. Start again from the home page. |
| Callback says "Token exchange with Shopee failed" | The code was already used or has expired, or the region doesn't match the shop (e.g. Brazil shop connected as Global). |
| `/api/mcp` returns 401 | Missing `Authorization: Bearer smcp_…` header, mistyped key, or the key was revoked. |
| Tool returns `invalid_acceess_token` / `error_auth` | The shop's refresh token expired (about 30 days without use) or the seller revoked access. Connect the shop again. |
| Doctor: `Could not find the table … in the schema cache` | The migration hasn't run. See step 3. |
| Tool says "this key is read-only" | The key was issued with **Read only**. Connect again with **Read + write**. |
| Response ends with `[truncated …]` | Responses are capped at 100k characters. Use a smaller `page_size` or fewer ids. |
