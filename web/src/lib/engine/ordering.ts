// 발주 추천 — 발주 일정·FEFO 시뮬레이션은 기존 구현, 수량 결정은 팀 발주 최적화 엔진
// (feature/order-optimization engine.py recommend·min_amount_fix) 규칙을 옮김
import type { Ingredient, Snapshot, Supplier } from "../types";
import { addDays, diffDays, range } from "./dates";
import { simulate, type SimArrival, type SimDay, type SimLot } from "./lots";
import { orderSlots, type OrderSlot } from "./schedule";
import { OPT, SERVICE_LEVELS, type EngineSettings } from "./settings";
import { orderToUse, priceAt } from "./units";

/** 품목별 위험 신호 (엔진 바깥에서 계산해 넘김) */
export type ItemSignals = {
  /** 식자재 하루 사용량의 예측 오차 표준편차 (use_unit) */
  sigma: number;
  /** 최근 28일(기준일 전날까지) 품절 일수 */
  stockouts28: number;
};

export type IngredientPlan = {
  ingredient: Ingredient;
  supplier: Supplier | undefined;
  /** 이번 발주 / 다음 발주 기회 */
  slot: OrderSlot | undefined;
  nextSlot: OrderSlot | undefined;
  /** 전날 영업 종료 후 재고 (오늘 입고 전) */
  startStock: number;
  /** 지금 손에 있는 양 = 전날 마감 재고 + 오늘 07시 입고분. 발주 판단 시점(입고·실사 후)의 재고 */
  onHand: number;
  incoming: SimArrival[];
  /** 오늘 이후(내일부터) 도착할 첫 입고 */
  nextIncoming: SimArrival | undefined;
  /** 앞으로 7일 평균 하루 사용량 예측 */
  avgDailyNeed: number;
  /** 이번 발주가 책임질 기간 [도착일, 다음 발주 도착일) 의 소요량 */
  windowNeed: number;
  /** 이번 발주가 책임지는 일수 */
  windowDays: number;
  /** 안전재고 = z × σ × √(책임 일수 + 1) */
  safetyStock: number;
  sigma: number;
  zBase: number;
  zUsed: number;
  /** z 를 기본값에서 바꾼 이유 */
  zReasons: string[];
  stockouts28: number;
  /** 발주 없이 진행 시 */
  baseline: SimDay[];
  /** 추천/수정 수량 반영 시 (이후 발주는 없다고 가정한 시뮬레이션) */
  planned: SimDay[];
  recommendedUse: number;
  /** 폐기 고려 감량 전 추천 수량 */
  recBeforeCut: number;
  recommendedUnits: number;
  /** 이번 발주분 때문에 늘어나는 예상 폐기 (감량 전 → 후, use_unit) */
  wasteBefore: number;
  wasteAfter: number;
  finalUnits: number;
  overridden: boolean;
  unitPrice: number;
  priceFrom: string;
  amount: number;
  /** 도착 전 발생하는 부족량 — 정기발주로 못 막음(긴급발주·이동 필요) */
  shortageBeforeArrival: number;
  /** 발주 안 할 때 이번 책임 기간의 부족량 */
  shortageInWindow: number;
  firstShortageDate: string | undefined;
  /** 이번 발주 책임 기간 내 부족·폐기 */
  plannedShortage: number;
  plannedWaste: number;
  /** 현재고로 버틸 수 있는 일수 */
  coverDays: number;
  notes: string[];
};

const sum = (xs: SimDay[], k: "shortage" | "expired") => xs.reduce((a, d) => a + d[k], 0);

