// 수요 예측 — 팀 발주 최적화 엔진(feature/order-optimization, engine.py forecast_menus·ingredient_sigma)을 TS로 옮김
import type { BomRow, CalendarRow, DailyDemand, Menu, MenuAvailability, Promotion } from "../types";
import { WEEKDAYS, addDays, parseList, range, weekdayOf, type Weekday } from "./dates";

export type ForecastSettings = {
  /** 메뉴 수준(최근 판매 평균)을 낼 기간. 요일 지수는 그 2배 기간으로 계산 */
  lookbackWeeks: number;
  /** 전체 수요 조정 (%), 예: 10 → ×1.1 */
  demandAdjustPct: number;
  /** 행사 진행 가정: 과거 행사 때의 메뉴별 판매 배수를 예측에 곱한다 */
  applyPromo: boolean;
  /** 다가오는 공휴일마다 점장이 고른 운영 방식 (없으면 auto) */
  holidayPlan?: Record<string, HolidayMode>;
};

/** auto: 이 매장 과거 공휴일 배수 적용 / weekday: 평일처럼 / closed: 영업 안 함(판매 0) */
export type HolidayMode = "auto" | "weekday" | "closed";

/** 공휴일 캘린더를 못 불러올 때 쓰는 데이터 기간(~9/30) 이후 공휴일 — 팀 엔진과 같은 가정 */
export const EXTRA_HOLIDAYS: Record<string, string> = { "2026-10-03": "개천절", "2026-10-05": "대체공휴일", "2026-10-09": "한글날" };

export function holidaySet(calendar: CalendarRow[], extra: string[] = Object.keys(EXTRA_HOLIDAYS)): Set<string> {
  return new Set([...calendar.filter((c) => Number(c.is_holiday) === 1).map((c) => c.date), ...extra]);
}

/** 판매 확정 기준 수요 = 품절 전 수요 − 취소 (품절이 없었다면 확정됐을 수량) */
export const netDemand = (r: Pick<DailyDemand, "demand_qty" | "cancel_qty">) => r.demand_qty - r.cancel_qty;

export type MenuForecastBasis = {
  menuId: string;
  /** 요일 효과를 뺀 하루 평균 판매(최근 lookback 기간, 취급일만) */
  level: number;
  sampleDays: number;
  /** 행사 진행 가정 시 곱하는 배수 (과거 행사 기간 / 직전 28일, 중앙값). 이력 없으면 없음 */
  promoMult?: number;
};

/** 예측에 쓴 매장 공통 계수 — 화면에서 근거로 보여준다 */
export type ForecastContext = {
  /** 매장 전체 판매 기준 요일 지수 (평균 = 1) */
  dowIdx: Record<Weekday, number>;
  /** 공휴일 판매 배수 (과거 공휴일 / 직전 5주 같은 요일 평일, 중앙값) */
  holMult: number;
  holidays: Set<string>;
};

export type MenuForecast = { date: string; menuId: string; qty: number; holiday: boolean; available: boolean };

