// 사용자 입력 반영 규칙 검증 — 손으로 만든 소형 픽스처(제공 데이터 아님)
import { describe, expect, it } from "vitest";
import { applyCount, rollForward } from "./engine/lots";
import {
  applyMasterEdits, draftArrivals, mergePrices, normalizeWeekdays, parseCsv, projectStartStock,
  validateCount, validateMasterEdit, validateSalesCsv,
} from "./overlays";
import type { Ingredient, Menu, Store, Supplier } from "./types";

const ing: Ingredient = {
  ingredient_id: "I1", ingredient_name: "패티", supplier_id: "SP", use_unit: "개", order_unit: "박스",
  use_qty_per_order_unit: 10, storage: "냉동", shelf_life_days: 5, min_order_qty: 1,
};
const sup: Supplier = {
  supplier_id: "SP", supplier_name: "공급", order_days: "월,수", order_cutoff: "16:00",
  lead_time_days: 1, delivery_days: "화,목", min_order_amount: 0, note: "",
};
const stores = [{ store_id: "S1" }] as Store[];
const menus = [{ menu_id: "M1" }] as Menu[];

describe("기준정보 수정 검증", () => {
  it("요일 정규화: 순서·표기 통일, 잘못된 글자 거부", () => {
    expect(normalizeWeekdays("금, 월 수")).toEqual({ ok: true, value: "월,수,금" });
    expect(normalizeWeekdays("일요일,토요일")).toEqual({ ok: true, value: "일,토" });
    expect(normalizeWeekdays("월,x").ok).toBe(false);
    expect(normalizeWeekdays(" ").ok).toBe(false);
  });
  it("허용 항목만, 범위·형식 검사", () => {
    expect(validateMasterEdit({ entity: "supplier", entity_id: "SP", field: "order_cutoff", value: "17:30" }, [sup], [ing]).ok).toBe(true);
    expect(validateMasterEdit({ entity: "supplier", entity_id: "SP", field: "order_cutoff", value: "25:00" }, [sup], [ing]).ok).toBe(false);
    expect(validateMasterEdit({ entity: "supplier", entity_id: "SP", field: "supplier_name", value: "x" }, [sup], [ing]).ok).toBe(false);
    expect(validateMasterEdit({ entity: "ingredient", entity_id: "NOPE", field: "min_order_qty", value: "1" }, [sup], [ing]).ok).toBe(false);
    expect(validateMasterEdit({ entity: "ingredient", entity_id: "I1", field: "min_order_qty", value: "1.5" }, [sup], [ing]).ok).toBe(false);
  });
  it("같은 항목은 최신 수정만, 숫자 항목은 숫자로", () => {
    const r = applyMasterEdits([sup], [ing], [
      { entity: "ingredient", entity_id: "I1", field: "shelf_life_days", value: "3" },
      { entity: "ingredient", entity_id: "I1", field: "shelf_life_days", value: "7" },
      { entity: "supplier", entity_id: "SP", field: "order_days", value: "월,화" },
    ]);
    expect(r.ingredients[0].shelf_life_days).toBe(7);
    expect(r.suppliers[0].order_days).toBe("월,화");
    expect(r.applied).toHaveLength(2);
    expect(ing.shelf_life_days).toBe(5); // 원본 불변
  });
  it("단가: 같은 시작일이면 사용자 입력 우선", () => {
    const p = mergePrices([{ ingredient_id: "I1", valid_from: "2026-01-01", unit_price: 100 }],
      [{ ingredient_id: "I1", valid_from: "2026-01-01", unit_price: 150 }, { ingredient_id: "I1", valid_from: "2026-10-01", unit_price: 200 }]);
    expect(p).toHaveLength(2);
    expect(p.find((x) => x.valid_from === "2026-01-01")?.unit_price).toBe(150);
  });
});