export function planIngredient(
  snap: Snapshot, ing: Ingredient, need: Map<string, number>, s: EngineSettings, sig: ItemSignals, overrideUnits?: number,
): IngredientPlan {
  const asOf = snap.meta.asOf;
  const notes: string[] = [];
  const pack = ing.use_qty_per_order_unit;
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
  const withOrder = (units: number) => (slot && units > 0
    ? simulate(startLots, [...incoming, { date: slot.arrivalDate, qty: orderToUse(units, ing), lastUse: addDays(slot.arrivalDate, ing.shelf_life_days - 1), label: "신규 발주" }], need, dates)
    : baseline);
  const inWindow = (sim: SimDay[]) => (slot && nextSlot ? sim.filter((d) => d.date >= slot.arrivalDate && d.date < nextSlot.arrivalDate) : []);

  const avgDailyNeed = range(asOf, addDays(asOf, 7)).reduce((a, d) => a + (need.get(d) ?? 0), 0) / 7;
  const windowDays = slot && nextSlot ? Math.max(diffDays(nextSlot.arrivalDate, slot.arrivalDate), 1) : 1;
  const windowNeed = inWindow(baseline).reduce((a, d) => a + d.need, 0);

  // 안전재고 z: 기본(서비스 수준) → 장기 품목은 최소 z_long → 최근 품절이면 +z_boost
  const zBase = SERVICE_LEVELS[s.serviceLevel].z;
  const zReasons: string[] = [];
  let zUsed: number = zBase;
  if (ing.shelf_life_days >= OPT.longShelf && zUsed < OPT.zLong) {
    zUsed = OPT.zLong;
    zReasons.push(`사용기한 ${ing.shelf_life_days}일인 장기 품목이라 남아도 버릴 위험이 낮아 넉넉히`);
  }
  if (sig.stockouts28 > 0) {
    zUsed = Math.min(zUsed + OPT.zBoost, OPT.zMax);
    zReasons.push(`최근 ${OPT.stockoutWindow}일 동안 ${sig.stockouts28}번 품절돼서 더 넉넉히`);
  }
  const safetyStock = zUsed * sig.sigma * Math.sqrt(windowDays + 1);

  // 필요량 = 이번 책임 기간 부족분 + (안전재고 − 다음 입고 전날 남을 양)
  const win0 = inWindow(baseline);
  const shortageInWindow = sum(win0, "shortage");
  const leftAtNext = win0.at(-1)?.closing ?? 0;
  const recommendedUse = slot && nextSlot ? shortageInWindow + Math.max(0, safetyStock - leftAtNext) : 0;

  let recBeforeCut = 0;
  if (recommendedUse > 1e-6 && avgDailyNeed > 0) {
    recBeforeCut = Math.max(Math.ceil(recommendedUse / pack - 1e-9), ing.min_order_qty);
    if (Math.ceil(recommendedUse / pack - 1e-9) < ing.min_order_qty) notes.push(`품목 최소 발주수량 ${ing.min_order_qty}${ing.order_unit} 적용`);
  }

  // 폐기 고려 감량: 1단위 줄여도 예상 품절이 그대로이고, 줄인 1단위의 절반 이상이 기한 안에 못 쓰여 버려질 전망이면 감량
  let recommendedUnits = recBeforeCut;
  let wasteBefore = 0;
  let wasteAfter = 0;
  if (recBeforeCut > 0) {
    const evalU = (u: number) => { const sim = withOrder(u); return { lost: sum(inWindow(sim), "shortage"), waste: sum(sim, "expired") }; };
    const w0 = evalU(0).waste;
    const atRec = evalU(recBeforeCut);
    let u = recBeforeCut;
    let wu = atRec.waste;
    while (u > 0) {
      const nu = u - 1;
      if (nu > 0 && nu < ing.min_order_qty) break;
      const n = evalU(nu);
      if (n.lost > atRec.lost + 1e-6 || wu - n.waste < OPT.wasteCutRatio * pack) break;
      u = nu;
      wu = n.waste;
    }
    recommendedUnits = u;
    wasteBefore = Math.max(0, atRec.waste - w0);
    wasteAfter = Math.max(0, wu - w0);
    if (u < recBeforeCut) {
      notes.push(`${recBeforeCut}→${u}${ing.order_unit}로 줄임: 줄여도 품절 위험은 그대로이고, 이번 발주분 중 버릴 예상량이 줄어듦`);
    }
  }

  const overridden = overrideUnits !== undefined && overrideUnits !== recommendedUnits;
  const finalUnits = overrideUnits ?? recommendedUnits;
  const planned = withOrder(finalUnits);

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
    ingredient: ing, supplier, slot, nextSlot, startStock, incoming, avgDailyNeed, windowNeed, windowDays,
    safetyStock, sigma: sig.sigma, zBase, zUsed, zReasons, stockouts28: sig.stockouts28,
    onHand: startStock + incoming.filter((a) => a.date === asOf).reduce((a, x) => a + x.qty, 0),
    nextIncoming: incoming.filter((a) => a.date > asOf).sort((a, b) => a.date.localeCompare(b.date))[0],
    baseline, planned, recommendedUse, recBeforeCut, recommendedUnits, wasteBefore, wasteAfter, finalUnits, overridden,
    unitPrice, priceFrom: price?.valid_from ?? "-", amount: finalUnits * unitPrice,
    shortageBeforeArrival: sum(shortBefore, "shortage"), shortageInWindow,
    firstShortageDate: firstShort?.date,
    plannedShortage: sum(scope, "shortage"),
    plannedWaste: sum(scope, "expired"),
    coverDays: cover === baseline.length ? Infinity : cover,
    notes,
  };
}

