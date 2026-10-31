"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { timeLeft, won } from "@/components/format";
import { Basis, MinFix, draftLine } from "@/components/order-parts";
import { useInsights } from "@/components/use-insights";
import { HolidayNote } from "@/components/holiday-note";
import { WeekdayNote } from "@/components/weekday-note";
import type { IngredientPlan } from "@/lib/engine";
import { shortDate } from "@/lib/engine/dates";
import { describeQty, fmtQty } from "@/lib/engine/units";
import { useApp } from "@/state/app-state";

/**
 * 오늘 주문 — 점장·알바가 아침에 여는 첫 화면.
 * 오늘 마감인 공급사마다 체크리스트 카드 하나: 수량 [−][+] → '주문 완료'.
 */
export default function TodayPage() {
  const { result, snapshot, settings, overrides, completed } = useApp();
  const insights = useInsights(snapshot?.meta.storeId);
  const urgentIds = result?.plans.filter((p) => p.shortageBeforeArrival > 0).map((p) => p.ingredient.ingredient_id) ?? [];
  const transfers = useTransferOptions(urgentIds);
  if (!result || !snapshot) return null;
  const asOf = snapshot.meta.asOf;

  // 오늘 마감인 공급사별 품목 (수량을 0으로 내려도 카드에서 사라지지 않게 '추천했거나 손댄 품목'을 기준으로)
  const bySupplier = new Map<string, IngredientPlan[]>();
  for (const p of result.plans) {
    if (!p.supplier || p.slot?.orderDate !== asOf) continue;
    if (p.recommendedUnits <= 0 && overrides[p.ingredient.ingredient_id] === undefined) continue;
    const id = p.supplier.supplier_id;
    (bySupplier.get(id) ?? bySupplier.set(id, []).get(id)!).push(p);
  }
  const cards = [...bySupplier.values()].sort((a, b) => a[0].slot!.cutoff.localeCompare(b[0].slot!.cutoff));
  const doneCount = cards.filter((c) => completed.has(c[0].supplier!.supplier_id)).length;
  const urgent = result.plans.filter((p) => p.shortageBeforeArrival > 0);
  const nextOrder = result.orders.find((o) => o.orderDate > asOf);
  const expiring = result.alerts.filter((a) => a.kind === "expiry").length;
  const counted = snapshot.meta.overlay.countedToday.length > 0;
  const canCount = asOf > snapshot.meta.providedEnd;

  return (
    <>
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="hint">{shortDate(asOf)} · 지금 {settings.nowTime}</p>
          <h2 className="mt-0.5 text-2xl font-bold tracking-[-0.02em]">오늘 주문</h2>
          <WeekdayNote asOf={asOf} weekday={insights?.weekday} holiday={result.ctx.holidays.has(asOf) && (settings.holidayPlan?.[asOf] ?? "auto") === "auto" ? result.ctx.holMult : null} />
        </div>
        {cards.length > 0 && <Progress done={doneCount} total={cards.length} />}
      </header>

      <CheckSummary date={asOf} />
      <HolidayNote />

      {urgent.length > 0 && (
        <div className="card flex flex-wrap items-start justify-between gap-2" style={{ borderColor: "var(--high)", background: "var(--high-soft)" }}>
          <div className="text-sm">
            <b className="text-[var(--high)]">⚠ 다음 입고 전에 떨어지는 품목이 있어요</b>
            <ul className="mt-1 space-y-0.5">
              {urgent.map((p) => (
                <li key={p.ingredient.ingredient_id}><b>{p.ingredient.ingredient_name}</b> — {p.firstShortageDate && shortDate(p.firstShortageDate)}부터 {describeQty(p.shortageBeforeArrival, p.ingredient).main} 부족
                  <TransferHint plan={p} options={transfers?.options} /></li>
              ))}
            </ul>
            <p className="hint mt-1">정기 주문으로는 늦어요. 다른 매장과 협의해 배달대행으로 옮겨오거나(본사 승인 필요 없음, 운송비는 배달대행 예치금) 긴급 발주(다음 날 07시 도착)를 하세요.{transfers?.asOf && ` 다른 매장 재고는 ${shortDate(transfers.asOf)} 마감 기준, 그 매장도 ${transfers.keepDays}일치는 남기는 양만 셌어요.`}</p>
          </div>
          <Link href="/inventory" className="btn">재고 보기</Link>
        </div>
      )}

      {cards.length === 0 && (
        <div className="card flex items-center gap-3">
          <span className="badge badge-accent">완료</span>
          <p className="text-sm">오늘 마감인 주문이 없어요.{nextOrder && <> 다음 주문은 <b>{shortDate(nextOrder.orderDate)} {nextOrder.supplier.supplier_name}</b> ({nextOrder.cutoff} 마감)입니다.</>}</p>
        </div>
      )}

      {cards.map((plans) => <SupplierCard key={plans[0].supplier!.supplier_id} plans={plans} />)}

      <div className="flex flex-wrap gap-2 text-sm">
        {canCount && !counted && (
          <Link href="/count" className="card flex-1 !py-3 hover:bg-[var(--surface-2)]">
            <b>재고를 세셨나요?</b> <span className="hint">센 수량을 넣으면 추천이 더 정확해져요 → 재고 세기</span>
          </Link>
        )}
        {expiring > 0 && (
          <Link href="/inventory" className="card flex-1 !py-3 hover:bg-[var(--surface-2)]">
            <b>사용기한이 곧 끝나는 품목 {expiring}개</b> <span className="hint">먼저 쓰세요 → 재고 보기</span>
          </Link>
        )}
        {nextOrder && cards.length > 0 && (
          <div className="card flex-1 !py-3"><span className="hint">다음 주문</span> <b>{shortDate(nextOrder.orderDate)} {nextOrder.supplier.supplier_name}</b></div>
        )}
      </div>
    </>
  );
}