describe("실사 입력", () => {
  it("제공 기간·미래 날짜·음수 거부", () => {
    expect(validateCount({ date: "2026-09-30", ingredient_id: "I1", counted_qty: 5 }, [ing], "2026-09-30", "2026-10-01").ok).toBe(false);
    expect(validateCount({ date: "2026-10-02", ingredient_id: "I1", counted_qty: 5 }, [ing], "2026-09-30", "2026-10-01").ok).toBe(false);
    expect(validateCount({ date: "2026-10-01", ingredient_id: "I1", counted_qty: -1 }, [ing], "2026-09-30", "2026-10-01").ok).toBe(false);
    expect(validateCount({ date: "2026-02-30", ingredient_id: "I1", counted_qty: 1 }, [ing], "2026-01-01", "2026-12-31").ok).toBe(false);
    expect(validateCount({ date: "2026-10-01", ingredient_id: "I1", counted_qty: 0 }, [ing], "2026-09-30", "2026-10-01").ok).toBe(true);
  });
  it("감소는 오래된 묶음부터, 증가는 최근 묶음에 (명세서 6절)", () => {
    const lots = [
      { qty: 5, lastUse: "2026-10-05", receiptDate: "2026-09-28", label: "새" },
      { qty: 3, lastUse: "2026-10-02", receiptDate: "2026-09-25", label: "옛" },
    ];
    const down = applyCount(lots, 6, "2026-10-01", 5);
    expect(down).toEqual([{ qty: 1, lastUse: "2026-10-02", receiptDate: "2026-09-25", label: "옛" }, { qty: 5, lastUse: "2026-10-05", receiptDate: "2026-09-28", label: "새" }]);
    expect(applyCount(lots, 2, "2026-10-01", 5)).toEqual([{ qty: 2, lastUse: "2026-10-05", receiptDate: "2026-09-28", label: "새" }]);
    const up = applyCount(lots, 10, "2026-10-01", 5);
    expect(up.find((l) => l.label === "새")?.qty).toBe(7);
    expect(applyCount([], 4, "2026-10-01", 5)).toEqual([{ qty: 4, lastUse: "2026-10-05", receiptDate: "2026-10-01", label: "실사 추가분" }]);
  });
  it("이어 계산: 입고 → 실사 → 소진(FEFO) → 기한 도래분 폐기", () => {
    const end = rollForward(
      [{ qty: 4, lastUse: "2026-10-01", receiptDate: "2026-09-27", label: "A" }],
      [{ date: "2026-10-01", qty: 10, lastUse: "2026-10-05", label: "B" }],
      new Map([["2026-10-01", 3], ["2026-10-02", 2]]), new Map(), ["2026-10-01", "2026-10-02"], 5,
    );
    // 10/1: A4+B10, 소진 3 → A1 B10, A 기한 도래 폐기 → B10 / 10/2: B8
    expect(end).toEqual([{ qty: 8, lastUse: "2026-10-05", receiptDate: "2026-10-01", label: "B" }]);
  });
});

describe("기준일 시작 재고 계산", () => {
  const base = {
    ingredients: [ing], bom: [{ menu_id: "M1", ingredient_id: "I1", qty_per_menu: 2, use_unit: "개" }],
    baseLots: [{ date: "2026-09-30", store_id: "S1", ingredient_id: "I1", lot_id: "L1", receipt_date: "2026-09-29", last_use_date: "2026-10-03", remaining_qty: 20, use_unit: "개" }],
    open: [{ po_line_id: "P1", ingredient_id: "I1", supplier_id: "SP", order_date: "2026-09-30", expected_date: "2026-10-01", order_qty: 1, use_qty: 10, order_type: "정기" }],
    counts: [], storeId: "S1", baseDay: "2026-09-30",
  };
  it("제공 데이터 다음 날: 그대로 (입고 예정 유지)", () => {
    const r = projectStartStock({ ...base, uploaded: [], asOf: "2026-10-01" });
    expect(r.lots.map((l) => l.remaining_qty)).toEqual([20]);
    expect(r.openOrders).toHaveLength(1);
  });
  it("업로드 판매로 이어 계산: 판매 확정(qty−cancel)×BOM 소진, 도착한 입고 예정은 재고로", () => {
    const uploaded = [{ date: "2026-10-01", store_id: "S1", menu_id: "M1", demand_qty: 6, qty: 5, cancel_qty: 1, lost_qty: 1, sales_amount: 0, promo_flag: 0 }];
    const r = projectStartStock({ ...base, uploaded, asOf: "2026-10-02" });
    // 20 + 10 − (5−1)×2 = 22
    expect(r.lots.reduce((a, l) => a + l.remaining_qty, 0)).toBe(22);
    expect(r.openOrders).toHaveLength(0);
  });
  it("기준일 실사: 07시 입고 포함 후 실사값으로, 그날 입고 예정은 중복 제외", () => {
    const r = projectStartStock({ ...base, uploaded: [], counts: [{ date: "2026-10-01", ingredient_id: "I1", counted_qty: 25 }], asOf: "2026-10-01" });
    expect(r.lots.reduce((a, l) => a + l.remaining_qty, 0)).toBe(25);
    expect(r.openOrders).toHaveLength(0);
    expect(r.countedToday).toEqual(["I1"]);
  });
  it("다른 매장 업로드는 무시", () => {
    const uploaded = [{ date: "2026-10-01", store_id: "S2", menu_id: "M1", demand_qty: 9, qty: 9, cancel_qty: 0, lost_qty: 0, sales_amount: 0, promo_flag: 0 }];
    const r = projectStartStock({ ...base, uploaded, asOf: "2026-10-02" });
    expect(r.lots.reduce((a, l) => a + l.remaining_qty, 0)).toBe(30);
  });
});

