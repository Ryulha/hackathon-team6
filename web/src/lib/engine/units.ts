import type { Ingredient, PriceRow } from "../types";

/** 사용단위 수량 → 발주단위 수(올림). 포장 단위로만 발주 가능하므로 항상 올림. */
export const toOrderUnits = (useQty: number, ing: Ingredient) =>
  useQty <= 0 ? 0 : Math.ceil(useQty / ing.use_qty_per_order_unit - 1e-9);

export const orderToUse = (orderQty: number, ing: Ingredient) => orderQty * ing.use_qty_per_order_unit;

/** 기준일 시점 단가: valid_from ≤ date 중 가장 최근. 없으면 가장 이른 단가로 대체(가정). */
export function priceAt(prices: PriceRow[], ingredientId: string, date: string): PriceRow | undefined {
  const rows = prices.filter((p) => p.ingredient_id === ingredientId).sort((a, b) => a.valid_from.localeCompare(b.valid_from));
  let hit: PriceRow | undefined;
  for (const p of rows) if (p.valid_from <= date) hit = p;
  return hit ?? rows[0];
}

/** 사용단위 1개당 원가 (폐기 비용 추정용) */
export const pricePerUseUnit = (orderUnitPrice: number, ing: Ingredient) => orderUnitPrice / ing.use_qty_per_order_unit;
