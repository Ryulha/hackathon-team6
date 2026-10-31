// 매장 진단 경고 규칙 — 손으로 만든 숫자(제공 데이터 아님)
import { describe, expect, it } from "vitest";
import { diagnose, type Period, type StoreInput } from "./diagnosis";

const P = (o: Partial<Period>): Period => ({ sales: 1000, food: 350, waste: 1, expiryWaste: 0, lostQty: 0, lostAmount: 0, emergencyCount: 0, emergencyAmount: 0, ...o });
const S = (id: string, cur: Partial<Period>, prev: Partial<Period> = {}, extra: Partial<StoreInput> = {}): StoreInput =>
  ({ storeId: id, storeName: id, cur: P(cur), prev: P(prev), wasteTop: [], emergencyItems: [], ...extra });

describe("매장 진단", () => {
  it("모두 비슷하면 경고 없음", () => {
    const r = diagnose([S("A", {}), S("B", {}), S("C", {})]);
    expect(r.every((s) => s.flags.length === 0)).toBe(true);
  });
  it("식자재비율이 다른 매장 평균보다 0.5%p 이상 높으면 경고 + 폐기 원인별 해결책", () => {
    const r = diagnose([
      S("A", {}), S("B", {}),
      S("C", { food: 360 }, {}, { wasteTop: [{ ingredient: "양상추", reason: "소비기한 경과", cost: 100 }] }),
    ]);
    const c = r.find((s) => s.storeId === "C")!;
    expect(c.flags.map((f) => f.key)).toEqual(["food"]);
    expect(c.flags[0].text).toContain("1.0%p");
    expect(c.actions[0]).toContain("양상추");
    expect(c.actions[0]).toContain("발주로 줄일 수 있는");
    expect(r.find((s) => s.storeId === "A")!.flags).toHaveLength(0);
  });
  it("폐기율이 직전 기간의 1.5배 이상이면 경고 (다른 매장과 비슷해도)", () => {
    const r = diagnose([S("A", { waste: 3 }, { waste: 1 }), S("B", { waste: 2.5 }), S("C", { waste: 2.5 })]);
    expect(r[0].flags.map((f) => f.key)).toEqual(["waste"]);
    expect(r[0].flags[0].text).toContain("직전 기간");
  });
  it("긴급발주·품절은 한 번이라도 있으면 표시하고 여유분 해결책", () => {
    const r = diagnose([S("A", { emergencyCount: 1, emergencyAmount: 2900, lostQty: 8, lostAmount: 50000 }, {}, { emergencyItems: ["코울슬로"] }), S("B", {})]);
    expect(r[0].flags.map((f) => f.key)).toEqual(["emergency", "lost"]);
    expect(r[0].flags[0].text).toContain("코울슬로");
    expect(r[0].actions.some((a) => a.includes("넉넉하게"))).toBe(true);
  });
});
