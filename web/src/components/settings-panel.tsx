"use client";

import Link from "next/link";
import { DEFAULT_SETTINGS, type EngineSettings } from "@/lib/engine";
import { addDays } from "@/lib/engine/dates";
import { useApp } from "@/state/app-state";

/** 추천 설정 페이지에서 다루는 항목 (현재 시각은 매일 바꾸는 값이라 여기 남김) */
export const CALC_KEYS = ["demandAdjustPct", "lookbackWeeks", "applyPromo", "serviceLevel", "leadTimeBufferDays", "expiryWarnDays", "overstockDays"] as const satisfies readonly (keyof EngineSettings)[];

/** 왼쪽 패널: 매일 바꾸는 값(매장·기준일·현재 시각)만 */
export function SettingsPanel() {
  const { snapshot, asOf, storeId, setAsOf, settings, setSettings } = useApp();
  const store = snapshot?.stores.find((s) => s.store_id === storeId);
  const logout = async () => {
    await fetch("/api/auth/logout", { method: "POST" }).catch(() => {});
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- 이전 매장 데이터가 메모리에 남지 않게 전체 새로고침
    window.location.href = "/login";
  };
  const changed = CALC_KEYS.filter((k) => settings[k] !== DEFAULT_SETTINGS[k]).length;
  return (
    <aside className="flex flex-col gap-4 text-sm">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <span className="hint">로그인한 매장</span>
          <p className="font-semibold">{store?.store_name ?? "…"} <span className="hint font-normal">관리자</span></p>
        </div>
        <button className="btn-ghost !px-2 !py-1 text-xs" onClick={logout}>로그아웃</button>
      </div>
      <label className="flex flex-col gap-1">
        <span className="hint !text-sm">기준일 (발주 판단일)</span>
        <input type="date" className="input" value={asOf ?? ""} min={snapshot?.meta.dataStart}
          max={snapshot ? addDays(snapshot.meta.dataEnd, 1) : undefined}
          onChange={(e) => setAsOf(e.target.value || null)} />
        {snapshot && <span className="hint">판매 기록 {snapshot.meta.dataStart} ~ {snapshot.meta.dataEnd}. 과거 날짜를 고르면 당시 추천을 실제 결과와 비교할 수 있습니다</span>}
      </label>
      <label className="flex flex-col gap-1">
        <span className="hint !text-sm">현재 시각 (발주 마감 판단)</span>
        <input type="time" className="input" value={settings.nowTime} onChange={(e) => setSettings({ nowTime: e.target.value })} />
      </label>
      <Link href="/settings" className="btn justify-between">
        <span>추천 방식 바꾸기</span>
        {changed > 0 ? <span className="badge badge-accent">{changed}개 변경</span> : <span className="hint">기본</span>}
      </Link>
    </aside>
  );
}
