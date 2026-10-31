import type { Ingredient, Snapshot, Supplier } from "../types";
import { addDays, diffDays, range } from "./dates";
import { simulate, type SimArrival, type SimDay, type SimLot } from "./lots";
import { orderSlots, type OrderSlot } from "./schedule";
import type { EngineSettings } from "./settings";
import { orderToUse, priceAt, toOrderUnits } from "./units";

export type IngredientPlan = {
  ingredient: Ingredient;
  supplier: Supplier | undefined;
  /** 이번 발주 / 다음 발주 기회 */
  slot: OrderSlot | undefined;
  nextSlot: OrderSlot | undefined;
  startStock: number;
  incoming: SimArrival[];
  avgDailyNeed: number;
  /** 이번 발주가 책임질 기간 [도착일, 다음 발주 도착일) 의 소요량 */
  windowNeed: number;
  safetyStock: number;
  /** 발주 없이 진행 시 */
  baseline: SimDay[];
  /** 추천/수정 수량 반영 시 (이후 발주는 없다고 가정한 시뮬레이션) */
  planned: SimDay[];
  recommendedUse: number;
  recommendedUnits: number;
  finalUnits: number;
  overridden: boolean;
  unitPrice: number;
  priceFrom: string;
  amount: number;
  /** 도착 전 발생하는 부족량 — 정기발주로 못 막음(긴급발주·이동 필요) */
  shortageBeforeArrival: number;
  firstShortageDate: string | undefined;
  /** 이번 발주 책임 기간 내 부족·폐기 */
  plannedShortage: number;
  plannedWaste: number;
  /** 현재고로 버틸 수 있는 일수 */
  coverDays: number;
  notes: string[];
};

