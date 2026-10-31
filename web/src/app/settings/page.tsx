"use client";

import { useMemo, type ReactNode } from "react";
import { won } from "@/components/format";
import { CALC_KEYS } from "@/components/settings-panel";
import { DEFAULT_SETTINGS, OPT, SERVICE_LEVELS, runEngine, type EngineResult, type EngineSettings, type ServiceLevel } from "@/lib/engine";
import { fmtQty } from "@/lib/engine/units";
import { useApp } from "@/state/app-state";

type NumKey = "demandAdjustPct" | "lookbackWeeks" | "leadTimeBufferDays" | "expiryWarnDays" | "overstockDays";

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
            <>최근 몇 주 판매로 메뉴별 평소 수준을 잡고, 여기에 <b>요일별 차이</b>(최근 {settings.lookbackWeeks * 2}주 매장 전체 판매 기준)와
              <b> 공휴일 효과</b>(과거 공휴일이 같은 요일 평일보다 몇 배였는지, 현재 ×{result.ctx.holMult.toFixed(2)})를 곱해 예측합니다.
              짧으면 최근 변화를 빨리 따라가고, 길면 들쭉날쭉한 날의 영향이 줄어듭니다.</>)}
          {num("demandAdjustPct", "수요 증감", "%", -50, 100, 5,
            <>데이터에 없는 변화(행사 예정, 날씨, 주변 공사 등)를 예상할 때 전체 수요를 이만큼 늘리거나 줄입니다. 예: +20%면 모든 메뉴를 20% 더 팔릴 것으로 보고 계산합니다.</>)}
          <PromoControl />
        </section>

        <section className="card flex flex-col gap-5">
          <h3 className="section-title">발주 여유분</h3>
          <Control label="얼마나 넉넉하게 주문할까요?" value={SERVICE_LEVELS[settings.serviceLevel].label}
            changed={settings.serviceLevel !== DEFAULT_SETTINGS.serviceLevel} defaultText={`기본 ${SERVICE_LEVELS[DEFAULT_SETTINGS.serviceLevel].label}`}
            desc={<>판매는 날마다 들쭉날쭉해서 예측보다 많이 팔리는 날이 있습니다. 최근 8주 동안 하루 사용량이 예측에서 얼마나 벗어났는지(변동폭)를 재고,
              다음 입고까지 그 변동을 버틸 만큼 여유분을 더 주문합니다.
              {example && <> 예: {example.ingredient.ingredient_name}은 하루 변동폭이 약 {fmtQty(example.sigma, example.ingredient)}입니다.</>}
              <span className="mt-1 block">사용기한 {OPT.longShelf}일 이상인 품목은 남아도 버릴 위험이 낮아 항상 &lsquo;넉넉하게&rsquo; 이상으로, 최근 {OPT.stockoutWindow}일 안에 품절된 품목은 한 단계 더 넉넉하게 잡습니다.</span></>}>
            <div className="tabs w-full" role="radiogroup" aria-label="여유분 수준">
              {(Object.keys(SERVICE_LEVELS) as ServiceLevel[]).map((k) => (
                <button key={k} role="radio" aria-checked={settings.serviceLevel === k}
                  className="tab flex-1" onClick={() => setSettings({ serviceLevel: k })} title={SERVICE_LEVELS[k].hint}>
                  {SERVICE_LEVELS[k].label}
                </button>
              ))}
            </div>
            <span className="hint">{SERVICE_LEVELS[settings.serviceLevel].hint}</span>
          </Control>
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

/** 행사 진행 가정 — 과거 행사 때의 메뉴별 판매 배수를 예측에 곱한다 (팀 엔진 promo_on) */
function PromoControl() {
  const { snapshot, result, settings, setSettings } = useApp();
  const menuName = (id: string) => snapshot!.menus.find((m) => m.menu_id === id)?.menu_name ?? id;
  const withHistory = result!.basis.filter((b) => b.promoMult !== undefined);
  return (
    <Control label="행사를 한다면?" value={settings.applyPromo ? "행사 진행 가정" : "평소대로"} changed={settings.applyPromo !== DEFAULT_SETTINGS.applyPromo} defaultText="기본 평소대로"
      desc={<>
        이 매장에서 과거에 했던 행사(08_promotions) 기간에 대상 메뉴가 직전 4주보다 몇 배 팔렸는지 계산해 두었다가, 켜면 그 배수를 예측에 곱합니다.
        행사를 앞두고 발주량을 미리 가늠할 때 쓰세요.
        <span className="mt-1.5 block rounded-md bg-[var(--surface-2)] px-2.5 py-1.5 text-[var(--foreground)]">
          {withHistory.length
            ? <>이 매장 행사 효과: {withHistory.map((b) => `${menuName(b.menuId)} ×${b.promoMult!.toFixed(2)}`).join(" · ")}</>
            : <>이 매장에는 과거 행사 기록이 없어 켜도 결과가 같습니다. (제공 데이터의 행사는 가상매장 B 7월 1건뿐입니다.)</>}
        </span>
      </>}>
      <label className="inline-flex cursor-pointer items-center gap-2 text-sm">
        <input type="checkbox" className="h-4 w-4 accent-[var(--brand)]" checked={settings.applyPromo} onChange={(e) => setSettings({ applyPromo: e.target.checked })} />
        행사를 진행한다고 보고 계산
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