type TransferOption = { ingredientId: string; storeName: string; spare: number };
type Transfers = { asOf: string | null; keepDays: number; options: TransferOption[] };

/** 부족 품목을 여유 있게 가진 다른 매장 (매장 간 이동 후보) */
function useTransferOptions(ids: string[]) {
  const key = ids.join(",");
  const [data, setData] = useState<{ key: string; value: Transfers } | null>(null);
  useEffect(() => {
    if (!key) return;
    let alive = true;
    fetch(`/api/transfers/options?ingredients=${key}`).then((r) => (r.ok ? r.json() : null))
      .then((v) => { if (alive && v) setData({ key, value: v }); }).catch(() => {});
    return () => { alive = false; };
  }, [key]);
  return data?.key === key ? data.value : null;
}

function TransferHint({ plan, options }: { plan: IngredientPlan; options?: TransferOption[] }) {
  const best = options?.find((o) => o.ingredientId === plan.ingredient.ingredient_id);
  if (!options) return null;
  if (!best) return <span className="hint"> · 다른 매장도 여유 없음 → 긴급 발주</span>;
  const enough = best.spare >= plan.shortageBeforeArrival;
  return (
    <span className="block text-[13px]">
      ↳ <b>{best.storeName}</b>에 여유 {describeQty(best.spare, plan.ingredient).main}
      {enough ? " — 옮겨오면 충분해요" : " — 일부만 채울 수 있어요"}
    </span>
  );
}

/** 점장용: 직원 점검 진행 한 줄 — 누르면 점검표 */
function CheckSummary({ date }: { date: string }) {
  const [d, setD] = useState<{ total: number; done: number; left: string[] } | null>(null);
  useEffect(() => {
    let alive = true;
    fetch(`/api/checks?date=${date}`).then((r) => (r.ok ? r.json() : null)).then((v) => {
      if (!alive || !v) return;
      const items = (v.items as { id: number; name: string; slot: string; active: boolean }[]).filter((i) => i.active);
      const doneIds = new Set((v.logs as { itemId: number }[]).map((l) => l.itemId));
      const slot: Record<string, string> = { open: "오픈", lunch: "점심", close: "마감" };
      setD({ total: items.length, done: items.filter((i) => doneIds.has(i.id)).length, left: items.filter((i) => !doneIds.has(i.id)).map((i) => `${slot[i.slot]} ${i.name}`) });
    }).catch(() => {});
    return () => { alive = false; };
  }, [date]);
  if (!d || !d.total) return null;
  return (
    <Link href="/checks" className="card flex items-center justify-between gap-2 !py-2.5 text-sm hover:bg-[var(--surface-2)]">
      <span><b>오늘 점검 {d.done}/{d.total} 완료</b>{d.left.length > 0 && <span className="hint"> · 남은 것: {d.left.slice(0, 3).join(", ")}{d.left.length > 3 && ` 외 ${d.left.length - 3}개`}</span>}</span>
      <span aria-hidden className="text-[var(--muted)]">→</span>
    </Link>
  );
}

function Progress({ done, total }: { done: number; total: number }) {
  return (
    <div className="flex items-center gap-2" aria-label={`오늘 주문 ${total}곳 중 ${done}곳 완료`}>
      <span className="flex gap-1">
        {Array.from({ length: total }, (_, i) => (
          <span key={i} className="h-2.5 w-6 rounded-full" style={{ background: i < done ? "var(--brand)" : "var(--border-strong)" }} />
        ))}
      </span>
      <span className="text-sm"><b>{total}곳 중 {done}곳</b> 완료</span>
    </div>
  );
}

