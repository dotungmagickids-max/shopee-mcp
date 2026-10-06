import { partnerCredentials } from "@/lib/env";
import { REGIONS } from "@/lib/regions";

export const dynamic = "force-dynamic";

export default function Home() {
  const regions = REGIONS.map((r) => ({ ...r, enabled: partnerCredentials(r.value) !== null }));
  const firstEnabled = regions.find((r) => r.enabled)?.value;

  return (
    <>
      <h1>Shopee MCP</h1>
      <p className="lead">
        Let Claude and other MCP clients work with your Shopee shop: orders, products, stock, payouts,
        returns and the rest of the Open Platform API. A demo of{" "}
        <a href="https://github.com/congminh1254/shopee-sdk">@congminh1254/shopee-sdk</a>.
      </p>

      <form method="post" action="/api/auth/start" className="card">
        <fieldset>
          <legend>1. Shopee region</legend>
          {regions.map((r) => (
            <label key={r.value} className={r.enabled ? "option" : "option disabled"}>
              <input
                type="radio"
                name="region"
                value={r.value}
                defaultChecked={r.value === firstEnabled}
                disabled={!r.enabled}
                required
              />
              <span>
                <b>{r.label}</b>
                <small>{r.enabled ? r.hint : "Not configured on this server"}</small>
              </span>
            </label>
          ))}
        </fieldset>

        <fieldset>
          <legend>2. Access level</legend>
          <label className="option">
            <input type="radio" name="access" value="read" defaultChecked />
            <span>
              <b>Read only</b>
              <small>View orders, products, payouts, logistics, returns, analytics.</small>
            </span>
          </label>
          <label className="option">
            <input type="radio" name="access" value="read_write" />
            <span>
              <b>Read + write</b>
              <small>Also update stock and prices, ship or cancel orders, manage promotions, etc.</small>
            </span>
          </label>
        </fieldset>

        <fieldset>
          <legend>3. Label (optional)</legend>
          <input type="text" name="label" maxLength={100} placeholder="e.g. My VN shop – laptop" />
        </fieldset>

        <button type="submit" disabled={!firstEnabled}>
          Connect with Shopee
        </button>
        <p className="muted">
          You will sign in on Shopee and approve access. Afterwards you get an API key to use with the MCP
          endpoint <code>/api/mcp</code>.
        </p>
      </form>
    </>
  );
}
