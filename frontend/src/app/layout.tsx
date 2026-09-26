import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { AppNav } from "@/components/app-nav";
import { AssistantLauncher } from "@/components/assistant-panel";
import { ViewBanner } from "@/components/view-banner";
import { Providers } from "@/components/providers";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import "./globals.css";

const geistSans = Geist({ variable: "--font-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Sewing Planning",
  description: "Orders, daily production and delivery tracking for the sewing floor",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    // suppressHydrationWarning: next-themes sets the theme class on <html> before React loads.
    <html lang="en" suppressHydrationWarning
      className={`${geistSans.variable} ${geistMono.variable} h-full bg-background antialiased`}>
      <body className="flex min-h-full flex-col bg-muted/40">
        <Providers>
          <TooltipProvider>
            <AppNav />
            <ViewBanner />
            <main className="mx-auto w-full max-w-[1600px] flex-1 px-4 py-6 sm:px-6">{children}</main>
            {/* The agent sits over every page rather than on one of its own. */}
            <AssistantLauncher />
            <Toaster position="top-right" richColors />
          </TooltipProvider>
        </Providers>
      </body>
    </html>
  );
}
