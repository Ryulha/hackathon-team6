"use client";

import { Fragment, useState } from "react";
import { fmt, won } from "@/components/format";
import type { IngredientPlan } from "@/lib/engine";
import { useApp } from "@/state/app-state";

export default function OrdersPage() {
  const { result, snapshot, settings, overrides, setOverride } = useApp();
  const [open, setOpen] = useState<string | null>(null);
  const [saveMsg, setSaveMsg] = useState("");
  if (!result || !snapshot) return null;

  async function save(status: "draft" | "submitted") {
    const lines = result!.plans.filter((p) => p.finalUnits > 0).map((p) => ({
      ingredient_id: p.ingredient.ingredient_id, supplier_id: p.supplier?.supplier_id, order_date: p.slot?.orderDate,
      arrival_date: p.slot?.arrivalDate, use_qty: p.finalUnits * p.ingredient.use_qty_per_order_unit,
      recommended_units: p.recommendedUnits, final_units: p.finalUnits, unit_price: p.unitPrice, amount: p.amount,
    }));
    const r = await fetch("/api/drafts", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ storeId: snapshot!.meta.storeId, asOf: snapshot!.meta.asOf, status, settings, lines,
        totalAmount: lines.reduce((a, l) => a + l.amount, 0) }),
    });
    setSaveMsg(r.ok ? (status === "submitted" ? "발주 확정(모의 전송) 저장됨" : "발주안 저장됨") : (await r.json()).error);
  }

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-semibold">발주 추천</h2>
        <div className="flex items-center gap-2">
          {saveMsg && <span className="text-sm text-[var(--muted)]">{saveMsg}</span>}
          <button className="btn" onClick={() => save("draft")}>발주안 저장</button>
          <button className="btn-primary" onClick={() => save("submitted")}>발주 확정 (모의)</button>
        </div>
      </div>
      <p className="text-sm text-[var(--muted)]">수량을 직접 고치면 예상 재고·최소 발주금액이 즉시 다시 계산됩니다. 행을 누르면 계산 근거를 볼 수 있습니다.</p>

      {result.orders.map((o) => (
        <section key={o.supplier.supplier_id + o.orderDate} className="card overflow-x-auto">
          <div className="mb-2 flex flex-wrap items-baseline gap-x-4 gap-y-1">
            <h3 className="font-semibold">{o.supplier.supplier_name}</h3>
            <span className="text-sm">발주 {o.orderDate} {o.cutoff} 마감{o.isToday && <b className="text-[var(--accent)]"> (오늘)</b>} → 입고 {o.arrivalDate}</span>
            <span className="text-sm">합계 <b>{won(o.amount)}</b></span>
            <span className="text-sm" style={{ color: o.belowMin ? "var(--high)" : "var(--muted)" }}>
              최소 발주금액 {won(o.supplier.min_order_amount)} {o.belowMin ? `— ${won(o.minGap)} 부족` : "충족"}
            </span>
          </div>
          <PlanTable plans={o.lines} open={open} setOpen={setOpen} overrides={overrides} setOverride={setOverride} />
        </section>
      ))}

      <section className="card overflow-x-auto">
        <h3 className="mb-2 font-semibold">이번 발주 불필요 품목</h3>
        <PlanTable plans={result.plans.filter((p) => p.finalUnits <= 0)} open={open} setOpen={setOpen} overrides={overrides} setOverride={setOverride} />
      </section>
    </>
  );
}

