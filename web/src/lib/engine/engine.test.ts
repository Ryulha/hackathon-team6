// 손으로 만든 소형 픽스처(제공 데이터 아님)로 계산 규칙 검증
import { describe, expect, it } from "vitest";
import type { Ingredient, Snapshot, Supplier } from "../types";
import { addDays, parseList, parseWeekdays, range, shortDate, weekdayOf } from "./dates";
import { forecastMenus } from "./forecast";
import { runEngine } from "./index";
import { planIngredient } from "./ordering";
import { simulate } from "./lots";
import { orderSlots } from "./schedule";
import { DEFAULT_SETTINGS, OPT } from "./settings";
import { daysOf, describeQty, priceAt, toOrderUnits } from "./units";

const ing: Ingredient = {
  ingredient_id: "I1", ingredient_name: "패티", supplier_id: "SP", use_unit: "g", order_unit: "팩",
  use_qty_per_order_unit: 1000, storage: "냉동", shelf_life_days: 30, min_order_qty: 2,
};
const sup: Supplier = {
  supplier_id: "SP", supplier_name: "공급", order_days: "월,수,금", order_cutoff: "14:00",
  lead_time_days: 2, delivery_days: "화,목,토", min_order_amount: 50000, note: "",
};

describe("dates", () => {
  it("요일 포맷 관대하게 파싱", () => {
    expect([...parseWeekdays("월,수,금")]).toEqual(["월", "수", "금"]);
    expect([...parseWeekdays("월수금")]).toEqual(["월", "수", "금"]);
    expect([...parseWeekdays("Mon|Wed")]).toEqual(["월", "수"]);
    expect(parseWeekdays("매일").size).toBe(7);
    expect(parseList('["M01","M02"]')).toEqual(["M01", "M02"]);
  });
  it("2026-10-01은 목요일", () => expect(weekdayOf("2026-10-01")).toBe("목"));
});

describe("units", () => {
  it("발주단위 올림 환산", () => {
    expect(toOrderUnits(1, ing)).toBe(1);
    expect(toOrderUnits(2000, ing)).toBe(2);
    expect(toOrderUnits(2001, ing)).toBe(3);
    expect(toOrderUnits(0, ing)).toBe(0);
  });
  it("단가는 valid_from 시점 기준", () => {
    const p = [{ ingredient_id: "I1", valid_from: "2026-01-01", unit_price: 100 }, { ingredient_id: "I1", valid_from: "2026-09-01", unit_price: 120 }];
    expect(priceAt(p, "I1", "2026-08-31")?.unit_price).toBe(100);
    expect(priceAt(p, "I1", "2026-09-01")?.unit_price).toBe(120);
  });
});

describe("schedule", () => {
  // 2026-10-05 = 월
  it("마감 전이면 당일 발주, 리드타임 후 입고요일", () => {
    const [s1, s2] = orderSlots(sup, "2026-10-05", "09:00", 2);
    expect(s1).toMatchObject({ orderDate: "2026-10-05", arrivalDate: "2026-10-08" });
    expect(s2.orderDate).toBe("2026-10-07");
  });
  it("마감 지나면 다음 발주일", () => {
    expect(orderSlots(sup, "2026-10-05", "15:00", 1)[0].orderDate).toBe("2026-10-07");
  });
  it("도착일이 입고요일이 아니면 다음 입고일로 밀림", () => {
    // 월 발주 + 2일 = 수 → 입고 화/목/토 → 목
    const s = orderSlots(sup, "2026-10-05", "09:00", 1)[0];
    expect(s.arrivalDate).toBe("2026-10-08");
    expect(s.shiftedDays).toBe(1);
  });
});

describe("lots simulate", () => {
  it("FEFO 소진 + 사용기한 당일 종료 후 폐기", () => {
    const need = new Map([["2026-10-01", 5], ["2026-10-02", 5]]);
    const days = simulate(
      [{ qty: 4, lastUse: "2026-10-01", label: "A" }, { qty: 10, lastUse: "2026-10-10", label: "B" }],
      [], need, ["2026-10-01", "2026-10-02"],
    );
    expect(days[0]).toMatchObject({ consumed: 5, expired: 0, closing: 9 }); // A 4 + B 1 사용
    expect(days[1]).toMatchObject({ consumed: 5, closing: 4 });
  });
  it("남은 묶음은 사용기한 당일 영업 종료 후 폐기, 부족 기록", () => {
    const days = simulate([{ qty: 10, lastUse: "2026-10-01", label: "A" }], [], new Map([["2026-10-01", 3], ["2026-10-02", 3]]), ["2026-10-01", "2026-10-02"]);
    expect(days[0]).toMatchObject({ expired: 7, closing: 0 });
    expect(days[1]).toMatchObject({ shortage: 3 });
  });
});

