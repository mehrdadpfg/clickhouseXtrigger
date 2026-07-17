import type { ReactNode } from "react";
import { Inter, JetBrains_Mono } from "next/font/google";
import { AppShell } from "@/components/layout/AppShell/AppShell";
import { TooltipProvider } from "@/components/ui/shadcn/tooltip";
import "./globals.css";

// Self-hosted at build time by next/font — no render-blocking request to
// fonts.googleapis.com, and no layout shift from a late swap.
const inter = Inter({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-inter",
});

const jetBrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-jetbrains-mono",
});

export const metadata = {
  title: "Vantage",
  description: "An analyst's chat agent over ClickHouse",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html
      lang="en"
      data-theme="dark"
      className={`${inter.variable} ${jetBrainsMono.variable}`}
    >
      <body>
        <TooltipProvider>
          <AppShell>{children}</AppShell>
        </TooltipProvider>
      </body>
    </html>
  );
}
