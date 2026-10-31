import type { Snapshot } from "../types";
import { buildAlerts } from "./alerts";
import { addDays, range } from "./dates";
import { forecastContext, forecastMenus, holidaySet, ingredientSigma, menuBasis } from "./forecast";
import { groupBySupplier, planIngredient } from "./ordering";
import { ingredientNeeds } from "./requirement";
import { OPT, type EngineSettings } from "./settings";

export type { Alert } from "./alerts";
export type { IngredientPlan, MinAmountFix, SupplierOrder } from "./ordering";
export { DEFAULT_SETTINGS, OPT, SERVICE_LEVELS, type EngineSettings, type ServiceLevel } from "./settings";

/** 사용자가 직접 수정한 발주 수량: ingredientId → 발주단위 수 */
export type Overrides = Record<string, number>;

/** 엔진 전체 실행 — 순수 함수. 설정·수정값이 바뀌면 화면에서 다시 호출한다. */
export function runEngine(snap: Snapshot, s: EngineSettings, overrides: Overrides = {}) {
  const { asOf, storeId } = snap.meta;
  // 다음다음 발주 도착까지 덮도록 넉넉히 예측(최대 리드타임 + 2주)
  const maxLead = Math.max(0, ...snap.suppliers.map((x) => x.lead_time_days || 0));
  const dates = range(asOf, addDays(asOf, Math.max(s.horizonDays, 14) + maxLead + 14 + s.leadTimeBufferDays));

  const holidays = holidaySet(snap.calendar, snap.holidays.map((h) => h.date));
  const ctx = forecastContext(new Map(snap.dailyTotals.map((t) => [t.date, t.y])), asOf, holidays, s);
  const basis = menuBasis(snap.demandHistory, snap.menus, snap.menuAvailability, snap.promotions, storeId, asOf, ctx, s);
  const ml = new Map(snap.mlForecast.map((f) => [`${f.date}|${f.menuId}`, f.qty]));
  const forecast = forecastMenus(basis, snap.menuAvailability, storeId, dates, ctx, s, ml);
  const needs = ingredientNeeds(forecast, snap.bom);
  const sigma = ingredientSigma(snap.demandHistory, snap.bom, storeId, asOf);

  // 최근 28일(기준일 전날까지) 품절 일수 — 품절은 마감 후 보고되므로 당일 기록은 쓰지 않음
  const soFrom = addDays(asOf, -OPT.stockoutWindow);
  const stockouts = new Map<string, Set<string>>();
  for (const so of snap.recentStockouts) {
    if (so.store_id !== storeId || so.date >= asOf || so.date < soFrom) continue;
    (stockouts.get(so.ingredient_id) ?? stockouts.set(so.ingredient_id, new Set()).get(so.ingredient_id)!).add(so.date);
  }

  const plans = snap.ingredients.map((ing) => planIngredient(
    snap, ing, needs.get(ing.ingredient_id) ?? new Map(), s,
    { sigma: sigma.get(ing.ingredient_id) ?? 0, stockouts28: stockouts.get(ing.ingredient_id)?.size ?? 0 },
    overrides[ing.ingredient_id],
  ));
  const orders = groupBySupplier(plans, asOf);
  const alerts = buildAlerts(snap, plans, orders, s);
  return { ctx, basis, forecast, needs, plans, orders, alerts };
}

export type EngineResult = ReturnType<typeof runEngine>;
