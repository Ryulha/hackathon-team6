"use client";

import { addDays } from "@/lib/engine/dates";
import { useApp } from "@/state/app-state";
import type { EngineSettings } from "@/lib/engine";

type NumKey = { [K in keyof EngineSettings]: EngineSettings[K] extends number ? K : never }[keyof EngineSettings];

const NUMS: { key: NumKey; label: string; min: number; max: number; step: number; hint: string }[] = [
  { key: "demandAdjustPct", label: "수요 조정 (%)", min: -50, max: 100, step: 5, hint: "행사·날씨 등 예상 변화 반영" },
  { key: "lookbackWeeks", label: "예측 기준 기간 (주)", min: 1, max: 12, step: 1, hint: "최근 N주 동요일 평균" },
  { key: "safetyDays", label: "안전재고 (일치)", min: 0, max: 7, step: 0.5, hint: "일평균 소요 × N일" },
  { key: "leadTimeBufferDays", label: "입고 지연 대비 (일)", min: 0, max: 3, step: 1, hint: "리드타임에 더함" },
  { key: "expiryWarnDays", label: "사용기한 임박 기준 (일)", min: 0, max: 7, step: 1, hint: "" },
  { key: "overstockDays", label: "과잉 기준 (일치)", min: 3, max: 30, step: 1, hint: "현재고 ÷ 일평균 소요" },
];

export function SettingsPanel() {
  const { snapshot, asOf, storeId, setAsOf, setStoreId, settings, setSettings, resetSettings } = useApp();
  return (
    <aside className="flex flex-col gap-4 text-sm accent-[var(--accent)]">
      <div className="flex items-center justify-between">
        <h2 className="section-title">조건 설정</h2>
        <button className="btn-ghost !px-2 !py-1 text-xs" onClick={resetSettings}>기본값</button>
      </div>
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
      <label className="flex items-center gap-2">
        <input type="checkbox" checked={settings.applyPromo} onChange={(e) => setSettings({ applyPromo: e.target.checked })} />
        프로모션 효과 반영
      </label>
      {NUMS.map((n) => (
        <label key={n.key} className="flex flex-col gap-1">
          <span className="flex justify-between"><span className="hint !text-sm">{n.label}</span><b className="tabular-nums">{settings[n.key]}</b></span>
          <input type="range" min={n.min} max={n.max} step={n.step} value={settings[n.key]}
            onChange={(e) => setSettings({ [n.key]: Number(e.target.value) } as Partial<EngineSettings>)} />
          {n.hint && <span className="hint">{n.hint}</span>}
        </label>
      ))}
    </aside>
  );
}
