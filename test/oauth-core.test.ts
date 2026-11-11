/** Unit tests for the dependency-free OAuth helpers. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import {
  authorizationServerMetadata,
  isAllowedRedirectUri,
  isValidCodeChallenge,
  mergeContexts,
  parsePastedKeys,
  protectedResourceMetadata,
  verifyPkce,
} from "../src/lib/oauth-core";

const verifier = "a".repeat(20) + "B-._~" + "c".repeat(30);
const challenge = createHash("sha256").update(verifier).digest("base64url");

describe("oauth-core", () => {
  it("verifies PKCE S256", () => {
    assert.ok(isValidCodeChallenge(challenge));
    assert.ok(verifyPkce(verifier, challenge));
    assert.ok(!verifyPkce(verifier + "x", challenge));
    assert.ok(!verifyPkce("short", challenge));
    assert.ok(!verifyPkce(null, challenge));
    assert.ok(!isValidCodeChallenge("plain"));
  });

  it("allows only https or loopback redirect URIs", () => {
    assert.ok(isAllowedRedirectUri("https://claude.ai/api/mcp/auth_callback"));
    assert.ok(isAllowedRedirectUri("http://localhost:6274/oauth/callback"));
    assert.ok(isAllowedRedirectUri("http://127.0.0.1:33418/cb"));
    assert.ok(!isAllowedRedirectUri("http://evil.example/cb"));
    assert.ok(!isAllowedRedirectUri("https://claude.ai/cb#frag"));
    assert.ok(!isAllowedRedirectUri("javascript:alert(1)"));
    assert.ok(!isAllowedRedirectUri(42));
  });

  it("parses pasted keys", () => {
    assert.deepEqual(parsePastedKeys(" smcp_a\nsmcp_b, junk smcp_a\n"), ["smcp_a", "smcp_b"]);
    assert.deepEqual(parsePastedKeys("nothing here"), []);
  });

  it("merges contexts without upgrading access", () => {
    const rw = { id: "k1", access: "read_write" as const, region: "GLOBAL" as never, shopIds: [1], label: "A" };
    const ro = { id: "k2", access: "read" as const, region: "GLOBAL" as never, shopIds: [2, 1], label: null };
    const both = mergeContexts([rw, ro]);
    if ("error" in both) throw new Error(both.error);
    assert.equal(both.access, "read");
    assert.deepEqual(both.shopIds, [1, 2]);
    assert.equal(both.id, "k1");
    const onlyRw = mergeContexts([rw, { ...rw, id: "k3", shopIds: [9] }]);
    assert.ok(!("error" in onlyRw) && onlyRw.access === "read_write");
    assert.ok("error" in mergeContexts([rw, { ...ro, region: "BRAZIL" as never }]));
    assert.ok("error" in mergeContexts([]));
  });

  it("publishes consistent metadata", () => {
    const as = authorizationServerMetadata("https://x.test");
    const pr = protectedResourceMetadata("https://x.test");
    assert.equal(pr.authorization_servers[0], as.issuer);
    assert.equal(pr.resource, "https://x.test/api/mcp");
    assert.deepEqual(as.code_challenge_methods_supported, ["S256"]);
  });
});