function PlanTable({ plans, open, setOpen, overrides, setOverride }: {
  plans: IngredientPlan[]; open: string | null; setOpen: (id: string | null) => void;
  overrides: Record<string, number>; setOverride: (id: string, u: number | undefined) => void;
}) {
  return (
    <table className="tbl">
      <thead><tr>
        <th>식자재</th><th className="num">현재고</th><th className="num">일평균 소요</th><th className="num">버팀 일수</th>
        <th className="num">추천</th><th>발주 수량</th><th className="num">금액</th><th>위험</th>
      </tr></thead>
      <tbody>
        {plans.map((p) => {
          const id = p.ingredient.ingredient_id;
          const u = p.ingredient.use_unit;
          return (
            <Fragment key={id}>
              <tr className="cursor-pointer hover:bg-[var(--background)]" onClick={() => setOpen(open === id ? null : id)}>
                <td>{p.ingredient.ingredient_name} <span className="text-xs text-[var(--muted)]">{id}</span></td>
                <td className="num">{fmt(p.startStock)}{u}</td>
                <td className="num">{fmt(p.avgDailyNeed, 1)}{u}</td>
                <td className="num">{fmt(p.coverDays)}일</td>
                <td className="num">{p.recommendedUnits}{p.ingredient.order_unit}</td>
                <td onClick={(e) => e.stopPropagation()}>
                  <input type="number" min={0} className="input w-20" value={overrides[id] ?? p.recommendedUnits}
                    onChange={(e) => setOverride(id, e.target.value === "" ? undefined : Math.max(0, Number(e.target.value)))} />
                  {p.overridden && <button className="ml-1 text-xs text-[var(--accent)]" onClick={() => setOverride(id, undefined)}>되돌리기</button>}
                </td>
                <td className="num">{won(p.amount)}</td>
                <td className="text-xs">
                  {p.shortageBeforeArrival > 0 && <div className="text-[var(--high)]">입고 전 부족 {fmt(p.shortageBeforeArrival)}{u}</div>}
                  {p.plannedShortage > 0 && <div className="text-[var(--high)]">발주 후에도 부족 {fmt(p.plannedShortage)}{u}</div>}
                  {p.plannedWaste > 0 && <div className="text-[var(--medium)]">폐기 예상 {fmt(p.plannedWaste)}{u}</div>}
                </td>
              </tr>
              {open === id && <tr><td colSpan={8}><Basis p={p} /></td></tr>}
            </Fragment>
          );
        })}
      </tbody>
    </table>
  );
}

function Basis({ p }: { p: IngredientPlan }) {
  const ing = p.ingredient;
  const u = ing.use_unit;
  return (
    <div className="grid gap-1 bg-[var(--background)] p-3 text-xs md:grid-cols-2">
      <div>
        <b>계산 근거</b>
        <ol className="ml-4 list-decimal">
          <li>발주 시점: {p.slot ? `${p.slot.orderDate} ${p.slot.cutoff} 마감 → ${p.slot.arrivalDate} 입고` : "-"}
            {p.slot?.shiftedDays ? ` (입고 요일 맞춰 ${p.slot.shiftedDays}일 밀림)` : ""}</li>
          <li>이번 발주가 책임질 기간: {p.slot?.arrivalDate} ~ {p.nextSlot ? `${p.nextSlot.arrivalDate} 전날` : "-"} (다음 발주 {p.nextSlot?.orderDate})</li>
          <li>해당 기간 예측 소요: {fmt(p.windowNeed)}{u} (메뉴 예측 × BOM)</li>
          <li>안전재고: 일평균 {fmt(p.avgDailyNeed, 1)}{u} × 설정 일수 = {fmt(p.safetyStock)}{u}</li>
          <li>필요량(현재고·입고예정·폐기 반영 시뮬레이션): {fmt(p.recommendedUse)}{u}</li>
          <li>발주단위 환산: {fmt(p.recommendedUse)} ÷ {fmt(ing.use_qty_per_order_unit)}{u}/{ing.order_unit} → 올림 {p.recommendedUnits}{ing.order_unit} (최소 {ing.min_order_qty})</li>
          <li>단가: {won(p.unitPrice)}/{ing.order_unit} ({p.priceFrom}부터 적용)</li>
        </ol>
        {p.notes.length > 0 && <ul className="mt-1 ml-4 list-disc text-[var(--medium)]">{p.notes.map((n, i) => <li key={i}>{n}</li>)}</ul>}
      </div>
      <div>
        <b>입고 예정 · 재고 흐름</b>
        <div>입고 예정: {p.incoming.length ? p.incoming.map((a) => `${a.date} ${fmt(a.qty)}${u}`).join(", ") : "없음"}</div>
        <table className="mt-1 w-full">
          <thead><tr className="text-[var(--muted)]"><td>날짜</td><td className="num">입고</td><td className="num">소요</td><td className="num">부족</td><td className="num">폐기</td><td className="num">마감재고</td></tr></thead>
          <tbody>
            {p.planned.slice(0, 10).map((d) => (
              <tr key={d.date}><td>{d.date}</td><td className="num">{fmt(d.arrived)}</td><td className="num">{fmt(d.need)}</td>
                <td className="num" style={{ color: d.shortage ? "var(--high)" : undefined }}>{fmt(d.shortage)}</td>
                <td className="num">{fmt(d.expired)}</td><td className="num">{fmt(d.closing)}</td></tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
