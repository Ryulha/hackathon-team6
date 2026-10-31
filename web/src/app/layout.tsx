import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { Shell } from "@/components/shell";
import { AppStateProvider } from "@/state/app-state";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "식자재 발주 도우미",
  description: "재고·사용기한·공급사 조건을 반영한 발주 추천과 근거",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="ko" className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}>
      <body className="min-h-full">
        <AppStateProvider>
          <Shell>{children}</Shell>
        </AppStateProvider>
      </body>
    </html>
  );
}
