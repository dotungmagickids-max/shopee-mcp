import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "Shopee MCP",
  description: "Connect a Shopee shop to AI assistants over MCP, powered by @congminh1254/shopee-sdk.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        {/* eslint-disable-next-line @next/next/no-css-tags */}
        <link rel="stylesheet" href="/styles.css" />
      </head>
      <body>
        <main className="container">{children}</main>
      </body>
    </html>
  );
}
