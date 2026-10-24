import type { Metadata, Viewport } from "next";
import { MidnightReload } from "@/components/MidnightReload";
import { Nav } from "@/components/Nav";
import { TokenBanner } from "@/components/TokenBanner";
import "./globals.css";

export const metadata: Metadata = {
  title: "OO Trading",
  description: "Private trading dashboard",
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  themeColor: "#0b0b0b",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full">
        <MidnightReload />
        <Nav />
        <TokenBanner />
        <main className="mx-auto max-w-6xl px-4 pt-4 pb-24 md:pb-10">{children}</main>
      </body>
    </html>
  );
}
