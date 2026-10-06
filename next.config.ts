import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The SDK uses Node APIs (Buffer, node-fetch fallback); keep it out of the bundle.
  serverExternalPackages: ["@congminh1254/shopee-sdk"],
};

export default nextConfig;
