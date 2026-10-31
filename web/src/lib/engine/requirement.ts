import type { BomRow } from "../types";
import type { MenuForecast } from "./forecast";

/**
 * 메뉴 예측 × BOM → 식자재 일별 소요량(use_unit).
 * 세트 메뉴는 세트 자체 BOM을 사용(명세서) — 구성품 BOM을 다시 더하지 않는다.
 * 반환: ingredientId → date → qty
 */
export function ingredientNeeds(forecast: MenuForecast[], bom: BomRow[]): Map<string, Map<string, number>> {
  const bomByMenu = new Map<string, BomRow[]>();
  for (const b of bom) (bomByMenu.get(b.menu_id) ?? bomByMenu.set(b.menu_id, []).get(b.menu_id)!).push(b);
  const out = new Map<string, Map<string, number>>();
  for (const f of forecast) {
    if (!f.qty) continue;
    for (const b of bomByMenu.get(f.menuId) ?? []) {
      const m = out.get(b.ingredient_id) ?? out.set(b.ingredient_id, new Map()).get(b.ingredient_id)!;
      m.set(f.date, (m.get(f.date) ?? 0) + f.qty * b.qty_per_menu);
    }
  }
  return out;
}
