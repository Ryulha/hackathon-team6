"use client";

import { type EngineSettings } from "@/lib/engine";
import { addDays } from "@/lib/engine/dates";
import { useApp } from "@/state/app-state";

/** 추천 설정 페이지에서 다루는 항목 */
export const CALC_KEYS = ["demandAdjustPct", "lookbackWeeks", "applyPromo", "serviceLevel", "leadTimeBufferDays", "expiryWarnDays", "overstockDays"] as const satisfies readonly (keyof EngineSettings)[];

/** 왼쪽 패널: 로그인한 매장과 로그아웃만 (날짜·시각은 더보기의 시연용 설정으로) */
export function SettingsPanel() {
  const { snapshot, storeId } = useApp();
  const store = snapshot?.stores.find((s) => s.store_id === storeId);
  const logout = async () => {
    await fetch("/api/auth/logout", { method: "POST" }).catch(() => {});
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- 이전 매장 데이터가 메모리에 남지 않게 전체 새로고침
    window.location.href = "/login";
  };
  return (
    <aside className="flex items-start justify-between gap-2 text-sm">
      <div className="min-w-0">
        <span className="hint">로그인한 매장</span>
        <p className="font-semibold">{store?.store_name ?? "…"} <span className="hint font-normal">관리자</span></p>
      </div>
      <button className="btn-ghost !px-2 !py-1 text-xs" onClick={logout}>로그아웃</button>
    </aside>
  );
}

/** 시연용: 날짜·현재 시각 바꾸기 — 조건을 바꾸면 결과가 바뀌는 것을 보여줄 때 */
export function DemoControls() {
  const { snapshot, asOf, setAsOf, settings, setSettings } = useApp();
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <label className="flex flex-col gap-1 text-sm">
        <span className="font-medium">오늘 날짜로 볼 날</span>
        <input type="date" className="input" value={asOf ?? ""} min={snapshot?.meta.dataStart}
          max={snapshot ? addDays(snapshot.meta.dataEnd, 1) : undefined}
          onChange={(e) => setAsOf(e.target.value || null)} />
        {snapshot && <span className="hint">판매 기록 {snapshot.meta.dataStart} ~ {snapshot.meta.dataEnd}. 과거 날짜를 고르면 그날 추천을 실제 결과와 비교할 수 있어요.
          {asOf !== addDays(snapshot.meta.dataEnd, 1) && <> <button className="underline underline-offset-2" onClick={() => setAsOf(null)}>오늘로 돌아가기</button></>}</span>}
      </label>
      <label className="flex flex-col gap-1 text-sm">
        <span className="font-medium">지금 시각</span>
        <input type="time" className="input" value={settings.nowTime} onChange={(e) => setSettings({ nowTime: e.target.value })} />
        <span className="hint">공급사 마감 시각이 지나면 그 공급사 주문은 다음 발주일로 넘어가요.</span>
      </label>
    </div>
  );
}
