"use client";

import Link from "next/link";
import { useState, useSyncExternalStore, type ReactNode } from "react";
import { won } from "@/components/format";
import { DaysLeft, Qty } from "@/components/qty";
import { useInsights } from "@/components/use-insights";
import { shortDate, weekdayOf } from "@/lib/engine/dates";
import { daysOf, fmtQty } from "@/lib/engine/units";
import { useApp } from "@/state/app-state";

const GUIDE_KEY = "guide-dismissed-v1";

export default function Dashboard() {
  const { result, snapshot, settings } = useApp();
  const insights = useInsights(snapshot?.meta.storeId);
  if (!result || !snapshot) return null;
  const { alerts, orders, plans } = result;
  const store = snapshot.stores.find((s) => s.store_id === snapshot.meta.storeId);
  const byKind = (k: string) => alerts.filter((a) => a.kind === k);
  const planOf = (id?: string) => plans.find((p) => p.ingredient.ingredient_id === id);

  const shortage = byKind("shortage");
  const todayOrders = orders.filter((o) => o.isToday);
  const expiry = byKind("expiry");
  const overstock = byKind("overstock");
  const nextOrder = orders.find((o) => !o.isToday);

  // 곧 떨어지는 순: 현재 재고 ÷ 하루 평균 사용량
  const runningLow = plans
    .filter((p) => p.avgDailyNeed > 0)
    .map((p) => ({ p, days: daysOf(p.onHand, p.avgDailyNeed) }))
    .sort((a, b) => a.days - b.days)
    .slice(0, 6);

  let n = 0;
  return (
    <>
      <header>
        <p className="hint">{store?.store_name} · {shortDate(snapshot.meta.asOf)}</p>
        <h2 className="mt-0.5 text-xl font-bold tracking-[-0.02em]">오늘 할 일</h2>
        <p className="hint mt-1">판매 추세, 남은 재고와 사용기한, 공급사 발주 조건을 따져 오늘 처리할 일을 급한 순서로 정리했습니다.</p>
        <WeekdayNote asOf={snapshot.meta.asOf} weekday={insights?.weekday} holiday={result.ctx.holidays.has(snapshot.meta.asOf) ? result.ctx.holMult : null} />
      </header>

      <Guide />

      <section className="flex flex-col gap-2">
        {shortage.length > 0 && (
          <Task n={++n} tone="high" title={`다음 입고 전에 떨어질 품목 ${shortage.length}개`}
            desc="정기 발주로는 늦습니다. 긴급 발주(다음 날 07시 입고)나 다른 매장에서 옮겨오기를 검토하세요."
            action={<Link href="/orders" className="btn-primary">발주 추천 보기</Link>}>
            <ul className="mt-2 flex flex-col gap-1 text-sm">
              {shortage.map((a) => {
                const p = planOf(a.ingredientId);
                return p && (
                  <li key={a.ingredientId}>
                    <b>{p.ingredient.ingredient_name}</b> — {p.firstShortageDate && shortDate(p.firstShortageDate)}부터 부족,
                    다음 입고({p.slot && shortDate(p.slot.arrivalDate)})까지 {fmtQty(p.shortageBeforeArrival, p.ingredient)} 모자람
                  </li>
                );
              })}
            </ul>
          </Task>
        )}

        {todayOrders.map((o) => (
          <Task key={o.supplier.supplier_id} n={++n} tone={o.belowMin ? "high" : "accent"}
            title={`${o.supplier.supplier_name}에 오늘 ${o.cutoff} 전까지 발주하세요`}
            desc={<>
              {o.lines.length}개 품목 · {won(o.amount)} · {shortDate(o.arrivalDate)} 07시 도착
              {timeLeft(settings.nowTime, o.cutoff) && <> · <b>마감까지 {timeLeft(settings.nowTime, o.cutoff)}</b></>}
              {o.belowMin && <><br /><span className="text-[var(--high)]">최소 발주금액 {won(o.supplier.min_order_amount)}에 {won(o.minGap)} 모자라 이대로는 발주가 안 됩니다.</span></>}
            </>}
            action={<Link href="/orders" className="btn-primary">발주서 확인하기</Link>}>
            <p className="hint mt-1">{o.lines.slice(0, 5).map((l) => `${l.ingredient.ingredient_name} ${l.finalUnits}${l.ingredient.order_unit}`).join(" · ")}{o.lines.length > 5 && ` 외 ${o.lines.length - 5}개`}</p>
          </Task>
        ))}

        {expiry.length > 0 && (
          <Task n={++n} tone="medium" title={`사용기한이 곧 끝나는 품목 ${expiry.length}개 — 먼저 쓰세요`}
            desc="그대로 두면 버리게 될 양입니다. 먼저 사용하거나 다른 매장으로 옮기세요."
            action={<Link href="/inventory" className="btn">재고 보기</Link>}>
            <ul className="mt-2 flex flex-col gap-1 text-sm">{expiry.map((a) => <li key={a.ingredientId}><b>{planOf(a.ingredientId)?.ingredient.ingredient_name}</b> — {a.detail}</li>)}</ul>
          </Task>
        )}

        {overstock.length > 0 && (
          <Task n={++n} tone="low" title={`재고가 너무 많은 품목 ${overstock.length}개`}
            desc="발주 추천에서는 이미 줄여서 계산했습니다. 다른 매장으로 보내는 것도 방법입니다."
            action={<Link href="/inventory" className="btn">재고 보기</Link>}>
            <p className="hint mt-1">{overstock.map((a) => planOf(a.ingredientId)?.ingredient.ingredient_name).join(" · ")}</p>
          </Task>
        )}

        {n === 0 && (
          <div className="card flex items-center gap-3">
            <span className="badge badge-accent">완료</span>
            <p className="text-sm">오늘은 처리할 일이 없습니다.{nextOrder && <> 다음 발주는 <b>{shortDate(nextOrder.orderDate)} {nextOrder.supplier.supplier_name}</b>입니다.</>}</p>
          </div>
        )}
      </section>

      <div className="grid gap-4 xl:grid-cols-2">
        <section className="card">
          <div className="mb-1 flex items-center justify-between">
            <h3 className="section-title">곧 떨어지는 품목</h3>
            <Link href="/inventory" className="btn-ghost !text-[var(--accent)]">전체 재고 →</Link>
          </div>
          <p className="hint mb-2">오늘 아침 입고분까지 포함한 지금 재고로 며칠을 쓸 수 있는지 (최근 판매로 예측한 하루 사용량 기준). 빨간색은 다음 입고 전에 떨어지는 품목입니다.</p>
          <table className="tbl">
            <thead><tr><th>식자재</th><th className="num">남은 양</th><th>며칠 분량</th><th>다음 입고</th></tr></thead>
            <tbody>
              {runningLow.map(({ p, days }) => {
                const next = p.nextIncoming;
                return (
                  <tr key={p.ingredient.ingredient_id}>
                    <td>{p.ingredient.ingredient_name}</td>
                    <td className="num"><Qty qty={p.onHand} ing={p.ingredient} /></td>
                    <td><DaysLeft days={days} risk={p.shortageBeforeArrival > 0} /></td>
                    <td className="hint">{next ? <>{shortDate(next.date)} {fmtQty(next.qty, p.ingredient)}</> : p.slot && p.finalUnits > 0 ? `${shortDate(p.slot.arrivalDate)} (추천 발주 시 ${p.finalUnits}${p.ingredient.order_unit})` : "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>

        <section className="card">
          <div className="mb-1 flex items-center justify-between">
            <h3 className="section-title">다가오는 발주</h3>
            <Link href="/orders" className="btn-ghost !text-[var(--accent)]">발주 추천 →</Link>
          </div>
          <p className="hint mb-2">공급사별 발주 가능 요일·마감 시각에 맞춘 다음 발주 일정입니다.</p>
          <table className="tbl">
            <thead><tr><th>공급사</th><th>발주 마감</th><th>도착</th><th className="num">금액</th><th /></tr></thead>
            <tbody>
              {orders.map((o) => (
                <tr key={o.supplier.supplier_id + o.orderDate}>
                  <td>{o.supplier.supplier_name}<div className="hint">{o.lines.length}개 품목</div></td>
                  <td>{o.isToday ? <span className="badge badge-accent mr-1">오늘</span> : shortDate(o.orderDate)} {o.cutoff}</td>
                  <td>{shortDate(o.arrivalDate)}</td>
                  <td className="num">{won(o.amount)}</td>
                  <td>{o.belowMin && <span className="badge badge-high">최소금액 미달</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      </div>
    </>
  );
}

function Task({ n, tone, title, desc, action, children }: {
  n: number; tone: "high" | "medium" | "low" | "accent"; title: string; desc: ReactNode; action: ReactNode; children?: ReactNode;
}) {
  return (
    <article className="card flex gap-3" style={{ borderLeft: `3px solid ${tone === "accent" ? "var(--brand)" : `var(--${tone})`}` }}>
      <span className={`badge h-6 w-6 shrink-0 justify-center !rounded-full !p-0 text-xs ${tone === "accent" ? "" : `badge-${tone}`}`}
        style={tone === "accent" ? { background: "var(--brand)", color: "var(--on-brand)" } : undefined}>{n}</span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <h3 className="font-semibold">{title}</h3>
            <p className="mt-0.5 text-sm text-[var(--muted)]">{desc}</p>
          </div>
          {action}
        </div>
        {children}
      </div>
    </article>
  );
}

/** 처음 방문 안내 — 닫으면 이 브라우저에서는 다시 안 보임 */
const noSubscribe = () => () => {};
const readDismissed = () => { try { return localStorage.getItem(GUIDE_KEY) === "1"; } catch { return false; } };

function Guide() {
  // 서버 렌더링에서는 숨김 → 브라우저에서 저장값 확인 (hydration 불일치 방지)
  const dismissed = useSyncExternalStore(noSubscribe, readDismissed, () => true);
  const [closed, setClosed] = useState(false);
  if (dismissed || closed) return null;
  const close = () => { setClosed(true); try { localStorage.setItem(GUIDE_KEY, "1"); } catch { /* 저장 불가 환경 무시 */ } };
  return (
    <section className="card" style={{ background: "var(--accent-soft)", borderColor: "var(--brand)" }}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="font-semibold">처음 오셨나요? 이렇게 쓰면 됩니다</h3>
          <ol className="mt-2 flex flex-col gap-1 text-sm">
            <li><b>1.</b> 아래 <b>오늘 할 일</b>을 위에서부터 처리하세요. 급한 일이 먼저 나옵니다.</li>
            <li><b>2.</b> <b>발주 추천</b>에서 품목별 추천 수량과 이유를 확인하고, 필요하면 수량을 고친 뒤 <b>발주 확정</b>을 누르세요.</li>
            <li><b>3.</b> 매일 영업 전 <b>데이터 입력 → 실사 재고</b>에 센 수량을 넣으면 추천이 더 정확해집니다.</li>
          </ol>
          <p className="hint mt-2">왼쪽에서 매장·날짜를 바꾸거나, <b>추천 설정</b>에서 얼마나 넉넉하게 주문할지 등을 바꾸면 모든 결과가 바로 다시 계산됩니다.</p>
        </div>
        <button className="btn-ghost shrink-0" onClick={close} aria-label="안내 닫기">닫기</button>
      </div>
    </section>
  );
}

/** "09:00" → "16:00" 까지 남은 시간. 지났으면 null */
function timeLeft(now: string, cutoff: string): string | null {
  const m = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
  const d = m(cutoff) - m(now);
  if (!(d > 0)) return null;
  return d >= 60 ? `${Math.floor(d / 60)}시간${d % 60 ? ` ${d % 60}분` : ""}` : `${d}분`;
}

/** 오늘 요일이 이 매장에서 평소보다 바쁜 날인지 (팀 데이터 분석: 요일별 평균 판매) */
function WeekdayNote({ asOf, weekday, holiday }: { asOf: string; weekday?: { weekday: string; avg_net_sales: number }[]; holiday: number | null }) {
  if (!weekday?.length) return null;
  const wd = weekdayOf(asOf);
  const today = weekday.find((w) => w.weekday === wd);
  if (!today) return null;
  const mean = weekday.reduce((a, w) => a + w.avg_net_sales, 0) / weekday.length;
  const diff = Math.round((today.avg_net_sales / mean - 1) * 100);
  const busiest = [...weekday].sort((a, b) => b.avg_net_sales - a.avg_net_sales)[0];
  return (
    <p className="mt-2 inline-flex flex-wrap items-center gap-1.5 rounded-md bg-[var(--accent-soft)] px-2.5 py-1 text-sm">
      <span className="font-semibold">{wd}요일</span>
      은 이 매장 평균보다 판매가 <b>{diff >= 0 ? `${diff}% 많은` : `${-diff}% 적은`}</b> 날입니다.
      <span className="hint">(가장 바쁜 요일: {busiest.weekday}요일{holiday ? ` · 오늘은 공휴일이라 평소의 ${holiday.toFixed(2)}배로 예측` : ""})</span>
    </p>
  );
}
