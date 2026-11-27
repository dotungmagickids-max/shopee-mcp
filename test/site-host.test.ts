import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isPublicHost, sitePathAction } from "../src/lib/site-host";

describe("site-host", () => {
  it("nhận đúng host công ty", () => {
    assert.ok(isPublicHost("magickids.vn"));
    assert.ok(isPublicHost("WWW.Magickids.vn:443"));
    assert.ok(!isPublicHost("magickids-shopee.vercel.app"));
    assert.ok(!isPublicHost("evilmagickids.vn"));
    assert.ok(!isPublicHost(null));
  });
  it("trang chủ rewrite sang trang giới thiệu", () => {
    assert.deepEqual(sitePathAction("/"), { kind: "rewrite", to: "/site/index.html" });
  });
  it("cho qua terms, privacy, api, well-known", () => {
    for (const p of ["/terms", "/privacy/", "/api/mcp", "/api/tiktok/content/callback", "/.well-known/x", "/magickids-logo-1024.png"]) {
      assert.equal(sitePathAction(p).kind, "pass", p);
    }
  });
  it("chặn khu quản trị", () => {
    for (const p of ["/admin", "/admin/login", "/fb", "/san-xuat", "/video", "/kho", "/cskh", "/xuong", "/mau", "/quan-ly-kho", "/apix"]) {
      assert.deepEqual(sitePathAction(p), { kind: "redirect", to: "/" }, p);
    }
  });
});
