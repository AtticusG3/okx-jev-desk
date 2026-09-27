import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "okx·jev desk",
  description: "OKX + Jev multi-bot trading desk",
};

export default function RootLayout({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
