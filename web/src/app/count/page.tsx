"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { addDays, shortDate } from "@/lib/engine/dates";
import { describeQty } from "@/lib/engine/units";
import type { Ingredient } from "@/lib/types";
import { useApp } from "@/state/app-state";

/** 냉장고·창고를 도는 순서 */
const STORAGE_ORDER = ["냉동", "냉장", "상온"];
/** g·ml 품목은 포장 단위(박스 등)로 세고, 개·매·장·캔은 낱개로 센다 */
const MEASURED = new Set(["g", "ml"]);
const countUnit = (ing: Ingredient) => (MEASURED.has(ing.use_unit) ? ing.order_unit : ing.use_unit);
const step = (ing: Ingredient) => (MEASURED.has(ing.use_unit) ? 0.5 : 1);
const toCount = (useQty: number, ing: Ingredient) => (MEASURED.has(ing.use_unit) ? Math.round((useQty / ing.use_qty_per_order_unit) * 10) / 10 : Math.round(useQty));
const toUse = (v: number, ing: Ingredient) => (MEASURED.has(ing.use_unit) ? v * ing.use_qty_per_order_unit : v);
/** 장부와 이만큼 넘게 차이 나면 마지막에 다시 확인 */
const DIFF_RATIO = 0.3;

/**
 * 재고 세기 — 한 품목씩 넘기며 사람이 세는 단위로 입력.
 * 저장은 기존 실사 입력(/api/inputs/counts)과 같고, 저장하면 오늘 주문 추천이 바로 다시 계산된다.
 */
