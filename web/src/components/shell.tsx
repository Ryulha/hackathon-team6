"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { useApp, type Role } from "@/state/app-state";
import { SettingsPanel } from "./settings-panel";

type NavItem = { href: string; label: string; icon: string };

/** 역할별 메뉴 — 각자 매일 하는 일만 */
const NAV: Record<Role, NavItem[]> = {
  staff: [
    { href: "/checks", label: "오늘 점검", icon: "✓" },
    { href: "/count", label: "재고 세기", icon: "#" },
  ],
  manager: [
    { href: "/", label: "오늘 주문", icon: "🛒" },
    { href: "/checks", label: "점검", icon: "✓" },
    { href: "/count", label: "재고 세기", icon: "#" },
    { href: "/more", label: "더보기", icon: "⋯" },
  ],
  supervisor: [
    { href: "/diagnosis", label: "매장 진단", icon: "📊" },
    { href: "/overview", label: "매장 보기", icon: "🏪" },
    { href: "/assumptions", label: "근거", icon: "ⓘ" },
  ],
};
/** 점장 '더보기' 아래 상세 화면 — 메뉴에서는 '더보기'가 선택된 것으로 표시 */
const MORE_PAGES = ["/overview", "/orders", "/inventory", "/inputs", "/settings", "/assumptions"];

export function Shell({ children }: { children: ReactNode }) {
  const path = usePathname();
  const { me, snapshot, result, loading, error, completed, viewStore, setViewStore } = useApp();
  // 로그인 화면은 사이드바 없이 전체 화면
  if (path === "/login") return <>{children}</>;

  const role = me?.role;
  const nav = role ? NAV[role] : [];
  const inMore = role === "manager" && MORE_PAGES.includes(path);
  const isActive = (href: string) => path === href || (href === "/more" && inMore);
  // 오늘 마감인데 아직 '주문 완료'하지 않은 공급사 수 (점장)
  const remaining = role === "manager" && result
    ? new Set(result.orders.filter((o) => o.isToday && !completed.has(o.supplier.supplier_id)).map((o) => o.supplier.supplier_id)).size : 0;
  const ov = snapshot?.meta.overlay;
  const storeName = snapshot?.stores.find((s) => s.store_id === snapshot.meta.storeId)?.store_name;

  const badge = (href: string) => href === "/" && remaining > 0 && (
    <span className="badge !rounded-full" style={{ background: "var(--brand)", color: "var(--on-brand)" }} aria-label={`남은 주문 ${remaining}곳`}>{remaining}</span>
  );

  // 슈퍼바이저: 매장 상세 화면에서 매장 고르기
  const storePicker = role === "supervisor" && snapshot && path !== "/diagnosis" && (
    <select className="input !py-1 text-sm" value={viewStore ?? ""} onChange={(e) => setViewStore(e.target.value)} aria-label="볼 매장">
      {snapshot.stores.map((s) => <option key={s.store_id} value={s.store_id}>{s.store_name}</option>)}
    </select>
  );

  return (
    <div className="mx-auto flex max-w-[1400px] flex-col gap-4 px-4 pt-3 pb-24 lg:flex-row lg:gap-6 lg:p-6">
      {/* 휴대폰: 위쪽에 로고·매장·이름만 */}
      <header className="flex items-center justify-between gap-2 lg:hidden">
        <Link href={me?.home ?? "/"} aria-label="첫 화면으로">
          <Image src="/brand/crycheese-logo.webp" alt="크라이치즈버거" width={132} height={35} priority className="h-auto w-32" />
        </Link>
        <div className="flex items-center gap-2">
          {storePicker}
          <SettingsPanel compact />
        </div>
      </header>

      {/* 컴퓨터: 왼쪽 사이드바 */}
      <div className="hidden flex-col gap-4 lg:sticky lg:top-6 lg:flex lg:h-fit lg:w-64 lg:shrink-0">
        <div>
          <Link href={me?.home ?? "/"} aria-label="첫 화면으로">
            <Image src="/brand/crycheese-logo.webp" alt="크라이치즈버거" width={176} height={46} priority className="h-auto w-44" />
          </Link>
          <h1 className="mt-2 text-[15px] font-bold tracking-[-0.02em]">식자재 발주 도우미</h1>
          {snapshot && (
            <p className="hint mt-0.5">
              {role === "supervisor" ? "전 매장" : storeName} · {snapshot.meta.asOf}
              {snapshot.meta.source !== "db" && " · 읽기 전용"}
            </p>
          )}
        </div>
        <nav className="flex flex-col gap-1">
          {nav.map((n) => (
            <Link key={n.href} href={n.href} aria-current={isActive(n.href) ? "page" : undefined}
              className={`btn-ghost justify-between ${isActive(n.href) ? "nav-active" : ""}`}>
              {n.label}{badge(n.href)}
            </Link>
          ))}
        </nav>
        {storePicker && <label className="flex flex-col gap-1 text-sm"><span className="hint">볼 매장</span>{storePicker}</label>}
        <div className="card"><SettingsPanel /></div>
      </div>

      <main className="flex min-w-0 flex-1 flex-col gap-4">
        {snapshot?.meta.fixture && (
          <div className="status status-err">개발용 합성 픽스처 데이터입니다 (제공 데이터 아님).</div>
        )}
        {inMore && <Link href="/more" className="hint w-fit hover:underline">← 더보기</Link>}
        {/* 입력 반영 현황은 점장 상세 화면에서만 — 매일 쓰는 화면은 단순하게 */}
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

      {/* 휴대폰: 아래쪽 탭바 (엄지로 누르기 쉬운 위치) */}
      {nav.length > 0 && (
        <nav className="fixed inset-x-0 bottom-0 z-20 border-t lg:hidden" style={{ background: "var(--surface)", borderColor: "var(--border)", paddingBottom: "env(safe-area-inset-bottom)" }}>
          <ul className="mx-auto flex max-w-lg">
            {nav.map((n) => {
              const on = isActive(n.href);
              return (
                <li key={n.href} className="flex-1">
                  <Link href={n.href} aria-current={on ? "page" : undefined}
                    className="relative flex min-h-14 flex-col items-center justify-center gap-0.5 text-xs"
                    style={{ color: on ? "var(--foreground)" : "var(--muted)", fontWeight: on ? 700 : 500 }}>
                    {on && <span className="absolute top-0 h-[3px] w-10 rounded-b" style={{ background: "var(--brand)" }} />}
                    <span aria-hidden className="text-lg leading-none">{n.icon}</span>
                    <span className="flex items-center gap-1">{n.label}{badge(n.href)}</span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>
      )}
    </div>
  );
}

function Skeleton() {
  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-2" aria-busy="true" aria-label="불러오는 중">
      {[0, 1, 2, 3].map((i) => <div key={i} className="card h-20 animate-pulse" style={{ background: "var(--surface-2)" }} />)}
    </div>
  );
}
