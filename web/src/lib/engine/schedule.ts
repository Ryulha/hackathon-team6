import type { Supplier } from "../types";
import { addDays, diffDays, parseWeekdays, weekdayOf } from "./dates";

export type OrderSlot = {
  orderDate: string;
  /** 입고 예정일 */
  arrivalDate: string;
  cutoff: string;
  /** 리드타임 도착일이 입고 요일이 아니라 다음 입고일로 밀린 일수 */
  shiftedDays: number;
};

/**
 * 공급사 발주 가능 시점 나열.
 * 가정(TODO 10/31 데이터로 검증):
 *  - lead_time_days 는 달력일 기준
 *  - 도착일이 delivery_days 가 아니면 다음 입고 가능 요일로 밀림
 *  - 기준일 당일은 현재 시각 < 마감 시각일 때만 발주 가능
 */
export function orderSlots(sup: Supplier, from: string, nowHHMM: string, count = 3, extraDelayDays = 0): OrderSlot[] {
  const orderDays = parseWeekdays(sup.order_days);
  const deliveryDays = parseWeekdays(sup.delivery_days);
  const out: OrderSlot[] = [];
  for (let i = 0; out.length < count && i < 60; i++) {
    const d = addDays(from, i);
    if (!orderDays.has(weekdayOf(d))) continue;
    if (i === 0 && nowHHMM >= (sup.order_cutoff || "23:59")) continue;
    const base = addDays(d, (sup.lead_time_days || 0) + extraDelayDays);
    let arrival = base;
    for (let k = 0; k < 7 && !deliveryDays.has(weekdayOf(arrival)); k++) arrival = addDays(arrival, 1);
    out.push({ orderDate: d, arrivalDate: arrival, cutoff: sup.order_cutoff, shiftedDays: diffDays(arrival, base) });
  }
  return out;
}
