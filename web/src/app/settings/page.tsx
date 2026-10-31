"use client";

import { useMemo, type ReactNode } from "react";
import { won } from "@/components/format";
import { CALC_KEYS } from "@/components/settings-panel";
import { DEFAULT_SETTINGS, runEngine, type EngineResult, type EngineSettings } from "@/lib/engine";
import { addDays, parseList, shortDate } from "@/lib/engine/dates";
import { fmtQty } from "@/lib/engine/units";
import { useApp } from "@/state/app-state";

type NumKey = "demandAdjustPct" | "lookbackWeeks" | "safetyDays" | "leadTimeBufferDays" | "expiryWarnDays" | "overstockDays";

export default function SettingsPage() {
  const { snapshot, result, settings, setSettings, overrides } = useApp();
  // 같은 데이터·같은 현재 시각에서 기본값으로 계산한 결과와 비교
  const base = useMemo(
    () => (snapshot ? runEngine(snapshot, { ...DEFAULT_SETTINGS, nowTime: settings.nowTime }, overrides) : null),
    [snapshot, settings.nowTime, overrides],
  );
  if (!snapshot || !result || !base) return null;

  const changed = CALC_KEYS.filter((k) => settings[k] !== DEFAULT_SETTINGS[k]);
  const reset = () => setSettings(Object.fromEntries(CALC_KEYS.map((k) => [k, DEFAULT_SETTINGS[k]])) as Partial<EngineSettings>);
  // 설명 문장에 넣을 예시 품목 — 기본값 결과에서 골라 슬라이더를 움직여도 바뀌지 않게
  const example = [...base.plans].filter((p) => p.avgDailyNeed > 0).sort((a, b) => b.amount - a.amount)[0];

  const num = (key: NumKey, label: string, unit: string, min: number, max: number, step: number, desc: ReactNode) => (
    <Control label={label} value={`${settings[key]}${unit}`} changed={settings[key] !== DEFAULT_SETTINGS[key]} desc={desc}
      defaultText={`기본 ${DEFAULT_SETTINGS[key]}${unit}`}>
      <input type="range" className="w-full accent-[var(--brand)]" min={min} max={max} step={step} value={settings[key]}
        aria-label={label} onChange={(e) => setSettings({ [key]: Number(e.target.value) } as Partial<EngineSettings>)} />
    </Control>
  );

  return (
    <>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <header>
          <h2 className="text-xl font-bold tracking-[-0.02em]">추천 설정</h2>
          <p className="hint mt-1">주문을 얼마나 넉넉하게 할지, 어떤 때 알려줄지 내 매장에 맞게 정해 보세요. 바꾸면 모든 화면에 바로 반영되고, 아래에서 처음 설정과 비교해 볼 수 있습니다.</p>
        </header>
        <button className="btn" disabled={!changed.length} onClick={reset}>모두 기본값으로</button>
      </div>

      <Impact result={result} base={base} changed={changed.length > 0} />

      <div className="grid gap-4 lg:grid-cols-2">
        <section className="card flex flex-col gap-5">
          <h3 className="section-title">수요 예측</h3>
          {num("lookbackWeeks", "예측에 쓸 과거 기간", "주", 1, 12, 1,
            <>최근 몇 주의 <b>같은 요일</b> 판매를 평균 내어 앞으로의 수요로 봅니다. 짧으면 최근 변화를 빨리 따라가고, 길면 들쭉날쭉한 날의 영향이 줄어듭니다.</>)}
          {num("demandAdjustPct", "수요 증감", "%", -50, 100, 5,
            <>데이터에 없는 변화(행사 예정, 날씨, 주변 공사 등)를 예상할 때 전체 수요를 이만큼 늘리거나 줄입니다. 예: +20%면 모든 메뉴를 20% 더 팔릴 것으로 보고 계산합니다.</>)}
          <PromoControl />
        </section>

        <section className="card flex flex-col gap-5">
          <h3 className="section-title">발주 여유분</h3>
          {num("safetyDays", "여유분(안전재고)", "일치", 0, 7, 0.5,
            <>예측보다 많이 팔릴 때를 대비해 하루 사용량의 몇 일치를 더 주문할지 정합니다.
              {example && <> 예: {example.ingredient.ingredient_name}은 하루 약 {fmtQty(example.avgDailyNeed, example.ingredient)}를 쓰므로 1일치면 그만큼 더 주문합니다.</>}
              {" "}늘리면 품절 위험은 줄지만 재고·폐기가 늘어납니다.</>)}
          {num("leadTimeBufferDays", "입고 지연 대비", "일", 0, 3, 1,
            <>공급사가 늦게 가져올 것에 대비해 도착일을 이만큼 늦춰 잡고 계산합니다. 제공 데이터에는 지연 입고가 없어서 기본은 0일입니다.</>)}
        </section>

        <section className="card flex flex-col gap-5">
          <h3 className="section-title">알림 기준</h3>
          {num("expiryWarnDays", "사용기한 임박 알림", "일 전", 0, 7, 1,
            <>마지막 사용일까지 이 일수 이내로 남았고, 그때까지 다 못 써서 버리게 될 양이 있으면 알려줍니다.</>)}
          {num("overstockDays", "과잉 재고 알림", "일치 초과", 3, 30, 1,
            <>지금 재고가 하루 사용량의 이 일수를 넘으면 너무 많다고 알려줍니다.</>)}
        </section>
      </div>
    </>
  );
}

