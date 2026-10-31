"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { useApp } from "@/state/app-state";
import { SettingsPanel } from "./settings-panel";

/** 매일 쓰는 두 가지 + 나머지는 더보기 */
const NAV = [
  { href: "/", label: "오늘 주문" },
  { href: "/count", label: "재고 세기" },
  { href: "/more", label: "더보기" },
];
/** 더보기 아래 상세 화면 — 메뉴에서는 '더보기'가 선택된 것으로 표시 */
const MORE_PAGES = ["/overview", "/orders", "/inventory", "/inputs", "/settings", "/assumptions"];

export function Shell({ children }: { children: ReactNode }) {
  const path = usePathname();
  const { snapshot, result, loading, error, completed } = useApp();
  const ov = snapshot?.meta.overlay;
  const inMore = MORE_PAGES.includes(path);
  // 오늘 마감인데 아직 '주문 완료'하지 않은 공급사 수
  const remaining = result ? new Set(result.orders.filter((o) => o.isToday && !completed.has(o.supplier.supplier_id)).map((o) => o.supplier.supplier_id)).size : 0;
  // 로그인 화면은 사이드바 없이 전체 화면
  if (path === "/login") return <>{children}</>;
  return (
    <div className="mx-auto flex max-w-[1400px] flex-col gap-4 p-4 lg:flex-row lg:gap-6 lg:p-6">
      <div className="flex flex-col gap-4 lg:sticky lg:top-6 lg:h-fit lg:w-64 lg:shrink-0">
        <div>
          <Link href="/" aria-label="오늘 주문으로">
            <Image src="/brand/crycheese-logo.webp" alt="크라이치즈버거" width={176} height={46} priority className="h-auto w-44" />
          </Link>
          <h1 className="mt-2 text-[15px] font-bold tracking-[-0.02em]">식자재 발주 도우미</h1>
          {snapshot && (
            <p className="hint mt-0.5">
              {snapshot.stores.find((s) => s.store_id === snapshot.meta.storeId)?.store_name} · {snapshot.meta.asOf}
              {snapshot.meta.source !== "db" && " · 읽기 전용"}
            </p>
          )}
        </div>
        <nav className="flex flex-wrap gap-1 lg:flex-col">
          {NAV.map((n) => {
            const active = path === n.href || (n.href === "/more" && inMore);
            return (
              <Link key={n.href} href={n.href} aria-current={active ? "page" : undefined}
                className={`btn-ghost justify-between ${active ? "nav-active" : ""}`}>
                {n.label}
                {n.href === "/" && remaining > 0 && (
                  <span className="badge !rounded-full" style={{ background: "var(--brand)", color: "var(--on-brand)" }} aria-label={`남은 주문 ${remaining}곳`}>{remaining}</span>
                )}
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
        {inMore && <Link href="/more" className="hint w-fit hover:underline">← 더보기</Link>}
        {/* 입력 반영 현황은 상세 화면에서만 — 매일 쓰는 화면은 단순하게 */}
        {inMore && ov && (ov.estimated || ov.countedToday.length > 0 || ov.masterEdits.length > 0 || ov.priceEntries > 0 || ov.appOrders > 0) && (
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
