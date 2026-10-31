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
  { href: "/inputs", label: "데이터 입력" },
  { href: "/settings", label: "계산 기준" },
  { href: "/assumptions", label: "가정·근거" },
];

export function Shell({ children }: { children: ReactNode }) {
  const path = usePathname();
  const { snapshot, loading, error } = useApp();
  const ov = snapshot?.meta.overlay;
  return (
    <div className="mx-auto flex max-w-[1400px] flex-col gap-4 p-4 lg:flex-row lg:gap-6 lg:p-6">
      <div className="flex flex-col gap-4 lg:sticky lg:top-6 lg:h-fit lg:w-64 lg:shrink-0">
        <div>
          <h1 className="text-[17px] font-bold tracking-[-0.02em]">식자재 발주 도우미</h1>
          {snapshot && (
            <p className="hint mt-0.5">
              {snapshot.stores.find((s) => s.store_id === snapshot.meta.storeId)?.store_name} · 기준일 {snapshot.meta.asOf}
              {snapshot.meta.source !== "db" && " · 읽기 전용"}
            </p>
          )}
        </div>
        <nav className="flex flex-wrap gap-1 lg:flex-col">
          {NAV.map((n) => {
            const active = path === n.href;
            return (
              <Link key={n.href} href={n.href} aria-current={active ? "page" : undefined}
                className={`btn-ghost justify-start ${active ? "!bg-[var(--accent-soft)] !text-[var(--accent)]" : ""}`}>
                {n.label}
              </Link>
            );
          })}
        </nav>
        <div className="card"><SettingsPanel /></div>
      </div>
      <main className="flex min-w-0 flex-1 flex-col gap-4">
        {snapshot?.meta.fixture && (
          <div className="status status-err">개발용 합성 픽스처 데이터입니다 (제공 데이터 아님).</div>
        )}
        {ov && (ov.estimated || ov.countedToday.length > 0 || ov.masterEdits.length > 0 || ov.priceEntries > 0 || ov.appOrders > 0) && (
          <div className="flex flex-wrap items-center gap-1.5 text-xs">
            <span className="hint">사용자 입력 반영 중:</span>
            {ov.estimated && <span className="badge badge-medium" title="제공 데이터 이후 재고를 업로드 판매로 이어 계산">추정 재고 (판매 {ov.uploadedThrough}까지)</span>}
            {ov.countedToday.length > 0 && <span className="badge badge-accent">기준일 실사 {ov.countedToday.length}품목</span>}
            {ov.masterEdits.length > 0 && <span className="badge badge-low">기준정보 수정 {ov.masterEdits.length}건</span>}
            {ov.priceEntries > 0 && <span className="badge badge-low">단가 변경 {ov.priceEntries}건</span>}
            {ov.appOrders > 0 && <span className="badge badge-muted">확정 발주 입고 예정 {ov.appOrders}건</span>}
            <Link href="/inputs" className="hint underline-offset-2 hover:underline">관리</Link>
          </div>
        )}
        {error && <div className="status status-err">데이터 오류: {error}</div>}
        {loading && !snapshot ? <Skeleton /> : children}
      </main>
    </div>
  );
}

function Skeleton() {
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-4" aria-busy="true" aria-label="불러오는 중">
      {[0, 1, 2, 3].map((i) => <div key={i} className="card h-20 animate-pulse" style={{ background: "var(--surface-2)" }} />)}
    </div>
  );
}
