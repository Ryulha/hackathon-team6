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

// ---------- 사람이 읽기 쉬운 수량 표시 ----------

/** 무게·부피 단위는 숫자만 봐서는 양을 가늠하기 어려움 → 포장 단위를 주 표시로 */
const MEASURED = new Set(["g", "ml", "kg", "l", "L"]);

/** 사용단위 그대로(큰 값은 kg·L 로) */
export function rawQty(qty: number, unit: string): string {
  const n = (v: number, d = 0) => v.toLocaleString("ko-KR", { maximumFractionDigits: d });
  if (unit === "g" && Math.abs(qty) >= 1000) return `${n(qty / 1000, 1)}kg`;
  if (unit === "ml" && Math.abs(qty) >= 1000) return `${n(qty / 1000, 1)}L`;
  return `${n(qty)}${unit}`;
}

/** 포장 단위로 환산 (10 미만은 소수 한 자리) */
export function packQty(qty: number, ing: Ingredient): string {
  const packs = qty / ing.use_qty_per_order_unit;
  if (packs > 0 && packs < 0.1) return `0.1${ing.order_unit} 미만`;
  return `${packs.toLocaleString("ko-KR", { maximumFractionDigits: Math.abs(packs) < 10 ? 1 : 0 })}${ing.order_unit}`;
}

/**
 * 화면용 수량: main 은 크게, sub 는 작게 보조 표시.
 * g·ml 품목은 "2.3박스 (11.5kg)", 개·매·장 품목은 "1,141개 (6.8박스)".
 */
export function describeQty(qty: number, ing: Ingredient): { main: string; sub: string } {
  return MEASURED.has(ing.use_unit)
    ? { main: packQty(qty, ing), sub: rawQty(qty, ing.use_unit) }
    : { main: rawQty(qty, ing.use_unit), sub: packQty(qty, ing) };
}

export const fmtQty = (qty: number, ing: Ingredient) => {
  const d = describeQty(qty, ing);
  return `${d.main}(${d.sub})`;
};

/** 현재 양으로 며칠 쓸 수 있는지 (사용량이 없으면 Infinity) */
export const daysOf = (qty: number, dailyUse: number) => (dailyUse > 0 ? qty / dailyUse : Infinity);
