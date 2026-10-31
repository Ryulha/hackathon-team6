import type { ForecastSettings } from "./forecast";

export type EngineSettings = ForecastSettings & {
  /** 현재 시각(HH:MM) — 당일 발주 마감 판단 */
  nowTime: string;
  /** 안전재고 = 일평균 소요 × N일 */
  safetyDays: number;
  /** 공급사 입고 지연 대비 추가 일수 */
  leadTimeBufferDays: number;
  /** 사용기한 임박 알림 기준(일) */
  expiryWarnDays: number;
  /** 현재고가 N일치 소요를 넘으면 과잉 */
  overstockDays: number;
  /** 시뮬레이션·차트 표시 기간 */
  horizonDays: number;
};

export const DEFAULT_SETTINGS: EngineSettings = {
  lookbackWeeks: 4,
  demandAdjustPct: 0,
  applyPromo: true,
  nowTime: "09:00",
  safetyDays: 1,
  leadTimeBufferDays: 0,
  expiryWarnDays: 2,
  overstockDays: 14,
  horizonDays: 14,
};
