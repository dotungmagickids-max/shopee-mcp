import type { Metadata } from "next";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { ADMIN_COOKIE, isValidSession } from "@/lib/autopilot/admin-auth";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Sổ hàng xưởng Magickids", robots: { index: false, follow: false } };

/** Chỉ anh Tùng xem: dùng chung phiên đăng nhập quản trị (/admin, ADMIN_PASSWORD). Trang chỉ đọc. */
export default async function SanXuatLayout({ children }: { children: ReactNode }) {
  const jar = await cookies();
  if (!isValidSession(jar.get(ADMIN_COOKIE)?.value)) redirect("/admin/login?next=/san-xuat");
  return (
    <div className="sx">
      <link rel="preconnect" href="https://fonts.googleapis.com" />
      <link
        rel="stylesheet"
        href="https://fonts.googleapis.com/css2?family=Be+Vietnam+Pro:wght@400;500;600;700&family=JetBrains+Mono:wght@500;600&display=swap"
        precedence="default"
      />
      <link rel="stylesheet" href="/san-xuat.css" precedence="default" />
      {children}
    </div>
  );
}