function SupplierCard({ plans }: { plans: IngredientPlan[] }) {
  const { result, snapshot, settings, setOverride, completed, refreshCompleted } = useApp();
  const [open, setOpen] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const sup = plans[0].supplier!;
  const slot = plans[0].slot!;
  const order = result!.orders.find((o) => o.supplier.supplier_id === sup.supplier_id && o.orderDate === slot.orderDate);
  const total = plans.reduce((a, p) => a + p.amount, 0);
  const isDone = completed.has(sup.supplier_id) && !editing;
  const left = timeLeft(settings.nowTime, slot.cutoff);

  async function complete() {
    setBusy(true);
    setErr("");
    const lines = plans.filter((p) => p.finalUnits > 0).map(draftLine);
    const r = await fetch("/api/drafts", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ asOf: snapshot!.meta.asOf, status: "submitted", settings, lines, totalAmount: total, note: `${sup.supplier_name} 주문 완료` }),
    }).catch(() => null);
    setBusy(false);
    if (!r?.ok) { setErr((await r?.json().catch(() => null))?.error ?? "저장하지 못했습니다. 다시 눌러 주세요."); return; }
    setEditing(false);
    refreshCompleted();
  }

  if (isDone) {
    return (
      <section className="card flex flex-wrap items-center justify-between gap-2" style={{ borderLeft: "3px solid var(--brand)" }}>
        <p className="text-sm">
          <span className="badge mr-2" style={{ background: "var(--brand)", color: "var(--on-brand)" }}>✓ 주문 완료</span>
          <b>{sup.supplier_name}</b> · {shortDate(slot.arrivalDate)} 07시 도착 · {won(total)}
          <span className="hint ml-1">(모의 전송 — 실제 공급사로 보내지지 않음)</span>
        </p>
        <button className="btn-ghost text-xs" onClick={() => setEditing(true)}>수정하기</button>
      </section>
    );
  }

  return (
    <section className="card flex flex-col gap-3" style={{ borderLeft: "3px solid var(--brand)" }}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-lg font-bold tracking-[-0.01em]">{sup.supplier_name}</h3>
        <p className="text-sm">
          오늘 <b>{slot.cutoff}</b> 마감{left && <> · <b className="text-[var(--high)]">{left} 남음</b></>} · {shortDate(slot.arrivalDate)} 07시 도착
        </p>
      </div>

      <ul className="flex flex-col divide-y divide-[var(--border)]">
        {plans.map((p) => {
          const ing = p.ingredient;
          const id = ing.ingredient_id;
          const u = p.finalUnits;
          const set = (n: number) => setOverride(id, n === p.recommendedUnits ? undefined : n);
          // 최소 발주수량 아래로는 0, 0 에서 올리면 최소 수량으로
          const minus = () => set(u <= ing.min_order_qty ? 0 : u - 1);
          const plus = () => set(u === 0 ? Math.max(1, ing.min_order_qty) : u + 1);
          return (
            <li key={id} className="py-2.5">
              <div className="flex flex-wrap items-center gap-3">
                <div className="min-w-0 flex-1">
                  <p className="font-semibold">{ing.ingredient_name}</p>
                  <p className="hint">
                    도착 후 {p.windowDays}일 버틸 양 · 하루 약 {describeQty(p.avgDailyNeed, ing).main}
                    {p.shortageBeforeArrival > 0 && <span className="text-[var(--high)]"> · 도착 전 {fmtQty(p.shortageBeforeArrival, ing)} 부족</span>}
                    {p.overridden && <> · 추천 {p.recommendedUnits}{ing.order_unit} <button className="underline underline-offset-2" onClick={() => setOverride(id, undefined)}>되돌리기</button></>}
                  </p>
                </div>
                <div className="flex items-center gap-1.5">
                  <button className="btn h-9 w-9 !rounded-full !p-0 text-lg" onClick={minus} disabled={u === 0} aria-label={`${ing.ingredient_name} 1${ing.order_unit} 줄이기`}>−</button>
                  <span className="w-16 text-center text-xl font-bold tabular-nums" aria-live="polite">{u}<span className="ml-0.5 text-sm font-normal text-[var(--muted)]">{ing.order_unit}</span></span>
                  <button className="btn h-9 w-9 !rounded-full !p-0 text-lg" onClick={plus} aria-label={`${ing.ingredient_name} 1${ing.order_unit} 늘리기`}>+</button>
                </div>
                <button className="btn-ghost text-xs" aria-expanded={open === id} onClick={() => setOpen(open === id ? null : id)}>{open === id ? "닫기" : "왜?"}</button>
              </div>
              {open === id && <div className="mt-2 min-w-0"><Basis p={p} /></div>}
            </li>
          );
        })}
      </ul>

      {order?.fix && <MinFix o={order} setOverride={setOverride} />}
      {err && <div role="alert" className="status status-err">{err}</div>}

      <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-3" style={{ borderColor: "var(--border)" }}>
        <p className="text-sm">합계 <b className="text-lg tabular-nums">{won(total)}</b>
          {sup.min_order_amount > 0 && !order?.belowMin && <span className="hint ml-1.5">최소 주문금액 충족</span>}</p>
        <button className="btn-primary !rounded-full !px-6 !py-2.5 !text-[15px] !font-bold" onClick={complete}
          disabled={busy || total <= 0 || !!order?.belowMin}>
          {busy ? "저장 중…" : `${sup.supplier_name} 주문 완료`} {!busy && <span aria-hidden>✓</span>}
        </button>
      </div>
    </section>
  );
}