export function planIngredient(
  snap: Snapshot, ing: Ingredient, need: Map<string, number>, s: EngineSettings, overrideUnits?: number,
): IngredientPlan {
  const asOf = snap.meta.asOf;
  const notes: string[] = [];
  const supplier = snap.suppliers.find((x) => x.supplier_id === ing.supplier_id);
  const [slot, nextSlot] = supplier ? orderSlots(supplier, asOf, s.nowTime, 2, s.leadTimeBufferDays) : [];
  if (!supplier) notes.push("공급사 정보 없음 → 발주 일정 계산 불가");

  // 시작 재고: 기준일 전날 영업 종료 후 lot 잔량
  let startLots: SimLot[] = snap.lots
    .filter((l) => l.ingredient_id === ing.ingredient_id)
    .map((l) => ({ qty: l.remaining_qty, lastUse: l.last_use_date, label: l.lot_id }));
  if (!startLots.length) {
    const last = snap.inventoryHistory.filter((r) => r.ingredient_id === ing.ingredient_id).at(-1);
    if (last && last.closing_qty > 0) {
      startLots = [{ qty: last.closing_qty, lastUse: addDays(asOf, ing.shelf_life_days - 1), label: "기말재고" }];
      notes.push("입고 묶음 정보 없음 → 기말재고 전체를 기준일 입고분으로 간주");
    }
  }
  const startStock = startLots.reduce((a, l) => a + l.qty, 0);

  // 입고 예정: 예정일이 지난 미입고분은 기준일 도착으로 간주(가정)
  const incoming: SimArrival[] = snap.openOrders
    .filter((o) => o.ingredient_id === ing.ingredient_id)
    .map((o) => {
      const date = o.expected_date < asOf ? asOf : o.expected_date;
      if (o.expected_date < asOf) notes.push(`${o.po_line_id} 예정일(${o.expected_date}) 경과·미입고 → 기준일 도착 가정`);
      return { date, qty: o.use_qty, lastUse: addDays(date, ing.shelf_life_days - 1), label: o.po_line_id };
    });

  const end = [addDays(asOf, s.horizonDays), nextSlot ? addDays(nextSlot.arrivalDate, 1) : asOf].sort().at(-1)!;
  const dates = range(asOf, end);
  const baseline = simulate(startLots, incoming, need, dates);

  const windowDates = slot && nextSlot ? range(slot.arrivalDate, nextSlot.arrivalDate) : [];
  const windowNeed = windowDates.reduce((a, d) => a + (need.get(d) ?? 0), 0);
  const horizonNeed = dates.reduce((a, d) => a + (need.get(d) ?? 0), 0);
  const avgDailyNeed = horizonNeed / Math.max(1, dates.length);
  const safetyStock = avgDailyNeed * s.safetyDays;

  let recommendedUse = 0;
  if (slot && nextSlot) {
    const inWindow = baseline.filter((d) => d.date >= slot.arrivalDate && d.date < nextSlot.arrivalDate);
    const shortInWindow = inWindow.reduce((a, d) => a + d.shortage, 0);
    const closingEnd = inWindow.at(-1)?.closing ?? 0;
    recommendedUse = shortInWindow + Math.max(0, safetyStock - closingEnd);
    // 새로 들어올 묶음의 사용기한이 다음 도착 전에 끝나면 그 이후분은 못 씀
    const newLastUse = addDays(slot.arrivalDate, ing.shelf_life_days - 1);
    if (newLastUse < addDays(nextSlot.arrivalDate, -1)) {
      const usable = baseline.filter((d) => d.date >= slot.arrivalDate && d.date <= newLastUse).reduce((a, d) => a + d.shortage, 0);
      if (usable < recommendedUse) {
        notes.push(`사용기한(${ing.shelf_life_days}일)이 다음 입고 전에 끝남 → ${newLastUse}까지 사용분만 추천`);
        recommendedUse = usable + safetyStock;
      }
    }
  }
  let recommendedUnits = toOrderUnits(recommendedUse, ing);
  if (recommendedUnits > 0 && recommendedUnits < ing.min_order_qty) {
    notes.push(`품목 최소 발주수량 ${ing.min_order_qty}${ing.order_unit} 적용`);
    recommendedUnits = ing.min_order_qty;
  }

  const overridden = overrideUnits !== undefined && overrideUnits !== recommendedUnits;
  const finalUnits = overrideUnits ?? recommendedUnits;
  const planned = slot && finalUnits > 0
    ? simulate(startLots, [...incoming, {
      date: slot.arrivalDate, qty: orderToUse(finalUnits, ing),
      lastUse: addDays(slot.arrivalDate, ing.shelf_life_days - 1), label: "신규 발주",
    }], need, dates)
    : baseline;

  const price = priceAt(snap.prices, ing.ingredient_id, slot?.orderDate ?? asOf);
  const unitPrice = price?.unit_price ?? 0;
  if (!price) notes.push("단가 이력 없음 → 금액 0 처리");

  const shortBefore = slot ? baseline.filter((d) => d.date < slot.arrivalDate) : baseline;
  const firstShort = baseline.find((d) => d.shortage > 0);
  let cover = 0;
  for (const d of baseline) { if (d.shortage > 0) break; cover++; }
  // 위험 지표는 이번 발주가 책임지는 기간(다음 발주 입고 전날)까지만 — 그 이후는 다음 발주가 담당
  const scope = nextSlot ? planned.filter((d) => d.date < nextSlot.arrivalDate) : planned;

  return {
    ingredient: ing, supplier, slot, nextSlot, startStock, incoming, avgDailyNeed, windowNeed, safetyStock,
    baseline, planned, recommendedUse, recommendedUnits, finalUnits, overridden,
    unitPrice, priceFrom: price?.valid_from ?? "-", amount: finalUnits * unitPrice,
    shortageBeforeArrival: shortBefore.reduce((a, d) => a + d.shortage, 0),
    firstShortageDate: firstShort?.date,
    plannedShortage: scope.reduce((a, d) => a + d.shortage, 0),
    plannedWaste: scope.reduce((a, d) => a + d.expired, 0),
    coverDays: cover === baseline.length ? Infinity : cover,
    notes,
  };
}

export type SupplierOrder = {
  supplier: Supplier;
  orderDate: string;
  cutoff: string;
  arrivalDate: string;
  lines: IngredientPlan[];
  amount: number;
  belowMin: boolean;
  /** 최소 발주금액까지 부족한 금액 */
  minGap: number;
  isToday: boolean;
  daysUntil: number;
};

/** 공급사·발주일 단위로 묶어 발주서 1건의 최소 발주금액 확인 */
export function groupBySupplier(plans: IngredientPlan[], asOf: string): SupplierOrder[] {
  const groups = new Map<string, SupplierOrder>();
  for (const p of plans) {
    if (!p.supplier || !p.slot || p.finalUnits <= 0) continue;
    const key = `${p.supplier.supplier_id}|${p.slot.orderDate}`;
    const g = groups.get(key) ?? groups.set(key, {
      supplier: p.supplier, orderDate: p.slot.orderDate, cutoff: p.slot.cutoff, arrivalDate: p.slot.arrivalDate,
      lines: [], amount: 0, belowMin: false, minGap: 0, isToday: p.slot.orderDate === asOf,
      daysUntil: diffDays(p.slot.orderDate, asOf),
    }).get(key)!;
    g.lines.push(p);
    g.amount += p.amount;
  }
  for (const g of groups.values()) {
    g.minGap = Math.max(0, (g.supplier.min_order_amount || 0) - g.amount);
    g.belowMin = g.minGap > 0;
  }
  return [...groups.values()].sort((a, b) => a.orderDate.localeCompare(b.orderDate));
}
