import type { DailyDemand, Menu, MenuAvailability, Promotion } from "../types";
import { addDays, parseList, range, weekdayOf, type Weekday } from "./dates";

export type ForecastSettings = {
  lookbackWeeks: number;
  /** 전체 수요 조정 (%), 예: 10 → ×1.1 */
  demandAdjustPct: number;
  applyPromo: boolean;
};

export type MenuForecastBasis = {
  menuId: string;
  /** 요일별 평균 수요(프로모션·미취급일 제외) */
  weekdayAvg: Partial<Record<Weekday, number>>;
  overallAvg: number;
  sampleDays: number;
  /** 과거 프로모션일 / 비프로모션 동요일 수요 비율 (데이터 없으면 1) */
  promoUplift: number;
};

export type MenuForecast = { date: string; menuId: string; qty: number; promo: boolean; available: boolean };

export function isAvailable(av: MenuAvailability[], storeId: string, menuId: string, date: string): boolean {
  const rows = av.filter((r) => r.store_id === storeId && r.menu_id === menuId).sort((a, b) => a.start_date.localeCompare(b.start_date));
  if (!rows.length) return true;
  const hit = rows.find((r) => r.start_date <= date && date <= r.end_date)
    // 기간이 데이터 종료일까지만 있으면 마지막 상태가 이어진다고 가정
    ?? rows.filter((r) => r.start_date <= date).at(-1);
  return hit ? hit.status !== "미취급" : true;
}

export function promoOn(promos: Promotion[], storeId: string, menuId: string, date: string): boolean {
  return promos.some((p) => p.store_id === storeId && p.start_date <= date && date <= p.end_date && parseList(p.target_menu).includes(menuId));
}

/**
 * 메뉴별 기준 수요 산출: 최근 N주 동요일 평균 (demand_qty = 품절 제한 전 수요).
 * 판매 기록이 없는 날은 취급 중이면 0으로 채운다.
 */
export function menuBasis(
  history: DailyDemand[], menus: Menu[], av: MenuAvailability[], promos: Promotion[],
  storeId: string, asOf: string, s: ForecastSettings,
): MenuForecastBasis[] {
  const days = range(addDays(asOf, -7 * s.lookbackWeeks), asOf);
  const byKey = new Map<string, number>();
  for (const h of history) if (h.store_id === storeId) byKey.set(`${h.date}|${h.menu_id}`, h.demand_qty);

  return menus.map((m) => {
    const normal: Record<string, number[]> = {};
    const promoRatio: number[] = [];
    for (const d of days) {
      if (!isAvailable(av, storeId, m.menu_id, d)) continue;
      const v = byKey.get(`${d}|${m.menu_id}`) ?? 0;
      if (promoOn(promos, storeId, m.menu_id, d)) { promoRatio.push(v); continue; }
      (normal[weekdayOf(d)] ??= []).push(v);
    }
    const weekdayAvg: Partial<Record<Weekday, number>> = {};
    const all: number[] = [];
    for (const [wd, vs] of Object.entries(normal)) { weekdayAvg[wd as Weekday] = mean(vs); all.push(...vs); }
    const overallAvg = mean(all);
    const promoUplift = promoRatio.length && overallAvg > 0 ? Math.max(1, mean(promoRatio) / overallAvg) : 1;
    return { menuId: m.menu_id, weekdayAvg, overallAvg, sampleDays: all.length, promoUplift };
  });
}

export function forecastMenus(
  basis: MenuForecastBasis[], av: MenuAvailability[], promos: Promotion[],
  storeId: string, dates: string[], s: ForecastSettings,
): MenuForecast[] {
  const adj = 1 + s.demandAdjustPct / 100;
  const out: MenuForecast[] = [];
  for (const b of basis) {
    for (const d of dates) {
      const available = isAvailable(av, storeId, b.menuId, d);
      const promo = s.applyPromo && promoOn(promos, storeId, b.menuId, d);
      const base = b.weekdayAvg[weekdayOf(d)] ?? b.overallAvg;
      out.push({ date: d, menuId: b.menuId, available, promo, qty: available ? base * adj * (promo ? b.promoUplift : 1) : 0 });
    }
  }
  return out;
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