/** 최소 발주금액 미달 대안 (팀 엔진 min_amount_fix) */
export type MinAmountFix = {
  /** 급한 품목(입고 전 품절·이번 기간 품절 예상)이 있는지 — 없으면 다음 발주일로 미루기 권장 */
  urgent: boolean;
  /** 보충안: 오래 가는 품목(사용기한 30일 이상)을 하루 사용량(포장 기준) 큰 순으로 1단위씩, 2주 사용량까지만 */
  adds: { plan: IngredientPlan; add: number }[];
  addAmount: number;
  /** 보충안으로 최소금액을 채울 수 있는지 */
  covers: boolean;
};

export function minAmountFix(lines: IngredientPlan[], supplierPlans: IngredientPlan[], gap: number): MinAmountFix {
  const urgent = lines.some((p) => p.shortageBeforeArrival > 1e-6 || p.shortageInWindow > 1e-6);
  const cand = supplierPlans
    .filter((p) => p.ingredient.shelf_life_days >= 30 && p.avgDailyNeed > 0 && p.unitPrice > 0)
    .sort((a, b) => b.avgDailyNeed / b.ingredient.use_qty_per_order_unit - a.avgDailyNeed / a.ingredient.use_qty_per_order_unit);
  const add = new Map(cand.map((p) => [p, 0]));
  const canAdd = (p: IngredientPlan) => (p.finalUnits + add.get(p)! + 1) * p.ingredient.use_qty_per_order_unit <= p.avgDailyNeed * 14;
  let left = gap;
  for (let guard = 0; left > 0 && guard < 200 && cand.some(canAdd); guard++) {
    for (const p of cand) {
      if (!canAdd(p)) continue;
      add.set(p, add.get(p)! + 1);
      left -= p.unitPrice;
      if (left <= 0) break;
    }
  }
  const adds = cand.filter((p) => add.get(p)! > 0).map((plan) => ({ plan, add: add.get(plan)! }));
  const addAmount = adds.reduce((a, x) => a + x.add * x.plan.unitPrice, 0);
  return { urgent, adds, addAmount, covers: addAmount >= gap };
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
  /** 미달일 때 대안 */
  fix?: MinAmountFix;
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
    if (g.belowMin) {
      const same = plans.filter((p) => p.supplier?.supplier_id === g.supplier.supplier_id && p.slot?.orderDate === g.orderDate);
      g.fix = minAmountFix(g.lines, same, g.minGap);
    }
  }
  return [...groups.values()].sort((a, b) => a.orderDate.localeCompare(b.orderDate));
}
