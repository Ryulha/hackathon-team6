import { describe, expect, it } from "vitest";
import { context, brief } from "../../tests/briefing-fixture";
import { buildBriefContext, fallbackBrief, validBrief, validContext } from "./briefing";
import type { EngineResult, IngredientPlan } from "./engine";
import { DEFAULT_SETTINGS } from "./engine";
import type { Snapshot } from "./types";

describe("briefing validation", () => {
  it("선택 매장과 안전한 날짜·수량만 허용", () => {
    expect(validContext(context(), "S03")).toBe(true);
    expect(validContext(context(), "S01")).toBe(false);
    expect(validContext({ ...context(), asOf: "2026-99-99" }, "S03")).toBe(false);
    const c = context(); c.items[0].orderQty = 1.5;
    expect(validContext(c, "S03")).toBe(false);
  });
  it("숫자·다른 품목·중복·누락·빈 설명을 거부", () => {
    expect(validBrief(brief(), context())).toBe(true);
    for (const bad of [
      { ...brief(), overview: "추가로 9박스 발주하세요." },
      { ...brief(), items: brief().items.slice(0, 1) },
      { ...brief(), items: [brief().items[0], brief().items[0]] },
      { ...brief(), items: [{ id: "I999", explanation: "재고를 확인하세요." }, brief().items[1]] },
      { ...brief(), overview: "" },
    ]) expect(validBrief(bad, context())).toBe(false);
  });
  it("API 없이도 모든 선택 품목의 기본 설명 제공", () => {
    const c = context();
    expect(fallbackBrief(c).items).toHaveLength(2);
    expect(fallbackBrief(c).overview).toContain("부족");
  });
});

describe("최종 발주 결과와 설명 동기화", () => {
  const plan = (id: string, overrides: Partial<IngredientPlan> = {}) => ({
    ingredient: { ingredient_id: id, ingredient_name: "식자재", order_unit: "BOX", use_unit: "g" },
    finalUnits: 1, amount: 4000, shortageBeforeArrival: 0, plannedShortage: 0, plannedWaste: 20,
    baseline: [{ date: "2026-09-15", expired: 10 }, { date: "2026-09-18", expired: 100 }],
    slot: { arrivalDate: "2026-09-16" }, nextSlot: { arrivalDate: "2026-09-17" }, ...overrides,
  } as IngredientPlan);
  const snap = { meta: { storeId: "S03", asOf: "2026-09-15" } } as Snapshot;
  it("기존·추가 폐기를 같은 입고 주기로 비교", () => {
    const result = { plans: [plan("I009")], orders: [] } as unknown as EngineResult;
    const c = buildBriefContext(snap, result, DEFAULT_SETTINGS);
    expect(c.items[0]).toMatchObject({ existingWaste: 10, additionalWaste: 10, orderQty: 1, amount: 4000 });
  });
  it("수량·조건 변경을 식별하고, 0수량 부족 품목도 설명에 유지", () => {
    const p = plan("I020", { finalUnits: 0, amount: 0, shortageBeforeArrival: 3, plannedShortage: 7 });
    const result = { plans: [p], orders: [] } as unknown as EngineResult;
    const c = buildBriefContext(snap, result, DEFAULT_SETTINGS);
    expect(c.items[0]).toMatchObject({ orderQty: 0, shortageBefore: 3, shortageAfter: 4, action: "입고 전 부족 대응" });
    const changed = buildBriefContext(snap, { ...result, plans: [{ ...p, finalUnits: 2, amount: 8000 }] }, DEFAULT_SETTINGS);
    expect(changed.items[0].orderQty).toBe(2);
    expect(changed.totalAmount).toBe(8000);
    expect(JSON.stringify(changed)).not.toBe(JSON.stringify(c));
  });
  it("부족·폐기 순으로 우선하고 최대 다섯 품목만 전송", () => {
    const plans = Array.from({ length: 8 }, (_, i) => plan(`I00${i}`, { plannedWaste: 0 }));
    plans[7] = plan("I007", { shortageBeforeArrival: 5 });
    const c = buildBriefContext(snap, { plans, orders: [] } as unknown as EngineResult, DEFAULT_SETTINGS);
    expect(c.items).toHaveLength(5);
    expect(c.items[0].id).toBe("I007");
    expect(c.itemCount).toBe(8);
  });
});