function Control({ label, value, changed, desc, defaultText, children }: {
  label: string; value: string; changed: boolean; desc: ReactNode; defaultText: string; children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-2">
        <span className="font-medium">{label}</span>
        <span className="flex items-center gap-1.5">
          {changed && <span className="hint">{defaultText}</span>}
          <b className={`tabular-nums ${changed ? "text-[var(--accent)]" : ""}`}>{value}</b>
        </span>
      </div>
      {children}
      <p className="hint">{desc}</p>
    </div>
  );
}

/** 프로모션 반영 — 지금 매장·기간에 실제로 영향이 있는지 함께 보여준다 */
function PromoControl() {
  const { snapshot, settings, setSettings } = useApp();
  const snap = snapshot!;
  const asOf = snap.meta.asOf;
  const histFrom = addDays(asOf, -7 * settings.lookbackWeeks);
  const menuName = (id: string) => snap.menus.find((m) => m.menu_id === id)?.menu_name ?? id;
  const promos = snap.promotions;
  const upcoming = promos.filter((p) => p.end_date >= asOf);
  const inHistory = promos.filter((p) => p.end_date >= histFrom && p.start_date < asOf);
  const describe = (p: (typeof promos)[number]) =>
    `${p.promo_type} ${shortDate(p.start_date)}~${shortDate(p.end_date)} (${parseList(p.target_menu).map(menuName).join(", ")})`;

  return (
    <Control label="행사(프로모션) 효과 반영" value={settings.applyPromo ? "켜짐" : "꺼짐"} changed={!settings.applyPromo} defaultText="기본 켜짐"
      desc={<>
        행사 기록(08_promotions)이 있는 메뉴는 행사 기간에 평소보다 많이 팔립니다. 켜 두면 과거 행사 때 평소보다 몇 배 팔렸는지 계산해 앞으로의 행사 기간 예측에 곱합니다.
        (평소 수요를 계산할 때 과거 행사 기간은 켜고 끄는 것과 관계없이 항상 빼서, 행사 때문에 평소 예측이 부풀지 않게 합니다.)
        <span className="mt-1.5 block rounded-md bg-[var(--surface-2)] px-2.5 py-1.5 text-[var(--foreground)]">
          {upcoming.length
            ? <>이 매장에 예정된 행사: {upcoming.map(describe).join(" · ")} → 해당 기간 예측에 반영됩니다.</>
            : inHistory.length
              ? <>앞으로 예정된 행사는 없습니다. 예측 기간 안의 과거 행사({inHistory.map(describe).join(" · ")})는 평소 수요 계산에서 제외됩니다.</>
              : <>이 매장·기간에는 행사가 없어 켜든 끄든 결과가 같습니다.{promos.length ? ` (이 매장 행사: ${promos.map(describe).join(" · ")})` : " 제공 데이터의 행사는 S02 매장 7월 1건뿐입니다."}</>}
        </span>
      </>}>
      <label className="inline-flex cursor-pointer items-center gap-2 text-sm">
        <input type="checkbox" className="h-4 w-4 accent-[var(--brand)]" checked={settings.applyPromo} onChange={(e) => setSettings({ applyPromo: e.target.checked })} />
        행사 기간 수요 보정
      </label>
    </Control>
  );
}

/** 지금 기준 vs 기본값: 추천 결과가 어떻게 달라지는지 */
function Impact({ result, base, changed }: { result: EngineResult; base: EngineResult; changed: boolean }) {
  const sum = (r: EngineResult) => ({
    amount: r.orders.reduce((a, o) => a + o.amount, 0),
    items: r.plans.filter((p) => p.finalUnits > 0).length,
    risk: r.plans.filter((p) => p.plannedShortage > 0).length,
    waste: r.alerts.filter((a) => a.kind === "expiry").length,
  });
  const now = sum(result);
  const was = sum(base);
  const cell = (label: string, v: number, b: number, fmt: (n: number) => string, lowerIsGood: boolean) => {
    const d = v - b;
    const good = lowerIsGood ? d < 0 : d > 0;
    return (
      <div>
        <div className="hint">{label}</div>
        <div className="mt-0.5 text-lg font-bold tabular-nums">{fmt(v)}</div>
        <div className="text-xs tabular-nums" style={{ color: !d ? "var(--muted)" : good ? "var(--accent)" : "var(--high)" }}>
          {!d ? "기본값과 같음" : `${d > 0 ? "+" : "−"}${fmt(Math.abs(d))}`}
        </div>
      </div>
    );
  };
  return (
    <section className="card">
      <h3 className="section-title">{changed ? "기본값과 비교한 추천 결과" : "현재 추천 결과 (기본값)"}</h3>
      <div className="mt-3 grid grid-cols-2 gap-4 md:grid-cols-4">
        {cell("추천 발주 총액", now.amount, was.amount, won, true)}
        {cell("발주할 품목", now.items, was.items, (n) => `${n}개`, true)}
        {cell("추천대로 해도 모자랄 품목", now.risk, was.risk, (n) => `${n}개`, true)}
        {cell("사용기한 임박 알림", now.waste, was.waste, (n) => `${n}개`, true)}
      </div>
    </section>
  );
}