describe("확정 발주 → 입고 예정", () => {
  const line = { ingredient_id: "I1", supplier_id: "SP", order_date: "2026-10-01", arrival_date: "2026-10-02", final_units: 2, use_qty: 20 };
  it("같은 기준일은 마지막 확정만, 제공 기간·당일 확정은 제외", () => {
    const r = draftArrivals([
      { id: 1, as_of: "2026-10-01", lines: [line] },
      { id: 2, as_of: "2026-10-01", lines: [{ ...line, final_units: 3, use_qty: 30 }] },
      { id: 3, as_of: "2026-09-15", lines: [line] },
      { id: 4, as_of: "2026-10-02", lines: [line] },
    ], "2026-09-30", "2026-10-02");
    expect(r).toHaveLength(1);
    expect(r[0].use_qty).toBe(30);
  });
});

describe("판매 CSV 업로드 검증", () => {
  const H = "date,hour,store_id,menu_id,channel,demand_qty,qty,cancel_qty,lost_qty,sales_amount,promo_flag";
  const ends = { S1: "2026-09-30" };
  it("정상: 시간대·채널 합산, BOM·따옴표 처리", () => {
    const csv = `﻿${H}\r\n2026-10-01,10,S1,M1,매장,3,3,1,0,"2,000",0\n2026-10-01,11,S1,M1,배달,2,1,0,1,1000,0\n2026-10-02,10,S1,M1,매장,1,1,0,0,1000,0\n`;
    expect(parseCsv(csv)[1][9]).toBe("2,000");
    const r = validateSalesCsv(csv.replace('"2,000"', "2000"), stores, menus, ends);
    expect(r.ok).toBe(true);
    expect(r.daily.find((d) => d.date === "2026-10-01")).toMatchObject({ demand_qty: 5, qty: 4, cancel_qty: 1, lost_qty: 1 });
    expect([r.dateFrom, r.dateTo, r.storeIds]).toEqual(["2026-10-01", "2026-10-02", ["S1"]]);
  });
  it("컬럼 누락·없는 ID·수량 관계·중복 거부", () => {
    expect(validateSalesCsv("date,hour\n2026-10-01,10", stores, menus, ends).ok).toBe(false);
    const bad = validateSalesCsv(`${H}\n2026-10-01,10,S9,M1,매장,1,1,0,0,0,0\n2026-10-01,10,S1,M1,매장,3,2,0,0,0,0\n2026-10-01,25,S1,M1,매장,1,1,0,0,0,0`, stores, menus, ends);
    expect(bad.ok).toBe(false);
    expect(bad.errorCount).toBe(3);
    const dup = validateSalesCsv(`${H}\n2026-10-01,10,S1,M1,매장,1,1,0,0,0,0\n2026-10-01,10,S1,M1,매장,1,1,0,0,0,0`, stores, menus, ends);
    expect(dup.errors.some((e) => e.includes("중복"))).toBe(true);
  });
  it("기간: 마지막 판매일 다음 날부터, 빈 날 없이", () => {
    const overlap = validateSalesCsv(`${H}\n2026-09-30,10,S1,M1,매장,1,1,0,0,0,0`, stores, menus, ends);
    expect(overlap.errors[0]).toContain("2026-10-01부터");
    const gap = validateSalesCsv(`${H}\n2026-10-01,10,S1,M1,매장,1,1,0,0,0,0\n2026-10-03,10,S1,M1,매장,1,1,0,0,0,0`, stores, menus, ends);
    expect(gap.errors[0]).toContain("2026-10-02");
  });
});
