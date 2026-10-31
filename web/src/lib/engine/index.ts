import type { Snapshot } from "../types";
import { buildAlerts } from "./alerts";
import { addDays, range } from "./dates";
import { forecastMenus, menuBasis } from "./forecast";
import { groupBySupplier, planIngredient } from "./ordering";
import { ingredientNeeds } from "./requirement";
import type { EngineSettings } from "./settings";

export type { Alert } from "./alerts";
export type { IngredientPlan, SupplierOrder } from "./ordering";
export { DEFAULT_SETTINGS, type EngineSettings } from "./settings";

/** 사용자가 직접 수정한 발주 수량: ingredientId → 발주단위 수 */
export type Overrides = Record<string, number>;

/** 엔진 전체 실행 — 순수 함수. 설정·수정값이 바뀌면 화면에서 다시 호출한다. */
export function runEngine(snap: Snapshot, s: EngineSettings, overrides: Overrides = {}) {
  const { asOf, storeId } = snap.meta;
  // 다음다음 발주 도착까지 덮도록 넉넉히 예측(최대 리드타임 + 2주)
  const maxLead = Math.max(0, ...snap.suppliers.map((x) => x.lead_time_days || 0));
  const dates = range(asOf, addDays(asOf, Math.max(s.horizonDays, 14) + maxLead + 14 + s.leadTimeBufferDays));

  const basis = menuBasis(snap.demandHistory, snap.menus, snap.menuAvailability, snap.promotions, storeId, asOf, s);
  const forecast = forecastMenus(basis, snap.menuAvailability, snap.promotions, storeId, dates, s);
  const needs = ingredientNeeds(forecast, snap.bom);

  const plans = snap.ingredients.map((ing) =>
    planIngredient(snap, ing, needs.get(ing.ingredient_id) ?? new Map(), s, overrides[ing.ingredient_id]));
  const orders = groupBySupplier(plans, asOf);
  const alerts = buildAlerts(snap, plans, orders, s);
  return { basis, forecast, needs, plans, orders, alerts };
}

export type EngineResult = ReturnType<typeof runEngine>;
