"use client";

import { Fragment, useState } from "react";
import { won } from "@/components/format";
import { DaysLeft, Qty } from "@/components/qty";
import { useInsights } from "@/components/use-insights";
import { OrderBriefing } from "@/components/order-briefing";
import { SERVICE_LEVELS, type IngredientPlan, type SupplierOrder } from "@/lib/engine";
import { diffDays, shortDate } from "@/lib/engine/dates";
import { daysOf, describeQty, fmtQty } from "@/lib/engine/units";
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

      <OrderBriefing />

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

function Chevron({ open }: { open: boolean }) {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden className="shrink-0 text-[var(--muted)]"
      style={{ transform: open ? "rotate(90deg)" : "none", transition: "transform 160ms var(--ease-out)" }}>
      <path d="M4 2.5 7.5 6 4 9.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** 최소 발주금액 미달 시 대안 — 급한 품목이 없으면 미루기, 있으면 오래 가는 품목을 더 담기 */
function MinFix({ o, setOverride }: { o: SupplierOrder; setOverride: (id: string, u: number | undefined) => void }) {
  const fix = o.fix!;
  const defer = () => o.lines.forEach((l) => setOverride(l.ingredient.ingredient_id, 0));
  const apply = () => fix.adds.forEach(({ plan, add }) => setOverride(plan.ingredient.ingredient_id, plan.finalUnits + add));
  return (
    <div className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm" style={{ borderColor: "var(--high)", background: "var(--high-soft)" }}>
      <div className="min-w-0">
        <b>최소 발주금액 {won(o.supplier.min_order_amount)}에 {won(o.minGap)} 모자라 이대로는 발주할 수 없습니다.</b>
        {!fix.urgent ? (
          <p className="mt-0.5">급하게 떨어질 품목이 없으니 <b>다음 발주일로 미뤄 함께 주문</b>하는 걸 추천합니다.</p>
        ) : fix.adds.length ? (
          <p className="mt-0.5">급한 품목이 있어 미룰 수 없습니다. 오래 두고 쓰는 품목을 미리 담으면 맞출 수 있어요:{" "}
            <b>{fix.adds.map(({ plan, add }) => `${plan.ingredient.ingredient_name} +${add}${plan.ingredient.order_unit}`).join(", ")}</b> (+{won(fix.addAmount)}
            {!fix.covers && ", 그래도 모자람 — 2주 사용량 넘게는 담지 않음"})</p>
        ) : (
          <p className="mt-0.5">급한 품목이 있지만 미리 담을 만한 오래 가는 품목이 없습니다. 수량을 직접 늘리거나 긴급 발주를 검토하세요.</p>
        )}
      </div>
      {!fix.urgent ? <button className="btn" onClick={defer}>이번 발주 미루기</button>
        : fix.adds.length > 0 && <button className="btn-primary" onClick={apply}>제안대로 담기</button>}
    </div>
  );
}

function Basis({ p }: { p: IngredientPlan }) {
  const { snapshot, settings } = useApp();
  const insights = useInsights(snapshot?.meta.storeId);
  const ing = p.ingredient;
  // 포장 단위 경고: 1박스가 며칠치인지 vs 사용기한 (분석: 양상추 1박스가 매장마다 0.45~1.29일치)
  const packDays = p.avgDailyNeed > 0 ? ing.use_qty_per_order_unit / p.avgDailyNeed : Infinity;
  const packRisk = Number.isFinite(packDays) && packDays > ing.shelf_life_days * 0.5;
  const coverage = insights?.packCoverage.find((c) => c.store_id === snapshot?.meta.storeId && ing.ingredient_name.includes("양상추"));
  const counted = snapshot?.meta.overlay.countedToday.includes(ing.ingredient_id);
  const edited = snapshot?.meta.overlay.masterEdits.filter((e) => e.entity_id === ing.ingredient_id || e.entity_id === ing.supplier_id) ?? [];
  const main = (q: number) => (q ? describeQty(q, ing).main : "—");
  const days = p.slot && p.nextSlot ? diffDays(p.nextSlot.arrivalDate, p.slot.arrivalDate) : 0;
  return (
    <div className="grid gap-4 rounded-md bg-[var(--surface-2)] p-3 text-[13px] md:grid-cols-2">
      <div>
        <b>왜 {p.recommendedUnits}{ing.order_unit}인가요?</b>
        {p.slot && p.nextSlot ? (
          <ol className="mt-1 ml-4 flex list-decimal flex-col gap-1">
            <li>이번 발주는 <b>{shortDate(p.slot.arrivalDate)}</b>에 도착하고, 그다음 발주는 <b>{shortDate(p.nextSlot.arrivalDate)}</b>에 도착합니다. 그 사이 <b>{days}일</b>을 버텨야 합니다.
              {p.slot.shiftedDays > 0 && <span className="hint"> (입고 가능 요일에 맞춰 {p.slot.shiftedDays}일 늦게 도착)</span>}</li>
            <li>그 {days}일 동안 쓸 양은 <b>{fmtQty(p.windowNeed, ing)}</b>로 예상합니다. 최근 {settings.lookbackWeeks}주 판매 수준 × 요일별 차이 × 공휴일 효과 × 메뉴별 사용량(BOM)으로 계산했습니다{settings.demandAdjustPct ? ` (수요 ${settings.demandAdjustPct > 0 ? "+" : ""}${settings.demandAdjustPct}% 반영)` : ""}{settings.applyPromo ? " (행사 진행 가정)" : ""}.</li>
            <li>하루 사용량이 예측에서 평소 <b>±{fmtQty(p.sigma, ing)}</b> 정도 벗어나서, &lsquo;{SERVICE_LEVELS[settings.serviceLevel].label}&rsquo; 기준으로 여유분 <b>{fmtQty(p.safetyStock, ing)}</b>를 더 잡았습니다.
              {p.zReasons.length > 0 && <span className="hint"> ({p.zReasons.join(", ")})</span>}</li>
            <li>지금 재고, 들어올 물량, 사용기한이 지나 버릴 양을 날짜별로 따져 보면 <b>{fmtQty(p.recommendedUse, ing)}</b>가 더 필요합니다.</li>
            <li>1{ing.order_unit}에 {ing.use_qty_per_order_unit.toLocaleString("ko-KR")}{ing.use_unit}씩 들어 있어 <b>{p.recBeforeCut}{ing.order_unit}</b>로 올림했습니다{ing.min_order_qty > 1 ? ` (최소 ${ing.min_order_qty}${ing.order_unit})` : ""}.
              단가 {won(p.unitPrice)}/{ing.order_unit}{p.priceFrom !== "-" && ` (${shortDate(p.priceFrom)}부터 적용)`}.</li>
            {p.recommendedUnits < p.recBeforeCut && (
              <li><b>버릴 양을 줄이려고 {p.recBeforeCut}→{p.recommendedUnits}{ing.order_unit}로 줄였습니다.</b> 줄여도 품절 위험은 그대로이고, 이번 발주분 중 버릴 예상량이 {fmtQty(p.wasteBefore, ing)}에서 {fmtQty(p.wasteAfter, ing)}로 줄어듭니다.</li>
            )}
          </ol>
        ) : <p className="hint mt-1">공급사 발주 일정 정보가 없어 계산하지 못했습니다.</p>}
        {packRisk && (
          <p className="mt-2 rounded-md bg-[var(--medium-soft)] px-2.5 py-1.5 text-[var(--medium)]">
            포장 단위 주의: 1{ing.order_unit}가 이 매장 하루 사용량의 약 {packDays.toFixed(1)}일치인데 사용기한은 {ing.shelf_life_days}일입니다. 1{ing.order_unit}씩만 사도 다 못 쓰고 남을 수 있어요.
            {coverage && coverage.expiry_waste_events > 0 && <> 데이터 분석상 이 매장은 기간 중 기한 경과로 {coverage.expiry_waste_events}번, {won(coverage.expiry_waste_cost)}어치를 버렸습니다.</>}
          </p>
        )}
        {(counted || snapshot?.meta.overlay.estimated || edited.length > 0) && (
          <ul className="mt-2 ml-4 list-disc text-[var(--low)]">
            {counted && <li>지금 남은 양은 오늘 입력한 실사 수량입니다 (07시 입고분 포함).</li>}
            {!counted && snapshot?.meta.overlay.estimated && <li>지금 남은 양은 올린 판매 기록으로 계산한 추정치입니다. 실사 재고를 입력하면 정확해집니다.</li>}
            {edited.map((e, i) => <li key={i}>사용자가 바꾼 조건 적용: {e.field} = {e.value}</li>)}
          </ul>
        )}
        {p.notes.length > 0 && <ul className="mt-2 ml-4 list-disc text-[var(--medium)]">{p.notes.map((n, i) => <li key={i}>{n}</li>)}</ul>}
      </div>
      <div>
        <b>다음 입고 전까지 재고 흐름 <span className="hint font-normal">(이 수량대로 발주했을 때 · 그 뒤는 다음 발주가 채움)</span></b>
        <table className="tbl mt-1 !text-xs">
          <thead><tr><th>날짜</th><th className="num">들어옴</th><th className="num">쓸 양</th><th className="num">모자람</th><th className="num">버림</th><th className="num">하루 끝 남은 양</th></tr></thead>
          <tbody>
            {p.planned.filter((d) => !p.nextSlot || d.date < p.nextSlot.arrivalDate).slice(0, 14).map((d) => (
              <tr key={d.date}>
                <td>{shortDate(d.date)}</td><td className="num">{main(d.arrived)}</td><td className="num">{main(d.need)}</td>
                <td className="num" style={{ color: d.shortage ? "var(--high)" : undefined }}>{main(d.shortage)}</td>
                <td className="num" style={{ color: d.expired ? "var(--medium)" : undefined }}>{main(d.expired)}</td>
                <td className="num" style={{ color: d.closing <= 0 ? "var(--high)" : undefined }}>{d.closing > 0 ? main(d.closing) : "없음"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
