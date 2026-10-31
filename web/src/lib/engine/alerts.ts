import type { Snapshot } from "../types";
import { addDays, shortDate } from "./dates";
import type { IngredientPlan, SupplierOrder } from "./ordering";
import type { EngineSettings } from "./settings";
import { daysOf, fmtQty, pricePerUseUnit } from "./units";

export type AlertKind = "shortage" | "order_today" | "expiry" | "overstock" | "below_min";
export type Alert = {
  kind: AlertKind;
  severity: "high" | "medium" | "low";
  ingredientId?: string;
  supplierId?: string;
  title: string;
  /** 판단 근거(수치 포함) */
  detail: string;
};

const f = (n: number) => Math.round(n).toLocaleString("ko-KR");

export function buildAlerts(snap: Snapshot, plans: IngredientPlan[], orders: SupplierOrder[], s: EngineSettings): Alert[] {
  const out: Alert[] = [];
  const warnUntil = addDays(snap.meta.asOf, s.expiryWarnDays);

  for (const p of plans) {
    const { ingredient: ing } = p;
    if (p.shortageBeforeArrival > 0) {
      out.push({
        kind: "shortage", severity: "high", ingredientId: ing.ingredient_id,
        title: `${ing.ingredient_name}이(가) 다음 입고 전에 떨어집니다`,
        detail: `${p.firstShortageDate ? shortDate(p.firstShortageDate) : ""}부터 모자라고, 다음 정기 입고(${p.slot ? shortDate(p.slot.arrivalDate) : "-"})까지 ${fmtQty(p.shortageBeforeArrival, ing)}가 부족합니다. 긴급 발주(다음 날 입고)나 다른 매장에서 옮겨오기를 검토하세요.`,
      });
    }
    const expiring = snap.lots.filter((l) => l.ingredient_id === ing.ingredient_id && l.last_use_date <= warnUntil && l.remaining_qty > 0);
    const expiredSoon = p.planned.filter((d) => d.date <= warnUntil).reduce((a, d) => a + d.expired, 0);
    if (expiring.length && expiredSoon > 0) {
      out.push({
        kind: "expiry", severity: "medium", ingredientId: ing.ingredient_id,
        title: `${ing.ingredient_name} 사용기한이 곧 끝납니다`,
        detail: `${expiring.map((l) => `${fmtQty(l.remaining_qty, ing)}는 ${shortDate(l.last_use_date)}까지`).join(", ")} 써야 합니다. 지금 예상대로면 ${fmtQty(expiredSoon, ing)}(약 ${f(expiredSoon * pricePerUseUnit(p.unitPrice, ing))}원)를 버리게 됩니다. 먼저 쓰거나 다른 매장으로 옮기세요.`,
      });
    }
    if (p.avgDailyNeed > 0 && p.onHand / p.avgDailyNeed > s.overstockDays) {
      out.push({
        kind: "overstock", severity: "low", ingredientId: ing.ingredient_id,
        title: `${ing.ingredient_name} 재고가 너무 많습니다`,
        detail: `지금 ${fmtQty(p.onHand, ing)}로 약 ${daysOf(p.onHand, p.avgDailyNeed).toFixed(0)}일을 쓸 수 있습니다(기준 ${s.overstockDays}일). 당분간 발주를 줄이세요.`,
      });
    }
  }
  for (const o of orders) {
    if (o.isToday) {
      out.push({
        kind: "order_today", severity: "medium", supplierId: o.supplier.supplier_id,
        title: `${o.supplier.supplier_name}에 오늘 ${o.cutoff} 전까지 발주하세요`,
        detail: `${o.lines.length}개 품목, ${f(o.amount)}원 · ${shortDate(o.arrivalDate)} 입고`,
      });
    }
    if (o.belowMin) {
      out.push({
        kind: "below_min", severity: "medium", supplierId: o.supplier.supplier_id,
        title: `${o.supplier.supplier_name} 발주 금액이 최소 금액보다 적습니다`,
        detail: `${shortDate(o.orderDate)} 발주가 ${f(o.amount)}원으로 최소 ${f(o.supplier.min_order_amount)}원에 ${f(o.minGap)}원 모자라 이대로는 발주할 수 없습니다. 다른 품목을 미리 담거나 다음 발주일로 합치세요.`,
      });
    }
  }
  const rank = { high: 0, medium: 1, low: 2 };
  return out.sort((a, b) => rank[a.severity] - rank[b.severity]);
}