type DemandRow = Snapshot["demandHistory"][number];

/** 판매 이력: 28일, 하루 qty 개(기본 10) — 메뉴 1개당 100g → 하루 1000g */
const history = (asOf: string, qty: (i: number) => number = () => 10): DemandRow[] => Array.from({ length: 28 }, (_, i) => ({
  date: addDays(asOf, -28 + i), store_id: "S1", menu_id: "M1", demand_qty: qty(i), qty: qty(i),
  cancel_qty: 0, lost_qty: 0, sales_amount: 0, promo_flag: 0,
}));

function snapshot(stock: number, opt: { ing?: Partial<Ingredient>; hist?: DemandRow[]; stockouts?: string[] } = {}): Snapshot {
  const asOf = "2026-10-05";
  const hist = opt.hist ?? history(asOf);
  return {
    meta: {
      asOf, storeId: "S1", dataStart: "2026-09-01", dataEnd: "2026-10-04", providedEnd: "2026-10-04", source: "json", fixture: true,
      overlay: { countedToday: [], estimated: false, uploadedThrough: null, masterEdits: [], priceEntries: 0, appOrders: 0 },
    },
    stores: [], menus: [{ menu_id: "M1", menu_name: "버거", category: "", is_set: 0, set_components: "", virtual_price: 5000 }],
    ingredients: [{ ...ing, ...opt.ing }], bom: [{ menu_id: "M1", ingredient_id: "I1", qty_per_menu: 100, use_unit: "g" }],
    suppliers: [sup], prices: [{ ingredient_id: "I1", valid_from: "2026-01-01", unit_price: 20000 }],
    calendar: [], holidays: [], mlForecast: [], mlModel: null, promotions: [], menuAvailability: [], demandHistory: hist,
    dailyTotals: hist.map((h) => ({ date: h.date, y: h.demand_qty - h.cancel_qty })), inventoryHistory: [],
    lots: stock ? [{ date: "2026-10-04", store_id: "S1", ingredient_id: "I1", lot_id: "L1", receipt_date: "2026-10-01", last_use_date: "2026-10-30", remaining_qty: stock, use_unit: "g" }] : [],
    openOrders: [],
    recentStockouts: (opt.stockouts ?? []).map((date) => ({ date, store_id: "S1", ingredient_id: "I1", first_lost_hour: 12, affected_menus: "M1", report: "" })),
    recentWaste: [],
  };
}

