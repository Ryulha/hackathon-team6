import type { Snapshot } from "../types";
import { addDays } from "./dates";
import type { IngredientPlan, SupplierOrder } from "./ordering";
import type { EngineSettings } from "./settings";
import { pricePerUseUnit } from "./units";

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
    const u = ing.use_unit;
    if (p.shortageBeforeArrival > 0) {
      out.push({
        kind: "shortage", severity: "high", ingredientId: ing.ingredient_id,
        title: `${ing.ingredient_name} 정기 입고 전 부족 예상`,
        detail: `${p.firstShortageDate}부터 부족, 다음 입고(${p.slot?.arrivalDate ?? "-"}) 전까지 ${f(p.shortageBeforeArrival)}${u} 모자람 → 긴급발주 또는 매장 간 이동 검토`,
      });
    }
    const expiring = snap.lots.filter((l) => l.ingredient_id === ing.ingredient_id && l.last_use_date <= warnUntil && l.remaining_qty > 0);
    const expiredSoon = p.planned.filter((d) => d.date <= warnUntil).reduce((a, d) => a + d.expired, 0);
    if (expiring.length && expiredSoon > 0) {
      out.push({
        kind: "expiry", severity: "medium", ingredientId: ing.ingredient_id,
        title: `${ing.ingredient_name} 사용기한 임박`,
        detail: `${expiring.map((l) => `${l.lot_id}(${l.last_use_date}까지 ${f(l.remaining_qty)}${u})`).join(", ")} 중 예상 폐기 ${f(expiredSoon)}${u}, 약 ${f(expiredSoon * pricePerUseUnit(p.unitPrice, ing))}원`,
      });
    }
    if (p.avgDailyNeed > 0 && p.startStock / p.avgDailyNeed > s.overstockDays) {
      out.push({
        kind: "overstock", severity: "low", ingredientId: ing.ingredient_id,
        title: `${ing.ingredient_name} 과잉 재고`,
        detail: `현재고 ${f(p.startStock)}${u} = 약 ${(p.startStock / p.avgDailyNeed).toFixed(1)}일치 (기준 ${s.overstockDays}일)`,
      });
    }
  }
  for (const o of orders) {
    if (o.isToday) {
      out.push({
        kind: "order_today", severity: "medium", supplierId: o.supplier.supplier_id,
        title: `${o.supplier.supplier_name} 오늘 ${o.cutoff}까지 발주`,
        detail: `${o.lines.length}개 품목, ${f(o.amount)}원, ${o.arrivalDate} 입고 예정`,
      });
    }
    if (o.belowMin) {
      out.push({
        kind: "below_min", severity: "medium", supplierId: o.supplier.supplier_id,
        title: `${o.supplier.supplier_name} 최소 발주금액 미달`,
        detail: `${o.orderDate} 발주 ${f(o.amount)}원 < 최소 ${f(o.supplier.min_order_amount)}원 (부족 ${f(o.minGap)}원) → 다른 품목 앞당겨 담기 또는 다음 발주일로 합치기`,
      });
    }
  }
  const rank = { high: 0, medium: 1, low: 2 };
  return out.sort((a, b) => rank[a.severity] - rank[b.severity]);
}
