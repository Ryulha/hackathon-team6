"use client";

import { Fragment, useState } from "react";
import { won } from "@/components/format";
import { Basis, Chevron, MinFix, draftLine } from "@/components/order-parts";
import { DaysLeft, Qty } from "@/components/qty";
import type { IngredientPlan } from "@/lib/engine";
import { shortDate } from "@/lib/engine/dates";
import { daysOf, fmtQty } from "@/lib/engine/units";
import { useApp } from "@/state/app-state";

export default function OrdersPage() {
  const { result, snapshot, settings, overrides, setOverride } = useApp();
  const [open, setOpen] = useState<string | null>(null);
  const [saveMsg, setSaveMsg] = useState("");
  if (!result || !snapshot) return null;

  async function save(status: "draft" | "submitted") {
    const lines = result!.plans.filter((p) => p.finalUnits > 0).map(draftLine);
    const r = await fetch("/api/drafts", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ storeId: snapshot!.meta.storeId, asOf: snapshot!.meta.asOf, status, settings, lines,
        totalAmount: lines.reduce((a, l) => a + l.amount, 0) }),
    });
    setSaveMsg(r.ok ? (status === "submitted" ? "발주를 확정했습니다 (모의 전송 — 실제 공급사로 보내지지 않음)" : "발주안을 임시 저장했습니다") : (await r.json()).error);
  }

  return (
    <>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <header>
          <h2 className="text-xl font-bold tracking-[-0.02em]">발주 추천</h2>
          <ol className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-sm text-[var(--muted)]">
            <li><b className="text-[var(--foreground)]">1</b> 공급사별 발주서를 확인하고</li>
            <li><b className="text-[var(--foreground)]">2</b> 품목을 눌러 이유를 보고, 필요하면 수량을 고친 뒤</li>
            <li><b className="text-[var(--foreground)]">3</b> 발주 확정을 누르세요</li>
          </ol>
        </header>
        <div className="flex items-center gap-2">
          <button className="btn" onClick={() => save("draft")}>임시 저장</button>
          <button className="btn-primary" onClick={() => save("submitted")}>발주 확정</button>
        </div>
      </div>
      {saveMsg && <div role="status" className="status status-ok">{saveMsg}</div>}

      {result.orders.map((o) => (
        <section key={o.supplier.supplier_id + o.orderDate} className="card overflow-x-auto">
          <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
            <div>
              <h3 className="section-title">{o.supplier.supplier_name} 발주서</h3>
              <p className="mt-0.5 text-sm text-[var(--muted)]">
                {o.isToday ? <span className="badge badge-accent mr-1">오늘</span> : `${shortDate(o.orderDate)} `}{o.cutoff} 전까지 발주 → {shortDate(o.arrivalDate)} 07시 도착
              </p>
            </div>
            <div className="text-right">
              <div className="text-lg font-bold tabular-nums">{won(o.amount)}</div>
              {o.supplier.min_order_amount > 0 && (o.belowMin
                ? <span className="badge badge-high">최소 {won(o.supplier.min_order_amount)}에 {won(o.minGap)} 모자람</span>
                : <span className="hint">최소 발주금액 {won(o.supplier.min_order_amount)} 충족</span>)}
            </div>
          </div>
          {o.fix && <MinFix o={o} setOverride={setOverride} />}
          <PlanTable plans={o.lines} open={open} setOpen={setOpen} overrides={overrides} setOverride={setOverride} />
        </section>
      ))}

      <section className="card overflow-x-auto">
        <h3 className="section-title">이번에는 발주하지 않아도 되는 품목</h3>
        <p className="hint mb-2">남은 재고와 들어올 물량으로 다음 입고 때까지 충분합니다. 필요하면 수량을 넣어 추가할 수 있습니다.</p>
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
        <th>식자재</th><th className="num">지금 남은 양</th><th>며칠 분량</th>
        <th className="num">추천</th><th>발주할 수량</th><th className="num">금액</th><th>확인할 점</th>
      </tr></thead>
      <tbody>
        {plans.map((p) => {
          const id = p.ingredient.ingredient_id;
          const ing = p.ingredient;
          return (
            <Fragment key={id}>
              <tr className="row-hover cursor-pointer" aria-expanded={open === id} onClick={() => setOpen(open === id ? null : id)}>
                <td>
                  <span className="inline-flex items-center gap-1"><Chevron open={open === id} />{ing.ingredient_name}</span>
                  <div className="hint ml-4">1{ing.order_unit} = {ing.use_qty_per_order_unit.toLocaleString("ko-KR")}{ing.use_unit}</div>
                </td>
                <td className="num"><Qty qty={p.onHand} ing={ing} /></td>
                <td><DaysLeft days={daysOf(p.onHand, p.avgDailyNeed)} risk={p.shortageBeforeArrival > 0} /></td>
                <td className="num">{p.recommendedUnits}{ing.order_unit}</td>
                <td onClick={(e) => e.stopPropagation()}>
                  <span className="inline-flex items-center gap-1">
                    <input type="number" min={0} aria-label={`${ing.ingredient_name} 발주 수량`} className="input w-16 text-right tabular-nums"
                      value={overrides[id] ?? p.recommendedUnits}
                      onChange={(e) => setOverride(id, e.target.value === "" ? undefined : Math.max(0, Number(e.target.value)))} />
                    <span className="hint">{ing.order_unit}</span>
                    {p.overridden && <button className="btn-ghost !px-1.5 !py-0.5 text-xs" onClick={() => setOverride(id, undefined)}>추천대로</button>}
                  </span>
                </td>
                <td className="num">{won(p.amount)}</td>
                <td className="text-xs">
                  {p.shortageBeforeArrival > 0 && <div className="text-[var(--high)]">도착 전에 {fmtQty(p.shortageBeforeArrival, ing)} 모자람 — 긴급 발주 검토</div>}
                  {p.plannedShortage > 0 && <div className="text-[var(--high)]">이 수량으로는 {fmtQty(p.plannedShortage, ing)} 모자람</div>}
                  {p.plannedWaste > 0 && <div className="text-[var(--medium)]">사용기한 지나 {fmtQty(p.plannedWaste, ing)} 버릴 예상</div>}
                </td>
              </tr>
              {open === id && <tr><td colSpan={7}><Basis p={p} /></td></tr>}
            </Fragment>
          );
        })}
      </tbody>
    </table>
  );
}