describe("runEngine (팀 발주 최적화 규칙)", () => {
  it("일 1000g, 재고 2500g → 도착(10/8) 전 부족 알림, 책임 기간(10/8~9) 2000g → 2팩", () => {
    const r = runEngine(snapshot(2500), DEFAULT_SETTINGS);
    const p = r.plans[0];
    expect(p.avgDailyNeed).toBeCloseTo(1000);
    expect([p.slot?.arrivalDate, p.nextSlot?.arrivalDate, p.windowDays]).toEqual(["2026-10-08", "2026-10-10", 2]);
    expect(p.shortageBeforeArrival).toBeCloseTo(500); // 10/5~7 소요 3000 − 2500
    expect(r.alerts.some((a) => a.kind === "shortage")).toBe(true);
    expect(p.sigma).toBeCloseTo(0); // 판매가 매일 같으면 변동 0 → 안전재고 0
    expect(p.recommendedUnits).toBe(2);
    expect(p.amount).toBe(40000);
  });
  it("수요 +50% 조정 시 추천 수량 증가 (조건 변경 재계산)", () => {
    const base = runEngine(snapshot(6000), DEFAULT_SETTINGS).plans[0].recommendedUnits;
    const up = runEngine(snapshot(6000), { ...DEFAULT_SETTINGS, demandAdjustPct: 50 }).plans[0].recommendedUnits;
    expect(up).toBeGreaterThan(base);
  });
  it("품목 최소 발주수량 적용 (부족 500g → 1팩 → 최소 2팩)", () => {
    expect(runEngine(snapshot(4500), DEFAULT_SETTINGS).plans[0].recommendedUnits).toBe(2);
  });
  it("최소 발주금액 미달: 급한 품목이 있으면 오래 가는 품목을 1단위씩 더 담는 안", () => {
    const r = runEngine(snapshot(2500), DEFAULT_SETTINGS, { I1: 1 });
    expect(r.plans[0].overridden).toBe(true);
    const o = r.orders[0];
    expect([o.belowMin, o.minGap]).toEqual([true, 30000]);
    expect(o.fix?.urgent).toBe(true);
    expect(o.fix?.adds[0].add).toBe(2); // 2만원 × 2 ≥ 3만원
    expect(o.fix?.covers).toBe(true);
  });
  it("최소 발주금액 미달인데 급한 품목이 없으면 미루기 권장", () => {
    const r = runEngine(snapshot(4500), DEFAULT_SETTINGS);
    expect(r.orders[0].belowMin).toBe(true);
    expect(r.orders[0].fix?.urgent).toBe(true); // 10/9 부족 예상 → 급함
    const calm = runEngine(snapshot(20000), DEFAULT_SETTINGS, { I1: 1 });
    expect(calm.orders[0].fix?.urgent).toBe(false);
  });
  it("z (팀 3차): 보통 3.0, 장기 품목 최소 2.33은 이미 넘으므로 그대로, 최근 품절 상향은 0", () => {
    const longShelf = runEngine(snapshot(2500), DEFAULT_SETTINGS).plans[0];
    expect(longShelf.zUsed).toBe(3.0);
    expect(OPT.zLong).toBe(2.33);
    expect(longShelf.zReasons).toHaveLength(0);
    const withStockout = runEngine(snapshot(2500, { stockouts: ["2026-10-01", "2026-10-02"] }), DEFAULT_SETTINGS).plans[0];
    expect(withStockout.zUsed).toBe(3.0);
    expect(withStockout.stockouts28).toBe(2); // 품절 이력은 근거 표시용으로만
    const old = runEngine(snapshot(2500, { stockouts: ["2026-08-01"] }), DEFAULT_SETTINGS).plans[0];
    expect(old.stockouts28).toBe(0); // 28일 밖은 무시
  });
  it("판매가 들쭉날쭉하면 변동폭만큼 안전재고, 넉넉할수록 더 많이", () => {
    const opt = { ing: { shelf_life_days: 5 }, hist: history("2026-10-05", (i) => (i % 2 ? 5 : 15)) };
    const loose = runEngine(snapshot(6000, opt), { ...DEFAULT_SETTINGS, serviceLevel: "loose" }).plans[0];
    const tight = runEngine(snapshot(6000, opt), { ...DEFAULT_SETTINGS, serviceLevel: "tight" }).plans[0];
    expect(loose.sigma).toBeGreaterThan(0);
    expect(loose.safetyStock).toBeCloseTo(3.5 * loose.sigma * Math.sqrt(3));
    expect(loose.safetyStock).toBeGreaterThan(tight.safetyStock);
    expect(loose.recBeforeCut).toBeGreaterThanOrEqual(tight.recBeforeCut);
  });
  it("폐기 고려 감량: 마지막 팩들이 기한 안에 못 쓰여 버려지면 품절이 안 늘 때까지 줄임", () => {
    // 사용기한 2일, 1팩 1000g, 하루 1000g, 재고 0, 변동폭 354g → 안전재고 3.0×354×√2 ≈1502g → 필요 3502g → 4팩
    // 4팩이면 10/8~9 에 2000g 쓰고 2000g 폐기 → 3팩·2팩은 품절 그대로 폐기만 감소 → 1팩은 품절 증가 → 2팩
    const s = snapshot(0, { ing: { shelf_life_days: 2, min_order_qty: 1 } });
    const need = new Map(Array.from({ length: 30 }, (_, i) => [addDays("2026-10-05", i), 1000]));
    const p = planIngredient(s, s.ingredients[0], need, DEFAULT_SETTINGS, { sigma: 354, stockouts28: 0 });
    expect(p.zUsed).toBe(3.0);
    expect(p.recBeforeCut).toBe(4);
    expect(p.recommendedUnits).toBe(2);
    expect([p.wasteBefore, p.wasteAfter]).toEqual([2000, 0]);
  });
});