export function isAvailable(av: MenuAvailability[], storeId: string, menuId: string, date: string): boolean {
  const rows = av.filter((r) => r.store_id === storeId && r.menu_id === menuId).sort((a, b) => a.start_date.localeCompare(b.start_date));
  if (!rows.length) return true;
  const hit = rows.find((r) => r.start_date <= date && date <= r.end_date)
    // 기간이 데이터 종료일까지만 있으면 마지막 상태가 이어진다고 가정
    ?? rows.filter((r) => r.start_date <= date).at(-1);
  return hit ? hit.status !== "미취급" : true;
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const median = (xs: number[]) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/**
 * 매장 공통 계수.
 * totals: 매장 일별 전체 판매(순수요) — 공휴일 배수는 기준일 전 전체 기간, 요일 지수는 최근 2×lookback 일(공휴일 제외).
 */
export function forecastContext(totals: Map<string, number>, asOf: string, holidays: Set<string>, s: ForecastSettings): ForecastContext {
  const L = s.lookbackWeeks * 7;
  const past = [...totals.entries()].filter(([d]) => d < asOf).sort(([a], [b]) => a.localeCompare(b));
  const byWd: Partial<Record<Weekday, number[]>> = {};
  for (const [d, y] of past) {
    if (d >= addDays(asOf, -2 * L) && !holidays.has(d)) (byWd[weekdayOf(d)] ??= []).push(y);
  }
  const wdMean = Object.fromEntries(Object.entries(byWd).map(([w, v]) => [w, mean(v!)])) as Partial<Record<Weekday, number>>;
  const overall = mean(Object.values(wdMean) as number[]);
  const dowIdx = Object.fromEntries(WEEKDAYS.map((w) => [w, wdMean[w] !== undefined && overall > 0 ? wdMean[w]! / overall : 1])) as Record<Weekday, number>;

  const ratios: number[] = [];
  for (const [h, y] of past) {
    if (!holidays.has(h)) continue;
    const same = past.filter(([d]) => d < h && d >= addDays(h, -35) && weekdayOf(d) === weekdayOf(h) && !holidays.has(d)).map(([, v]) => v);
    if (same.length && mean(same) > 0) ratios.push(y / mean(same));
  }
  return { dowIdx, holMult: ratios.length ? median(ratios) : 1, holidays };
}

/** 메뉴별 수준(요일 효과 제거 평균)과 행사 배수 */
export function menuBasis(
  history: DailyDemand[], menus: Menu[], av: MenuAvailability[], promos: Promotion[],
  storeId: string, asOf: string, ctx: ForecastContext, s: ForecastSettings,
): MenuForecastBasis[] {
  const y = new Map<string, number>();
  for (const h of history) if (h.store_id === storeId && h.date < asOf) y.set(`${h.date}|${h.menu_id}`, (y.get(`${h.date}|${h.menu_id}`) ?? 0) + netDemand(h));
  const days = range(addDays(asOf, -s.lookbackWeeks * 7), asOf);

  // 행사 배수: 이 매장 행사마다 대상 메뉴 합계의 (행사 기간 평균 / 직전 28일 평균), 메뉴별 중앙값
  const promoRatios = new Map<string, number[]>();
  for (const p of promos.filter((x) => x.store_id === storeId)) {
    const targets = parseList(p.target_menu);
    const sumOn = (d: string) => targets.reduce((a, m) => a + (y.get(`${d}|${m}`) ?? 0), 0);
    const seen = (d: string) => targets.some((m) => y.has(`${d}|${m}`));
    const during = range(p.start_date, addDays(p.end_date, 1)).filter((d) => d < asOf && seen(d)).map(sumOn);
    const before = range(addDays(p.start_date, -28), p.start_date).filter((d) => d < asOf && seen(d)).map(sumOn);
    if (during.length && before.length && mean(before) > 0) {
      for (const m of targets) (promoRatios.get(m) ?? promoRatios.set(m, []).get(m)!).push(mean(during) / mean(before));
    }
  }

  return menus.map((m) => {
    const avail = days.filter((d) => isAvailable(av, storeId, m.menu_id, d));
    const vals = avail.map((d) => (y.get(`${d}|${m.menu_id}`) ?? 0) / (ctx.dowIdx[weekdayOf(d)] || 1));
    const r = promoRatios.get(m.menu_id);
    return { menuId: m.menu_id, level: mean(vals), sampleDays: avail.length, promoMult: r ? median(r) : undefined };
  });
}

export function forecastMenus(
  basis: MenuForecastBasis[], av: MenuAvailability[], storeId: string, dates: string[], ctx: ForecastContext, s: ForecastSettings,
): MenuForecast[] {
  const adj = 1 + s.demandAdjustPct / 100;
  const out: MenuForecast[] = [];
  for (const b of basis) {
    for (const d of dates) {
      const available = isAvailable(av, storeId, b.menuId, d);
      const holiday = ctx.holidays.has(d);
      const mode = holiday ? s.holidayPlan?.[d] ?? "auto" : "weekday";
      let qty = available && mode !== "closed" ? b.level * ctx.dowIdx[weekdayOf(d)] * (mode === "auto" ? ctx.holMult : 1) : 0;
      if (s.applyPromo && b.promoMult) qty *= b.promoMult;
      out.push({ date: d, menuId: b.menuId, qty: qty * adj, holiday, available });
    }
  }
  return out;
}

/**
 * 식자재 일 사용량의 예측 오차 표준편차 (최근 56일, 요일 평균을 뺀 잔차). 안전재고 계산에 사용.
 * 판매 기록이 있는 날만 쓰고, 그날 쓰지 않은 식자재는 0으로 본다 (팀 엔진과 동일).
 */
export function ingredientSigma(history: DailyDemand[], bom: BomRow[], storeId: string, asOf: string): Map<string, number> {
  const from = addDays(asOf, -56);
  const use = new Map<string, Map<string, number>>(); // date → ing → qty
  const bomBy = new Map<string, BomRow[]>();
  for (const b of bom) (bomBy.get(b.menu_id) ?? bomBy.set(b.menu_id, []).get(b.menu_id)!).push(b);
  for (const h of history) {
    if (h.store_id !== storeId || h.date >= asOf || h.date < from) continue;
    const day = use.get(h.date) ?? use.set(h.date, new Map()).get(h.date)!;
    for (const b of bomBy.get(h.menu_id) ?? []) day.set(b.ingredient_id, (day.get(b.ingredient_id) ?? 0) + netDemand(h) * b.qty_per_menu);
  }
  const dates = [...use.keys()];
  const ings = new Set(bom.map((b) => b.ingredient_id));
  const out = new Map<string, number>();
  for (const ing of ings) {
    const series = dates.map((d) => ({ d, v: use.get(d)!.get(ing) ?? 0 }));
    const wdMean = new Map<string, number>();
    for (const w of WEEKDAYS) wdMean.set(w, mean(series.filter((x) => weekdayOf(x.d) === w).map((x) => x.v)));
    const resid = series.map((x) => x.v - (wdMean.get(weekdayOf(x.d)) ?? 0));
    const m = mean(resid);
    out.set(ing, resid.length > 1 ? Math.sqrt(resid.reduce((a, r) => a + (r - m) ** 2, 0) / (resid.length - 1)) : 0);
  }
  return out;
}

/** 매장 일별 전체 판매(순수요) */
export function dailyTotals(rows: DailyDemand[], storeId: string): Map<string, number> {
  const t = new Map<string, number>();
  for (const r of rows) if (r.store_id === storeId) t.set(r.date, (t.get(r.date) ?? 0) + netDemand(r));
  return t;
}

