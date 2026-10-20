import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import "./globals.css";
import "@/components/chat-thread.css";

const sans = localFont({
  src: [
    { path: "./fonts/anthropic-sans-roman.woff2", style: "normal", weight: "300 800" },
    { path: "./fonts/anthropic-sans-italic.woff2", style: "italic", weight: "300 800" },
  ],
  variable: "--font-anthropic-sans",
  display: "swap",
  fallback: ["Arial", "Helvetica", "sans-serif"],
});
const serif = localFont({
  src: [
    { path: "./fonts/anthropic-serif-roman.woff2", style: "normal", weight: "300 800" },
    { path: "./fonts/anthropic-serif-italic.ttf", style: "italic", weight: "300 800" },
  ],
  variable: "--font-anthropic-serif",
  display: "swap",
  fallback: ["Georgia", "serif"],
  adjustFontFallback: "Times New Roman",
});
const mono = localFont({
  src: "./fonts/anthropic-mono-roman.woff2",
  weight: "300 800",
  style: "normal",
  variable: "--font-anthropic-mono",
  display: "swap",
  fallback: ["Consolas", "Liberation Mono", "monospace"],
  adjustFontFallback: false,
  preload: false,
});

export const metadata: Metadata = {
  title: "Mars · Your Pi workspace",
  description:
    "A personal workspace for conversations, files and durable tasks. A Next.js client for your Pi agent.",
  applicationName: "Mars",
};
export const viewport: Viewport = { width: "device-width", initialScale: 1, themeColor: "#141414" };

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html
      lang="en"
      className={`dark ${sans.variable} ${serif.variable} ${mono.variable}`}
      data-theme="dark"
      suppressHydrationWarning
    >
      <body>{children}</body>
    </html>
  );
}
