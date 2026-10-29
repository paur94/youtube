import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { Suspense } from "react";

import { AppSidebar, AppSidebarFallback } from "@/components/app-sidebar";
import { Toaster } from "@/components/ui/sonner";

import "./globals.css";

const geistSans = Geist({
  variable: "--font-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: { default: "Kids Studio", template: "%s · Kids Studio" },
  description: "AI-assisted YouTube Kids content production",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`dark ${geistSans.variable} ${geistMono.variable} h-full antialiased`}>
      <body className="flex min-h-full flex-col bg-background md:flex-row">
        <Suspense fallback={<AppSidebarFallback />}>
          <AppSidebar />
        </Suspense>
        <main className="min-w-0 flex-1 bg-[radial-gradient(ellipse_at_top_right,rgb(139_92_246/0.08),transparent_55%)] px-4 py-6 md:px-8 md:py-8">
          <div className="mx-auto w-full max-w-6xl">{children}</div>
        </main>
        <Toaster theme="dark" richColors position="bottom-right" />
      </body>
    </html>
  );
}
