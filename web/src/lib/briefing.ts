/** 화면의 최종 계산값을 설명용 데이터로 변환. 발주 엔진·수량은 변경하지 않는다. */
import type { EngineResult, EngineSettings, IngredientPlan } from "./engine";
import type { Snapshot } from "./types";

export type BriefItem = {
  id: string; name: string; action: string; reason: string;
  orderQty: number; orderUnit: string; useUnit: string; amount: number;
  arrival: string | null; shortageBefore: number; shortageAfter: number;
  existingWaste: number; additionalWaste: number;
};
export type BriefContext = {
  storeId: string; asOf: string; settings: EngineSettings; totalAmount: number;
  itemCount: number; items: BriefItem[];
  supplierWarnings: { name: string; gap: number }[];
};
export type Brief = { overview: string; items: { id: string; explanation: string }[] };
export type BriefResponse = {
  source: "gemini" | "calculation"; brief: Brief; message: string;
  generatedAt?: string; cached?: boolean; retryAfterSeconds?: number;
};

const round = (n: number) => Math.round(n * 1000) / 1000;

function describe(p: IngredientPlan): BriefItem {
  const shortageAfter = Math.max(0, p.plannedShortage - p.shortageBeforeArrival);
  const baseWaste = p.baseline.filter((d) => !p.nextSlot || d.date < p.nextSlot.arrivalDate)
    .reduce((sum, d) => sum + d.expired, 0);
  let action = "발주 확인";
  let reason = "현재 입력 수량으로 다음 입고 기회 전까지 예상 소요량을 충당할 전망입니다. 공급사 조건을 확인한 뒤 발주하세요.";
  if (p.shortageBeforeArrival > 1e-6) {
    action = "입고 전 부족 대응";
    reason = "정기 입고 전에 부족할 전망입니다. 발주량을 늘려도 입고 전 부족은 해결되지 않으므로 다른 매장의 여유 재고를 확인하세요. 긴급발주도 다음날 입고됩니다.";
  } else if (shortageAfter > 1e-6) {
    action = "발주량 재확인";
    reason = "현재 입력 수량으로는 입고 이후에도 부족할 전망입니다. 수량을 늘리거나 매장 이동 가능 여부를 확인하세요.";
  } else if (p.plannedWaste > 1e-6) {
    action = "사용기한 우선 확인";
    reason = "사용기한 전에 소진하지 못할 재고가 예상됩니다. 기존 재고 우선 사용과 추가 발주량을 함께 확인하세요.";
  } else if (p.finalUnits === 0) {
    action = "추가 발주 보류";
    reason = "현재 전망에서는 이번 입고 주기에 추가 발주할 필요가 없습니다.";
  }
  return {
    id: p.ingredient.ingredient_id, name: p.ingredient.ingredient_name, action, reason,
    orderQty: p.finalUnits, orderUnit: p.ingredient.order_unit, useUnit: p.ingredient.use_unit,
    amount: p.amount, arrival: p.slot?.arrivalDate ?? null,
    shortageBefore: round(p.shortageBeforeArrival), shortageAfter: round(shortageAfter),
    existingWaste: round(baseWaste), additionalWaste: round(Math.max(0, p.plannedWaste - baseWaste)),
  };
}

export function buildBriefContext(snap: Snapshot, result: EngineResult, settings: EngineSettings): BriefContext {
  const rank = (p: IngredientPlan) => p.shortageBeforeArrival > 1e-6 ? 0 : p.plannedShortage > 1e-6 ? 1 : p.plannedWaste > 1e-6 ? 2 : 3;
  const active = result.plans.filter((p) => p.finalUnits > 0 || p.shortageBeforeArrival > 1e-6 || p.plannedShortage > 1e-6 || p.plannedWaste > 1e-6);
  const chosen = [...active].sort((a, b) => rank(a) - rank(b) || b.amount - a.amount || a.ingredient.ingredient_id.localeCompare(b.ingredient.ingredient_id));
  return {
    storeId: snap.meta.storeId, asOf: snap.meta.asOf, settings: { ...settings },
    totalAmount: result.plans.reduce((sum, p) => sum + p.amount, 0), itemCount: active.length,
    items: chosen.slice(0, 5).map(describe),
    supplierWarnings: result.orders.filter((o) => o.belowMin).map((o) => ({ name: o.supplier.supplier_name, gap: o.minGap })),
  };
}

export function fallbackBrief(context: BriefContext): Brief {
  const urgent = context.items.some((i) => i.shortageBefore > 0 || i.shortageAfter > 0);
  return {
    overview: urgent ? "부족이 예상되는 품목부터 확인하고, 입고 전 대응과 발주 수량을 나누어 판단하세요." : "사용기한과 공급사 조건을 확인한 뒤 발주서를 확정하세요.",
    items: context.items.map((i) => ({ id: i.id, explanation: i.reason })),
  };
}

/** 수치·날짜를 새로 만들거나 다른 품목을 설명하는 응답은 채택하지 않는다. */
export function validBrief(value: unknown, context: BriefContext): value is Brief {
  const text = (s: unknown) => typeof s === "string" && s.trim().length > 0 && s.length <= 400 && !/[0-9<>]/.test(s);
  if (!value || typeof value !== "object") return false;
  const b = value as Brief;
  if (Object.keys(b).sort().join() !== "items,overview" || !text(b.overview) || !Array.isArray(b.items) || b.items.length !== context.items.length) return false;
  const ids = new Set(context.items.map((i) => i.id));
  for (const item of b.items) {
    if (!item || typeof item !== "object" || Object.keys(item).sort().join() !== "explanation,id" || !ids.delete(item.id) || !text(item.explanation)) return false;
  }
  return ids.size === 0;
}

/** POST 본문은 화면에서 계산된 설명용 요약이다. 저장·발주 실행에는 사용하지 않는다. */
export function validContext(value: unknown, storeId: string): value is BriefContext {
  if (!value || typeof value !== "object") return false;
  const c = value as BriefContext;
  const number = (n: unknown) => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1e12;
  const label = (s: unknown) => typeof s === "string" && s.length > 0 && s.length <= 400 && !/[<>]/.test(s);
  const date = (s: unknown) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && Number.isFinite(Date.parse(s + "T00:00:00Z")) && new Date(s + "T00:00:00Z").toISOString().slice(0, 10) === s;
  if (c.storeId !== storeId || !/^S0[1-3]$/.test(c.storeId) || !date(c.asOf) || !number(c.totalAmount) || !number(c.itemCount)) return false;
  if (!c.settings || typeof c.settings !== "object" || !Array.isArray(c.items) || c.items.length > 5 || !Array.isArray(c.supplierWarnings) || c.supplierWarnings.length > 10) return false;
  const seen = new Set<string>();
  for (const i of c.items) {
    if (!i || typeof i !== "object" || !/^I\d{3}$/.test(i.id) || seen.has(i.id)) return false;
    seen.add(i.id);
    if (![i.name, i.action, i.reason, i.orderUnit, i.useUnit].every(label)) return false;
    if (![i.orderQty, i.amount, i.shortageBefore, i.shortageAfter, i.existingWaste, i.additionalWaste].every(number) || !Number.isInteger(i.orderQty)) return false;
    if (i.arrival !== null && !date(i.arrival)) return false;
  }
  return c.supplierWarnings.every((w) => w && label(w.name) && number(w.gap));
}