describe("예측 (팀 3차 + CatBoost)", () => {
  it("메뉴 수준 = 최근 7일 × 0.5 + 4주 × 0.5", () => {
    // 4주 중 앞 21일 10개, 최근 7일 20개 → 4주 평균 12.5, 최근 20 → 16.25개 = 1625g
    const r = runEngine(snapshot(50000, { hist: history("2026-10-05", (i) => (i >= 21 ? 20 : 10)) }), DEFAULT_SETTINGS);
    expect(r.basis[0].level).toBeCloseTo(16.25);
  });
  it("최근 2일이 평소의 1.2배 이상이면 앞 3일만 올림", () => {
    const r = runEngine(snapshot(50000, { hist: history("2026-10-05", (i) => (i >= 26 ? 20 : 10)) }), DEFAULT_SETTINGS);
    // 요일 보정 때문에 2배가 아니라 약 1.68배로 잡힘(팀 엔진과 같은 계산)
    expect(r.ctx.surgeRatio).toBeGreaterThan(1.2);
    expect(r.ctx.surgeMult).toBeCloseTo(Math.min(1 + (r.ctx.surgeRatio - 1), 2));
    const flat = { ...r.ctx, dowIdx: { 월: 1, 화: 1, 수: 1, 목: 1, 금: 1, 토: 1, 일: 1 }, surgeMult: 1.5 };
    const q = forecastMenus([{ menuId: "M1", level: 10, sampleDays: 28 }], [], "S1", range("2026-10-05", "2026-10-09"), flat, DEFAULT_SETTINGS).map((f) => f.qty);
    expect(q).toEqual([15, 15, 15, 10]);
  });
  it("CatBoost 예측이 있는 날은 그 값, 없는 날·'규칙만'이면 규칙 기반", () => {
    const s = { ...snapshot(50000), mlForecast: [{ date: "2026-10-05", menuId: "M1", qty: 33 }], mlModel: "upto_0930" };
    const ml = runEngine(s, DEFAULT_SETTINGS).forecast;
    expect([ml[0].qty, ml[0].source, ml[1].qty, ml[1].source]).toEqual([33, "ml", 10, "rule"]);
    const rule = runEngine(s, { ...DEFAULT_SETTINGS, forecastModel: "rule" }).forecast;
    expect([rule[0].qty, rule[0].source]).toEqual([10, "rule"]);
  });
});

describe("사람이 읽는 수량 표시", () => {
  const lettuce: Ingredient = { ...ing, ingredient_name: "양상추", use_unit: "g", order_unit: "BOX", use_qty_per_order_unit: 5000 };
  const patty: Ingredient = { ...ing, use_unit: "개", order_unit: "박스", use_qty_per_order_unit: 168 };
  it("g 품목은 포장 단위가 주 표시, 원래 단위(kg)는 보조", () => {
    expect(describeQty(11500, lettuce)).toEqual({ main: "2.3BOX", sub: "11.5kg" });
    expect(describeQty(300, lettuce)).toEqual({ main: "0.1BOX 미만", sub: "300g" });
  });
  it("개 품목은 개수가 주 표시", () => {
    expect(describeQty(1141, patty)).toEqual({ main: "1,141개", sub: "6.8박스" });
  });
  it("며칠 분량 / 짧은 날짜", () => {
    expect(daysOf(1000, 400)).toBe(2.5);
    expect(daysOf(10, 0)).toBe(Infinity);
    expect(shortDate("2026-10-02")).toBe("10/2(금)");
  });
});

describe("지금 남은 양 (발주 판단 시점)", () => {
  it("전날 마감 재고 + 오늘 07시 입고분, 다음 입고는 내일 이후 것", () => {
    const s = snapshot(2500);
    s.openOrders = [
      { po_line_id: "A", ingredient_id: "I1", supplier_id: "SP", order_date: "2026-10-04", expected_date: "2026-10-05", order_qty: 1, use_qty: 1000, order_type: "정기" },
      { po_line_id: "B", ingredient_id: "I1", supplier_id: "SP", order_date: "2026-10-04", expected_date: "2026-10-07", order_qty: 2, use_qty: 2000, order_type: "정기" },
    ];
    const p = runEngine(s, DEFAULT_SETTINGS).plans[0];
    expect(p.startStock).toBe(2500);
    expect(p.onHand).toBe(3500);
    expect(p.nextIncoming?.date).toBe("2026-10-07");
  });
});
