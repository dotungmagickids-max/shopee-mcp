import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The SDK uses Node APIs (Buffer, node-fetch fallback); keep it out of the bundle.
  serverExternalPackages: ["@congminh1254/shopee-sdk"],

  // Trang Sổ hàng xưởng cũ đã chuyển vào app quầy kho (nhóm Sản xuất).
  async redirects() {
    return [{ source: "/san-xuat", destination: "/kho#sx", permanent: false }];
  },

  // OAuth discovery documents live under /.well-known; serve them from API routes.
  // Clients may append the resource path (e.g. /.well-known/oauth-protected-resource/api/mcp).
  async rewrites() {
    return [
      { source: "/kho", destination: "/kho/index.html" },
      // Trang Quản lý kho: đặt ngoài /kho để không dính bộ lưu sẵn (service worker) của trang quay đóng hàng.
      { source: "/quan-ly-kho", destination: "/quan-ly-kho/index.html" },
      // Trang Quản lý chất lượng CSKH (chỉ đọc).
      { source: "/cskh", destination: "/cskh/index.html" },
      // Trang cho xưởng: đơn đã nhận, tiến độ trả hàng, xưởng tự cập nhật. Mã truy cập riêng (XUONG_API_KEY).
      { source: "/xuong", destination: "/xuong/index.html" },
      // Trang Mẫu và media: chọn mẫu, hồ sơ mẫu, media cơ bản. Ba mã truy cập theo vai (MAU_*_KEY).
      { source: "/mau", destination: "/mau/index.html" },
      { source: "/.well-known/oauth-authorization-server", destination: "/api/oauth/metadata" },
      { source: "/.well-known/oauth-authorization-server/:path*", destination: "/api/oauth/metadata" },
      { source: "/.well-known/openid-configuration", destination: "/api/oauth/metadata" },
      { source: "/.well-known/oauth-protected-resource", destination: "/api/oauth/resource-metadata" },
      { source: "/.well-known/oauth-protected-resource/:path*", destination: "/api/oauth/resource-metadata" },
    ];
  },
};

export default nextConfig;
