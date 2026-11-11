import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The SDK uses Node APIs (Buffer, node-fetch fallback); keep it out of the bundle.
  serverExternalPackages: ["@congminh1254/shopee-sdk"],

  // OAuth discovery documents live under /.well-known; serve them from API routes.
  // Clients may append the resource path (e.g. /.well-known/oauth-protected-resource/api/mcp).
  async rewrites() {
    return [
      { source: "/.well-known/oauth-authorization-server", destination: "/api/oauth/metadata" },
      { source: "/.well-known/oauth-authorization-server/:path*", destination: "/api/oauth/metadata" },
      { source: "/.well-known/openid-configuration", destination: "/api/oauth/metadata" },
      { source: "/.well-known/oauth-protected-resource", destination: "/api/oauth/resource-metadata" },
      { source: "/.well-known/oauth-protected-resource/:path*", destination: "/api/oauth/resource-metadata" },
    ];
  },
};

export default nextConfig;
