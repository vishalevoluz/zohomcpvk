import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "EvoAudit",
  description: "Connect and interact with Zoho via MCP",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
