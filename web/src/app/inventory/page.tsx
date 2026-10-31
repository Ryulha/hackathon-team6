"use client";

import { useState } from "react";
import { CartesianGrid, Legend, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { won } from "@/components/format";
import { DaysLeft, Qty } from "@/components/qty";
import { useInsights } from "@/components/use-insights";
import type { Insights } from "@/lib/insights";
import { diffDays, shortDate } from "@/lib/engine/dates";
import { daysOf, fmtQty } from "@/lib/engine/units";
import type { Ingredient } from "@/lib/types";
import { useApp } from "@/state/app-state";

/** 차트는 g·ml 품목이면 포장 단위로 그린다 (숫자만 봐도 양을 가늠할 수 있게) */
const MEASURED = new Set(["g", "ml"]);
const chartUnit = (ing: Ingredient) => (MEASURED.has(ing.use_unit) ? ing.order_unit : ing.use_unit);
const toChart = (q: number, ing: Ingredient) =>
  Math.round((MEASURED.has(ing.use_unit) ? q / ing.use_qty_per_order_unit : q) * 10) / 10;

export default function InventoryPage() {
  const { result, snapshot, settings } = useApp();
  const insights = useInsights(snapshot?.meta.storeId);
  const [sel, setSel] = useState<string | null>(null);
  if (!result || !snapshot) return null;
  const asOf = snapshot.meta.asOf;

  const rows = result.plans.map((p) => {
    const lots = snapshot.lots.filter((l) => l.ingredient_id === p.ingredient.ingredient_id && l.remaining_qty > 0)
      .sort((a, b) => a.last_use_date.localeCompare(b.last_use_date));
    return { p, days: daysOf(p.onHand, p.avgDailyNeed), firstExpiry: lots[0] };
  }).sort((a, b) => a.days - b.days);
  const plan = result.plans.find((p) => p.ingredient.ingredient_id === sel) ?? rows[0]?.p;
  if (!plan) return <div className="card text-sm">식자재 데이터가 없습니다.</div>;
  const ing = plan.ingredient;
  const unit = chartUnit(ing);

  // 과거: 실제 하루 끝 남은 양·사용량 / 미래: 추천 발주를 넣었을 때의 예상
  const history = snapshot.inventoryHistory.filter((r) => r.ingredient_id === ing.ingredient_id)
    .map((r) => ({ date: r.date, actualLeft: toChart(r.closing_qty, ing), actualUse: toChart(r.consumed_qty, ing) }));
  // 예상 남은 양은 '이번 발주'가 책임지는 기간(다음 발주 도착 전날)까지만 — 그 뒤는 다음 발주가 채우므로
  // 이후까지 그리면 재고가 0으로 떨어지는 것처럼 잘못 읽힌다
  const nextArrival = plan.nextSlot?.arrivalDate;
  const future = plan.planned.slice(0, settings.horizonDays).map((d) => ({
    date: d.date, planUse: toChart(d.need, ing),
    ...(!nextArrival || d.date < nextArrival ? { planLeft: toChart(d.closing, ing) } : {}),
  }));
  // 실제 → 예상 선이 끊기지 않도록 마지막 실제값을 예상 선의 시작점으로
  if (history.length && future.length) Object.assign(history[history.length - 1], { planLeft: history[history.length - 1].actualLeft });
  const lots = snapshot.lots.filter((l) => l.remaining_qty > 0).sort((a, b) => a.last_use_date.localeCompare(b.last_use_date));

  return (
    <>
      <header>
        <h2 className="text-xl font-bold tracking-[-0.02em]">재고·사용기한</h2>
        <p className="hint mt-1">품목마다 지금(오늘 07시 입고분 포함) 얼마나 남았고 며칠을 버틸 수 있는지, 언제까지 써야 하는지 보여줍니다. 빨간색은 다음 입고 전에 떨어지는 품목입니다. 품목을 누르면 아래에 재고 흐름이 나옵니다.</p>
      </header>

      <section className="card overflow-x-auto">
        <h3 className="section-title mb-2">품목별 재고 현황 <span className="hint">— 빨리 떨어지는 순</span></h3>
        <table className="tbl">
          <thead><tr><th>식자재</th><th className="num">남은 양</th><th>며칠 분량</th><th>가장 빨리 끝나는 사용기한</th><th>다음 입고</th></tr></thead>
          <tbody>
            {rows.map(({ p, days, firstExpiry }) => {
              const id = p.ingredient.ingredient_id;
              const left = firstExpiry ? diffDays(firstExpiry.last_use_date, asOf) : null;
              const next = p.nextIncoming;
              return (
                <tr key={id} className="row-hover cursor-pointer" aria-selected={id === ing.ingredient_id}
                  style={id === ing.ingredient_id ? { background: "var(--accent-soft)", boxShadow: "inset 3px 0 0 var(--brand)" } : undefined} onClick={() => setSel(id)}>
                  <td>{p.ingredient.ingredient_name}
                    <div className="hint">{p.ingredient.storage}
                      {insights?.wasteByIngredient[id] && <> · 폐기 주원인 <b>{insights.wasteByIngredient[id].reason}</b></>}</div></td>
                  <td className="num"><Qty qty={p.onHand} ing={p.ingredient} /></td>
                  <td><DaysLeft days={days} risk={p.shortageBeforeArrival > 0} /></td>
                  <td>{firstExpiry ? <>{shortDate(firstExpiry.last_use_date, asOf)} <Expiry left={left!} warn={settings.expiryWarnDays} /></> : <span className="hint">—</span>}</td>
                  <td className="hint">{next ? `${shortDate(next.date)} ${fmtQty(next.qty, p.ingredient)}` : p.slot && p.finalUnits > 0 ? `${shortDate(p.slot.arrivalDate)} (추천 발주 시 ${p.finalUnits}${p.ingredient.order_unit})` : "—"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>

      <section className="card">
        <div className="mb-1 flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="section-title">{ing.ingredient_name} 재고 흐름 <span className="hint">({unit} 기준)</span></h3>
          <span className="hint">하루 평균 사용 약 {fmtQty(plan.avgDailyNeed, ing)}</span>
        </div>
        <p className="hint mb-3">
          <b>남은 양</b>은 매일 영업이 끝난 뒤 남은 재고입니다. 오늘 이전은 실제 기록, 이후 점선은 <b>추천 수량대로 발주했을 때의 예상</b>으로,
          다음 발주가 도착하기 전({nextArrival ? shortDate(nextArrival) : "—"})까지만 그립니다. 점선이 0에 닿으면 그 전에 재료가 떨어진다는 뜻입니다.
        </p>
        <div className="h-72">
          <ResponsiveContainer>
            <LineChart data={[...history, ...future]} margin={{ top: 22, right: 8, bottom: 0, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
              <XAxis dataKey="date" tick={{ fontSize: 11, fill: "var(--muted)" }} tickFormatter={(d: string) => `${Number(d.slice(5, 7))}/${Number(d.slice(8))}`} minTickGap={24} />
              <YAxis tick={{ fontSize: 11, fill: "var(--muted)" }} width={44} />
              <Tooltip labelFormatter={(d) => shortDate(String(d))} formatter={(v) => `${Number(v).toLocaleString("ko-KR")}${unit}`}
                contentStyle={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 8, fontSize: 12 }} />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              <ReferenceLine x={asOf} stroke="var(--brand)" strokeWidth={2} label={{ value: "오늘", position: "top", fontSize: 11, fontWeight: 700, fill: "var(--foreground)" }} />
              {nextArrival && <ReferenceLine x={nextArrival} stroke="var(--muted)" strokeDasharray="2 2" label={{ value: "다음 입고", position: "top", fontSize: 11, fill: "var(--muted)" }} />}
              <ReferenceLine y={0} stroke="var(--high)" strokeOpacity={0.5} />
              <Line name="남은 양 (실제)" dataKey="actualLeft" stroke="var(--foreground)" strokeWidth={2} dot={false} />
              <Line name="남은 양 (예상)" dataKey="planLeft" stroke="var(--foreground)" strokeWidth={2} strokeDasharray="5 4" dot={false} />
              <Line name="하루 사용량 (실제)" dataKey="actualUse" stroke="var(--muted)" dot={false} />
              <Line name="하루 사용량 (예상)" dataKey="planUse" stroke="var(--muted)" strokeDasharray="5 4" dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </section>

      {insights && <WasteCauses data={insights} />}

      <section className="card overflow-x-auto">
        <h3 className="section-title">입고 묶음별 사용기한</h3>
        <p className="hint mb-2">같은 재료도 들어온 날마다 사용기한이 다릅니다. 기한이 빠른 것부터 쓰고, 마지막 날 영업이 끝나면 남은 양은 버립니다.</p>
        <table className="tbl">
          <thead><tr><th>식자재</th><th>들어온 날</th><th>언제까지 써야 하나</th><th className="num">남은 양</th></tr></thead>
          <tbody>
            {lots.map((l) => {
              const li = snapshot.ingredients.find((i) => i.ingredient_id === l.ingredient_id);
              const left = diffDays(l.last_use_date, asOf);
              return (
                <tr key={l.lot_id + l.ingredient_id}>
                  <td>{li?.ingredient_name ?? l.ingredient_id}</td>
                  <td className="hint">{l.receipt_date < snapshot.meta.dataStart ? "초기 재고" : shortDate(l.receipt_date)}</td>
                  <td>{shortDate(l.last_use_date, asOf)} <Expiry left={left} warn={settings.expiryWarnDays} /></td>
                  <td className="num">{li ? <Qty qty={l.remaining_qty} ing={li} /> : l.remaining_qty}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>
    </>
  );
}

function Expiry({ left, warn }: { left: number; warn: number }) {
  if (left < 0) return <span className="badge badge-high">기한 지남</span>;
  if (left === 0) return <span className="badge badge-high">오늘까지</span>;
  return <span className={`badge ${left <= warn ? "badge-medium" : "badge-muted"}`}>{left}일 남음</span>;
}

/** 폐기 원인 — 발주로 줄일 수 있는 폐기(기한 경과)와 매장 운영으로 줄여야 하는 폐기를 구분 (팀 데이터 분석) */
function WasteCauses({ data }: { data: Insights }) {
  const total = data.wasteReasons.reduce((a, r) => a + r.waste_cost, 0);
  const expiry = data.wasteReasons.find((r) => r.reason === "소비기한 경과");
  const expiryShare = expiry ? expiry.waste_cost / total : 0;
  return (
    <section className="card">
      <h3 className="section-title">폐기는 왜 생기나요?</h3>
      <p className="hint mb-3">
        데이터 분석 결과(전체 매장 1~9월) 폐기 비용 {won(total)} 중 <b>발주를 줄여서 막을 수 있는 건 사용기한 경과 {(expiryShare * 100).toFixed(0)}%</b>뿐입니다.
        나머지 {((1 - expiryShare) * 100).toFixed(0)}%는 보관·품질·조리 문제라 발주량이 아니라 매장 운영으로 줄여야 합니다. 발주 추천은 이 중 사용기한 경과만 줄이도록 계산합니다.
      </p>
      <ul className="flex flex-col gap-2">
        {data.wasteReasons.map((r) => {
          const byOrder = r.reason === "소비기한 경과";
          return (
            <li key={r.reason} className="grid grid-cols-[7rem_1fr_auto] items-center gap-3 text-sm">
              <span>{r.reason}</span>
              <span className="h-2.5 overflow-hidden rounded-full bg-[var(--surface-2)]" aria-hidden>
                <span className="block h-full rounded-full" style={{ width: `${(r.waste_cost / total) * 100}%`, background: byOrder ? "var(--brand)" : "var(--border-strong)" }} />
              </span>
              <span className="tabular-nums">{won(r.waste_cost)} <span className="hint">{(r.cost_share * 100).toFixed(0)}% · {byOrder ? "발주로 개선" : "운영 관리"}</span></span>
            </li>
          );
        })}
      </ul>
      {data.insights.length > 0 && (
        <details className="mt-3 text-sm">
          <summary className="cursor-pointer text-[var(--accent)]">분석 메모 보기</summary>
          <ul className="mt-2 ml-4 list-disc space-y-1 text-[var(--muted)]">{data.insights.map((t, i) => <li key={i}>{t}</li>)}</ul>
        </details>
      )}
    </section>
  );
}
