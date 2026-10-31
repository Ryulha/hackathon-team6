import { addDays } from "./dates";

export type SimLot = { qty: number; lastUse: string; label: string };
export type SimArrival = { date: string; qty: number; lastUse: string; label: string };

export type SimDay = {
  date: string;
  /** 입고 전 기초재고 */
  opening: number;
  arrived: number;
  need: number;
  consumed: number;
  /** 재고 부족으로 충족 못한 소요량 */
  shortage: number;
  /** 영업 종료 시 사용기한(last_use_date) 도래로 폐기되는 양 */
  expired: number;
  closing: number;
};

/**
 * 일 단위 재고 시뮬레이션 (use_unit).
 * 순서: 입고 → 판매 소진(사용기한 빠른 묶음부터, FEFO) → 영업 종료 후 last_use_date 당일분 폐기.
 * 가정: 입고는 영업 시작 전 도착, 사용기한 당일까지 사용 가능.
 */
export function simulate(start: SimLot[], arrivals: SimArrival[], need: Map<string, number>, dates: string[]): SimDay[] {
  let lots = start.filter((l) => l.qty > 0).map((l) => ({ ...l }));
  const out: SimDay[] = [];
  for (const d of dates) {
    const opening = sum(lots);
    lots = lots.filter((l) => l.lastUse >= d); // 이미 지난 묶음 정리(데이터상 잔존분)
    const todays = arrivals.filter((a) => a.date === d && a.qty > 0);
    lots.push(...todays.map((a) => ({ qty: a.qty, lastUse: a.lastUse, label: a.label })));
    lots.sort((a, b) => a.lastUse.localeCompare(b.lastUse));
    const n = need.get(d) ?? 0;
    let left = n;
    for (const l of lots) {
      const take = Math.min(l.qty, left);
      l.qty -= take;
      left -= take;
      if (left <= 1e-9) break;
    }
    const expired = sum(lots.filter((l) => l.lastUse <= d));
    lots = lots.filter((l) => l.lastUse > d && l.qty > 1e-9);
    out.push({
      date: d, opening, arrived: sum(todays), need: n, consumed: n - Math.max(0, left),
      shortage: Math.max(0, left), expired, closing: sum(lots),
    });
  }
  return out;
}

const sum = (xs: { qty: number }[]) => xs.reduce((a, x) => a + x.qty, 0);

// ---------- 기준일 이전 재고 이어 계산 (사용자 판매 업로드·실사 입력 반영) ----------

export type LotState = { qty: number; lastUse: string; receiptDate: string; label: string };

/**
 * 실사 수량으로 재고 맞추기 (명세서 6절): 감소는 오래된 입고 묶음부터 차감, 증가는 가장 최근 입고 묶음에 더함.
 * 묶음이 하나도 없는데 수량이 있으면 실사일 입고분으로 간주(가정).
 */
export function applyCount(lots: LotState[], counted: number, date: string, shelfLifeDays: number): LotState[] {
  const out = lots.map((l) => ({ ...l })).sort((a, b) => a.receiptDate.localeCompare(b.receiptDate) || a.lastUse.localeCompare(b.lastUse));
  let diff = counted - out.reduce((a, l) => a + l.qty, 0);
  if (diff < 0) {
    for (const l of out) {
      const take = Math.min(l.qty, -diff);
      l.qty -= take;
      diff += take;
      if (diff >= -1e-9) break;
    }
  } else if (diff > 0) {
    const last = out.at(-1);
    if (last) last.qty += diff;
    else out.push({ qty: diff, receiptDate: date, lastUse: addDays(date, shelfLifeDays - 1), label: "실사 추가분" });
  }
  return out.filter((l) => l.qty > 1e-9);
}

/** 하루 시작 상태: 지난 묶음 정리 → 07시 입고 → 영업 전 실사 */
export function startOfDay(lots: LotState[], arrivals: SimArrival[], count: number | undefined, d: string, shelfLifeDays: number): LotState[] {
  let out = lots.filter((l) => l.lastUse >= d).map((l) => ({ ...l }));
  out.push(...arrivals.filter((a) => a.date === d && a.qty > 0).map((a) => ({ qty: a.qty, lastUse: a.lastUse, receiptDate: d, label: a.label })));
  if (count !== undefined) out = applyCount(out, count, d, shelfLifeDays);
  return out;
}

/**
 * dates 각 날을 처리해 마지막 날 영업 종료 후 묶음 상태를 돌려준다.
 * 하루 처리 순서는 명세서와 동일: 입고 → 실사 → 판매 소진(사용기한 빠른 순, 같으면 입고일 순) → 마감 후 사용기한 도래분 폐기.
 */
export function rollForward(start: LotState[], arrivals: SimArrival[], consumption: Map<string, number>,
  counts: Map<string, number>, dates: string[], shelfLifeDays: number): LotState[] {
  let lots = start.map((l) => ({ ...l }));
  for (const d of dates) {
    lots = startOfDay(lots, arrivals, counts.get(d), d, shelfLifeDays);
    lots.sort((a, b) => a.lastUse.localeCompare(b.lastUse) || a.receiptDate.localeCompare(b.receiptDate));
    let left = consumption.get(d) ?? 0;
    for (const l of lots) {
      const take = Math.min(l.qty, left);
      l.qty -= take;
      left -= take;
      if (left <= 1e-9) break;
    }
    lots = lots.filter((l) => l.lastUse > d && l.qty > 1e-9);
  }
  return lots;
}
