import type { ForecastSettings } from "./forecast";

/**
 * 품절 위험 허용 수준 → 안전재고 z. 팀 발주 최적화 엔진 3차(4fb4fc2)와 같은 값.
 * 팀 백테스트(3~8월 튜닝, 9월 검증)에서 폐기+품절 총비용이 가장 낮았던 값 — 이론상 서비스 수준(%)과는 다름.
 */
export const SERVICE_LEVELS = {
  loose: { label: "넉넉하게", z: 3.5, hint: "품절을 최대한 피함 (재고·폐기는 늘어남)" },
  normal: { label: "보통", z: 3.0, hint: "팀 백테스트에서 폐기+품절 비용이 가장 적었던 수준" },
  tight: { label: "타이트하게", z: 2.6, hint: "재고를 줄임 (품절 위험 늘어남)" },
} as const;
export type ServiceLevel = keyof typeof SERVICE_LEVELS;

/** 팀 엔진 최적화 설정 (3차 백테스트로 정한 값) */
export const OPT = {
  /** 품절 이력 조회 기간(일), 기준일 전날까지 */
  stockoutWindow: 28,
  /** 최근 품절 품목의 z 상향폭 — 튜닝 결과 효과 없어 0 (품절 이력은 근거 표시용) */
  zBoost: 0,
  zMax: 4.0,
  /** 마지막 1발주단위 중 이 비율 이상이 폐기 예상이면 감량 */
  wasteCutRatio: 0.5,
  /** 사용기한이 이 일수 이상이면 '장기 품목' — 남아도 버릴 위험이 낮아 넉넉히 ('타이트하게'에서만 작동) */
  longShelf: 14,
  zLong: 2.33,
  /** 메뉴 수준 = 최근 7일 수준 × w + 최근 기간 수준 × (1 − w) */
  recentDays: 7,
  recentWeight: 0.5,
  /** 수요 급증 징후: 최근 2일(요일 보정)이 평소의 1.2배 이상이면 앞 3일 예측을 1 + gain × (비율 − 1)배 (최대 2배) */
  surgeLookback: 2,
  surgeThreshold: 1.2,
  surgeGain: 1.0,
  surgeCap: 2.0,
  surgeDays: 3,
} as const;

export type EngineSettings = ForecastSettings & {
  /** 현재 시각(HH:MM) — 당일 발주 마감 판단 */
  nowTime: string;
  /** 얼마나 넉넉하게 주문할지 (안전재고 = z × 사용량 변동 × √기간) */
  serviceLevel: ServiceLevel;
  /** 공급사 입고 지연 대비 추가 일수 */
  leadTimeBufferDays: number;
  /** 사용기한 임박 알림 기준(일) */
  expiryWarnDays: number;
  /** 현재고가 N일치 소요를 넘으면 과잉 */
  overstockDays: number;
  /** 시뮬레이션·차트 표시 기간 (팀 엔진과 같이 14일) */
  horizonDays: number;
};

export const DEFAULT_SETTINGS: EngineSettings = {
  forecastModel: "catboost",
  lookbackWeeks: 4,
  demandAdjustPct: 0,
  applyPromo: false,
  nowTime: "09:00",
  serviceLevel: "normal",
  leadTimeBufferDays: 0,
  expiryWarnDays: 2,
  overstockDays: 14,
  horizonDays: 14,
};
