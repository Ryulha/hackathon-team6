"use client";

import type { HolidayMode } from "@/lib/engine/forecast";
import { addDays, shortDate } from "@/lib/engine/dates";
import { useApp } from "@/state/app-state";

const AHEAD_DAYS = 14;

/**
 * 다가오는 공휴일 (공휴일 캘린더 연동) — 그날을 어떻게 볼지 점장이 고르면 주문 수량이 바로 다시 계산된다.
 */
export function HolidayNote() {
  const { snapshot, result, settings, setSettings } = useApp();
  if (!snapshot || !result) return null;
  const asOf = snapshot.meta.asOf;
  const until = addDays(asOf, AHEAD_DAYS);
  const upcoming = snapshot.holidays.filter((h) => h.date >= asOf && h.date < until);
  if (!upcoming.length) return null;

  const m = result.ctx.holMult;
  const effect = m >= 1 ? `평소보다 ${Math.round((m - 1) * 100)}% 더` : `평소보다 ${Math.round((1 - m) * 100)}% 덜`;
  const MODES: { key: HolidayMode; label: string }[] = [
    { key: "auto", label: `지난 공휴일처럼 (×${m.toFixed(2)})` },
    { key: "weekday", label: "평일처럼" },
    { key: "closed", label: "쉬는 날" },
  ];
  const setMode = (date: string, mode: HolidayMode) => setSettings({ holidayPlan: { ...settings.holidayPlan, [date]: mode } });
  const fromCalendar = upcoming.some((h) => h.source === "calendar");

  return (
    <section className="card flex flex-col gap-2 !py-3 text-sm">
      <p>
        <b>📅 2주 안에 공휴일 {upcoming.length}일</b>
        <span className="hint"> · 이 매장은 지난 공휴일에 {effect} 팔렸어요. 그날 쓸 재료가 주문 수량에 반영됩니다.</span>
      </p>
      <ul className="flex flex-col gap-2">
        {upcoming.map((h) => {
          const mode = settings.holidayPlan?.[h.date] ?? "auto";
          return (
            <li key={h.date} className="flex flex-wrap items-center justify-between gap-2">
              <span><b>{shortDate(h.date)}</b> {h.name}</span>
              <span className="tabs" role="radiogroup" aria-label={`${shortDate(h.date)} ${h.name} 운영`}>
                {MODES.map((x) => (
                  <button key={x.key} role="radio" aria-checked={mode === x.key} className="tab !px-2.5 text-xs" onClick={() => setMode(h.date, x.key)}>{x.label}</button>
                ))}
              </span>
            </li>
          );
        })}
      </ul>
      <p className="hint">{fromCalendar ? "대한민국 공휴일 캘린더(구글 공개 캘린더)에서 자동으로 받아옵니다." : "공휴일 캘린더에 연결하지 못해 미리 넣어 둔 공휴일을 씁니다."} 쉬는 날로 바꾸면 그날 판매를 0으로 보고 주문을 줄여요.</p>
    </section>
  );
}
