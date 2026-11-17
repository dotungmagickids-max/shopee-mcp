import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "Magickids Video",
  robots: { index: false, follow: false },
};

export default function VideoRootLayout({ children }: { children: ReactNode }) {
  return (
    <div className="admin">
      <link rel="stylesheet" href="/admin.css" precedence="default" />
      {children}
    </div>
  );
}