export default function CountPage() {
  const { snapshot, setAsOf, reload } = useApp();
  const [idx, setIdx] = useState(0);
  const [values, setValues] = useState<Record<string, number>>({});
  const [confirmed, setConfirmed] = useState<Set<string>>(new Set());
  const [phase, setPhase] = useState<"count" | "review" | "done">("count");
  const [backToReview, setBackToReview] = useState(false);
  /** 입력 중인 글자 그대로 ("7." 처럼 숫자로 바꾸면 사라지는 중간 상태를 지키려고) */
  const [draft, setDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const items = useMemo(() => (snapshot ? [...snapshot.ingredients].sort((a, b) =>
    STORAGE_ORDER.indexOf(a.storage) - STORAGE_ORDER.indexOf(b.storage) || a.ingredient_name.localeCompare(b.ingredient_name, "ko")) : []), [snapshot]);
  // 장부 수량 = 전날 마감 + 오늘 07시 입고 (실사를 이미 넣었으면 그 값)
  const book = useMemo(() => {
    const m = new Map<string, number>();
    if (!snapshot) return m;
    for (const l of snapshot.lots) m.set(l.ingredient_id, (m.get(l.ingredient_id) ?? 0) + l.remaining_qty);
    for (const o of snapshot.openOrders) if (o.expected_date === snapshot.meta.asOf) m.set(o.ingredient_id, (m.get(o.ingredient_id) ?? 0) + o.use_qty);
    return m;
  }, [snapshot]);

  if (!snapshot) return null;
  const asOf = snapshot.meta.asOf;

  if (asOf <= snapshot.meta.providedEnd) {
    return (
      <section className="card flex flex-col gap-3">
        <h2 className="text-xl font-bold">재고 세기</h2>
        <p className="text-sm">지금 보고 있는 날짜({shortDate(asOf)})는 이미 기록된 과거라 재고를 새로 넣을 수 없어요. 오늘({shortDate(addDays(snapshot.meta.dataEnd, 1))})로 돌아가서 세어 주세요.</p>
        <div><button className="btn-primary !rounded-full" onClick={() => setAsOf(null)}>오늘로 돌아가기</button></div>
      </section>
    );
  }

  const ing = items[idx];
  const bookOf = (i: Ingredient) => toCount(book.get(i.ingredient_id) ?? 0, i);
  const valueOf = (i: Ingredient) => values[i.ingredient_id] ?? bookOf(i);
  const differs = (i: Ingredient) => {
    const b = bookOf(i);
    const v = valueOf(i);
    return b > 0 ? Math.abs(v - b) / b > DIFF_RATIO : v > 0;
  };

  const go = (next: number) => {
    setDraft(null);
    if (backToReview) { setBackToReview(false); setPhase("review"); return; }
    if (next >= items.length) { setPhase("review"); return; }
    setIdx(Math.max(0, next));
  };
  const confirmAndNext = () => { setConfirmed((s) => new Set(s).add(ing.ingredient_id)); go(idx + 1); };

  async function save() {
    setBusy(true);
    setErr("");
    const list = items.filter((i) => confirmed.has(i.ingredient_id));
    const r = await fetch("/api/inputs/counts", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ date: asOf, items: list.map((i) => ({ ingredient_id: i.ingredient_id, counted_qty: toUse(valueOf(i), i) })) }),
    }).catch(() => null);
    setBusy(false);
    if (!r?.ok) { setErr((await r?.json().catch(() => null))?.error ?? "저장하지 못했습니다. 다시 눌러 주세요."); return; }
    reload();
    setPhase("done");
  }

  if (phase === "done") {
    return (
      <section className="card flex flex-col items-start gap-3">
        <span className="badge" style={{ background: "var(--brand)", color: "var(--on-brand)" }}>✓ 저장 완료</span>
        <h2 className="text-xl font-bold">센 수량 {confirmed.size}개를 저장했어요</h2>
        <p className="text-sm text-[var(--muted)]">오늘 주문 추천을 이 수량으로 다시 계산했습니다.</p>
        <Link href="/" className="btn-primary !rounded-full !px-6">오늘 주문 보기 →</Link>
      </section>
    );
  }

  if (phase === "review") {
    const checked = items.filter((i) => confirmed.has(i.ingredient_id));
    const big = checked.filter(differs);
    return (
      <section className="card flex flex-col gap-4">
        <div>
          <h2 className="text-xl font-bold">거의 다 됐어요</h2>
          <p className="hint mt-1 !text-sm">{checked.length}개 품목을 셌어요{items.length - checked.length > 0 && ` (건너뛴 ${items.length - checked.length}개는 저장하지 않음)`}.</p>
        </div>
        {big.length > 0 ? (
          <div className="rounded-md border p-3" style={{ borderColor: "var(--medium)", background: "var(--medium-soft)" }}>
            <p className="text-sm font-semibold text-[var(--medium)]">장부와 차이가 큰 품목 {big.length}개 — 한 번 더 확인해 주세요</p>
            <ul className="mt-2 flex flex-col gap-1.5">
              {big.map((i) => (
                <li key={i.ingredient_id} className="flex flex-wrap items-center justify-between gap-2 text-sm">
                  <span><b>{i.ingredient_name}</b> 장부 {bookOf(i)}{countUnit(i)} → 센 수량 <b>{valueOf(i)}{countUnit(i)}</b></span>
                  <button className="btn !rounded-full text-xs" onClick={() => { setIdx(items.indexOf(i)); setBackToReview(true); setPhase("count"); }}>다시 세기</button>
                </li>
              ))}
            </ul>
          </div>
        ) : checked.length > 0 && <p className="text-sm">장부와 크게 다른 품목은 없어요.</p>}
        {err && <div role="alert" className="status status-err">{err}</div>}
        <div className="flex flex-wrap gap-2">
          <button className="btn !rounded-full" onClick={() => { setIdx(0); setPhase("count"); }}>처음부터 다시 보기</button>
          <button className="btn-primary !rounded-full !px-6 !font-bold" onClick={save} disabled={busy || checked.length === 0}>
            {busy ? "저장 중…" : "저장하고 추천에 반영"}
          </button>
        </div>
      </section>
    );
  }

  const v = valueOf(ing);
  const unit = countUnit(ing);
  const set = (n: number) => { setDraft(null); setValues((s) => ({ ...s, [ing.ingredient_id]: Math.max(0, Math.round(n * 10) / 10) })); };
  return (
    <>
      <header className="flex items-end justify-between gap-3">
        <div>
          <p className="hint">{shortDate(asOf)} 영업 전 · 07시 입고분까지 포함해서 세요</p>
          <h2 className="mt-0.5 text-2xl font-bold tracking-[-0.02em]">재고 세기</h2>
        </div>
        <p className="text-sm tabular-nums"><b>{idx + 1}</b> / {items.length}</p>
      </header>
      <div className="h-1.5 overflow-hidden rounded-full bg-[var(--surface-2)]" aria-hidden>
        <div className="h-full rounded-full" style={{ width: `${((idx + 1) / items.length) * 100}%`, background: "var(--brand)", transition: "width 200ms var(--ease-out)" }} />
      </div>

      <section className="card flex flex-col items-center gap-5 py-8 text-center">
        <div>
          <span className="badge badge-muted">{ing.storage}</span>
          <h3 className="mt-2 text-3xl font-extrabold tracking-[-0.02em]">{ing.ingredient_name}</h3>
          <p className="hint mt-1 !text-sm">장부상 약 <b className="text-[var(--foreground)]">{bookOf(ing)}{unit}</b>
            {MEASURED.has(ing.use_unit) && <> ({describeQty(book.get(ing.ingredient_id) ?? 0, ing).sub})</>}
            {MEASURED.has(ing.use_unit) && <> · 1{unit} = {ing.use_qty_per_order_unit.toLocaleString("ko-KR")}{ing.use_unit}</>}</p>
        </div>
        <div className="flex items-center gap-3">
          <button className="btn h-12 w-12 !rounded-full !p-0 text-2xl" onClick={() => set(v - step(ing))} disabled={v <= 0} aria-label="줄이기">−</button>
          <label className="flex items-baseline gap-1">
            <span className="sr-only">센 수량</span>
            <input inputMode="decimal" className="input w-28 !rounded-xl !py-2 text-center text-3xl font-bold tabular-nums" value={draft ?? String(v)}
              onChange={(e) => {
                const raw = e.target.value.replace(/,/g, "");
                if (!/^\d*\.?\d*$/.test(raw)) return; // 숫자·소수점만
                const n = Number(raw);
                setValues((s) => ({ ...s, [ing.ingredient_id]: raw === "" ? 0 : Math.max(0, Math.round(n * 10) / 10) }));
                setDraft(raw);
              }}
              onBlur={() => setDraft(null)}
              onKeyDown={(e) => { if (e.key === "Enter") confirmAndNext(); }} autoFocus />
            <span className="text-lg text-[var(--muted)]">{unit}</span>
          </label>
          <button className="btn h-12 w-12 !rounded-full !p-0 text-2xl" onClick={() => set(v + step(ing))} aria-label="늘리기">+</button>
        </div>
        {MEASURED.has(ing.use_unit) && <p className="hint">반 {unit}는 0.5로 넣으세요</p>}
      </section>

      <div className="flex items-center justify-between gap-2">
        <button className="btn !rounded-full" onClick={() => go(idx - 1)} disabled={idx === 0 || backToReview}>← 이전</button>
        <span className="flex items-center gap-1">
          <button className="btn-ghost" onClick={() => go(idx + 1)}>건너뛰기</button>
          {/* 바뀐 것만 세는 경우가 많아, 하나라도 셌으면 중간에 끝낼 수 있게 */}
          {confirmed.size > 0 && !backToReview && <button className="btn-ghost" onClick={() => setPhase("review")}>그만 세고 저장하기 ({confirmed.size})</button>}
        </span>
        <button className="btn-primary !rounded-full !px-6 !font-bold" onClick={confirmAndNext}>
          {backToReview ? "확인" : idx === items.length - 1 ? "다 셌어요" : "다음 →"}
        </button>
      </div>
    </>
  );
}
