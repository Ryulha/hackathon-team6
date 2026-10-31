// 손으로 만든 소형 픽스처(제공 데이터 아님)로 계산 규칙 검증
import { describe, expect, it } from "vitest";
import type { Ingredient, Snapshot, Supplier } from "../types";
import { addDays, parseList, parseWeekdays, shortDate, weekdayOf } from "./dates";
import { runEngine } from "./index";
import { simulate } from "./lots";
import { orderSlots } from "./schedule";
import { DEFAULT_SETTINGS } from "./settings";
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

function snapshot(stock: number): Snapshot {
  const asOf = "2026-10-05";
  const hist = Array.from({ length: 28 }, (_, i) => ({
    date: addDays(asOf, -28 + i), store_id: "S1", menu_id: "M1", demand_qty: 10, qty: 10,
    cancel_qty: 0, lost_qty: 0, sales_amount: 0, promo_flag: 0,
  }));
  return {
    meta: {
      asOf, storeId: "S1", dataStart: "2026-09-01", dataEnd: "2026-10-04", providedEnd: "2026-10-04", source: "json", fixture: true,
      overlay: { countedToday: [], estimated: false, uploadedThrough: null, masterEdits: [], priceEntries: 0, appOrders: 0 },
    },
    stores: [], menus: [{ menu_id: "M1", menu_name: "버거", category: "", is_set: 0, set_components: "", virtual_price: 5000 }],
    ingredients: [ing], bom: [{ menu_id: "M1", ingredient_id: "I1", qty_per_menu: 100, use_unit: "g" }],
    suppliers: [sup], prices: [{ ingredient_id: "I1", valid_from: "2026-01-01", unit_price: 20000 }],
    calendar: [], promotions: [], menuAvailability: [], demandHistory: hist, inventoryHistory: [],
    lots: stock ? [{ date: "2026-10-04", store_id: "S1", ingredient_id: "I1", lot_id: "L1", receipt_date: "2026-10-01", last_use_date: "2026-10-30", remaining_qty: stock, use_unit: "g" }] : [],
    openOrders: [], recentStockouts: [], recentWaste: [],
  };
}

describe("runEngine", () => {
  it("일 1000g 소요, 재고 2500g → 도착(10/8) 전 부족 → 긴급 알림", () => {
    const r = runEngine(snapshot(2500), DEFAULT_SETTINGS);
    const p = r.plans[0];
    expect(p.avgDailyNeed).toBeCloseTo(1000);
    expect(p.slot?.arrivalDate).toBe("2026-10-08");
    expect(p.nextSlot?.arrivalDate).toBe("2026-10-10");
    expect(p.shortageBeforeArrival).toBeCloseTo(500); // 10/5,6,7 소요 3000 - 2500
    expect(r.alerts.some((a) => a.kind === "shortage")).toBe(true);
    // 10/8~10/9 소요 2000 + 안전재고 1000 = 3000g → 3팩
    expect(p.recommendedUnits).toBe(3);
    expect(p.amount).toBe(60000);
  });
  it("수요 +50% 조정 시 추천 수량 증가 (조건 변경 재계산)", () => {
    const base = runEngine(snapshot(6000), DEFAULT_SETTINGS).plans[0].recommendedUnits;
    const up = runEngine(snapshot(6000), { ...DEFAULT_SETTINGS, demandAdjustPct: 50 }).plans[0].recommendedUnits;
    expect(up).toBeGreaterThan(base);
  });
  it("사용자 수정 수량 반영 + 최소 발주금액 판정", () => {
    const r = runEngine(snapshot(2500), DEFAULT_SETTINGS, { I1: 1 });
    expect(r.plans[0].finalUnits).toBe(1);
    expect(r.plans[0].overridden).toBe(true);
    expect(r.orders[0].belowMin).toBe(true);
    expect(r.orders[0].minGap).toBe(30000);
  });
  it("품목 최소 발주수량 적용", () => {
    // 재고 충분해 안전재고만 부족 → 1팩 → min 2팩
    const r = runEngine(snapshot(5500), DEFAULT_SETTINGS);
    expect(r.plans[0].recommendedUnits).toBe(2);
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
