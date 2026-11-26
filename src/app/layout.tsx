import type { Metadata, Viewport } from "next";
import { Outfit } from "next/font/google";
import "./globals.css";

const outfit = Outfit({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700", "800"],
  variable: "--font-outfit",
  display: "swap",
});

export const metadata: Metadata = {
  title: { default: "Lavigo OS", template: "%s · Lavigo OS" },
  description: "Owner and staff operating system for Lavigo Travel Co.",
  robots: { index: false, follow: false },
  icons: { icon: "/images/logo.webp" },
};

export const viewport: Viewport = { themeColor: "#221944" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en-IN" className={outfit.variable}>
      <body>{children}</body>
    </html>
  );
}
