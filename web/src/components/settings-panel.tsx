"use client";

import Link from "next/link";
import { DEFAULT_SETTINGS, type EngineSettings } from "@/lib/engine";
import { addDays } from "@/lib/engine/dates";
import { useApp } from "@/state/app-state";

/** 추천 설정 페이지에서 다루는 항목 (현재 시각은 매일 바꾸는 값이라 여기 남김) */
export const CALC_KEYS = ["demandAdjustPct", "lookbackWeeks", "applyPromo", "serviceLevel", "leadTimeBufferDays", "expiryWarnDays", "overstockDays"] as const satisfies readonly (keyof EngineSettings)[];

/** 왼쪽 패널: 매일 바꾸는 값(매장·기준일·현재 시각)만 */
export function SettingsPanel() {
  const { snapshot, asOf, storeId, setAsOf, setStoreId, settings, setSettings } = useApp();
  const changed = CALC_KEYS.filter((k) => settings[k] !== DEFAULT_SETTINGS[k]).length;
  return (
    <aside className="flex flex-col gap-4 text-sm">
      <h2 className="section-title">매장·날짜</h2>
      <label className="flex flex-col gap-1">
        <span className="hint !text-sm">매장</span>
        <select className="input" value={storeId ?? ""} onChange={(e) => setStoreId(e.target.value)}>
          {snapshot?.stores.map((s) => <option key={s.store_id} value={s.store_id}>{s.store_name} ({s.store_id})</option>)}
        </select>
      </label>
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
