"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { useApp } from "@/state/app-state";
import { SettingsPanel } from "./settings-panel";

const NAV = [
  { href: "/", label: "대시보드" },
  { href: "/orders", label: "발주 추천" },
  { href: "/inventory", label: "재고·사용기한" },
  { href: "/assumptions", label: "가정·근거" },
];

export function Shell({ children }: { children: ReactNode }) {
  const path = usePathname();
  const { snapshot, loading, error } = useApp();
  return (
    <div className="mx-auto flex max-w-[1400px] flex-col gap-4 p-4 lg:flex-row">
      <div className="flex flex-col gap-4 lg:sticky lg:top-4 lg:h-fit lg:w-64 lg:shrink-0">
        <div>
          <h1 className="text-lg font-bold">식자재 발주 도우미</h1>
          {snapshot && (
            <p className="text-xs text-[var(--muted)]">
              기준일 {snapshot.meta.asOf} · 데이터 출처 {snapshot.meta.source === "db" ? "DB" : "번들(읽기 전용)"}
            </p>
          )}
        </div>
        <nav className="flex flex-wrap gap-1 lg:flex-col">
          {NAV.map((n) => (
            <Link key={n.href} href={n.href}
              className={`rounded px-3 py-1.5 text-sm ${path === n.href ? "bg-[var(--accent)] text-white" : "hover:bg-[var(--border)]"}`}>
              {n.label}
            </Link>
          ))}
        </nav>
        <div className="card"><SettingsPanel /></div>
      </div>
      <main className="flex min-w-0 flex-1 flex-col gap-4">
        {snapshot?.meta.fixture && (
          <div className="card border-[var(--medium)] text-sm">⚠ 개발용 합성 픽스처 데이터입니다 (제공 데이터 아님).</div>
        )}
        {error && <div className="card text-sm text-[var(--high)]">데이터 오류: {error}</div>}
        {loading && !snapshot ? <div className="card text-sm">불러오는 중…</div> : children}
      </main>
    </div>
  );
}
