# Shopee MCP

Remote MCP server for the Shopee Open Platform built on `@congminh1254/shopee-sdk`.
Next.js App Router on Vercel, Supabase Postgres for storage. See README.md and docs/SETUP.md.

## Commands

- `npm run setup`: interactive first-time setup (writes `.env.local`, migrates, runs doctor)
- `npm run doctor`: verify env, Supabase tables and Shopee credentials
- `npm test`: end-to-end tests; Supabase and Shopee are faked at the fetch level, no credentials needed
- `npm run typecheck`, `npm run build`
- `npm run gen:catalog [path-to-shopee-sdk]`: regenerate `src/lib/catalog.generated.ts`

## Conventions

- Every Shopee call from a tool goes through `callEndpoint` in `src/lib/mcp-server.ts`, which enforces
  the key's shop list and read/write access and writes `audit_log`. Don't call the SDK directly from tools.
- Read vs write comes from the catalog (`scripts/build-catalog.ts`), not from the tool definition.
- Only `api_type === "Shop"` endpoints are exposed; never add partner/merchant-level endpoints.
- `src/lib/catalog.generated.ts` is generated; don't edit it by hand.
- Schema changes go in a new `supabase/migrations/NNNN_*.sql` file and must be idempotent.
- Secrets are only read server-side via `src/lib/env.ts`; never prefix them with `NEXT_PUBLIC_`.
