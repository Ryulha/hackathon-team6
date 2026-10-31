import type { ForecastSettings } from "./forecast";

/**
 * 품절 위험 허용 수준 → 정규분포 z (서비스 수준). 팀 발주 최적화 엔진과 같은 값.
 * 넉넉 ≈ 98% / 보통 ≈ 90% / 타이트 ≈ 75% 확률로 다음 입고 전까지 안 떨어지게.
 */
export const SERVICE_LEVELS = {
  loose: { label: "넉넉하게", z: 2.05, hint: "품절을 최대한 피함 (재고·폐기는 늘어남)" },
  normal: { label: "보통", z: 1.28, hint: "품절 위험 약 10% 수준" },
  tight: { label: "타이트하게", z: 0.67, hint: "재고를 최소로 (품절 위험 늘어남)" },
} as const;
export type ServiceLevel = keyof typeof SERVICE_LEVELS;

/** 팀 엔진 최적화 설정 (백테스트로 정한 값) */
export const OPT = {
  /** 품절 이력 조회 기간(일), 기준일 전날까지 */
  stockoutWindow: 28,
  /** 최근 품절 품목의 z 상향폭 (1.28→1.64 ≈ 90%→95%) */
  zBoost: 0.36,
  zMax: 2.33,
  /** 마지막 1발주단위 중 이 비율 이상이 폐기 예상이면 감량 */
  wasteCutRatio: 0.5,
  /** 사용기한이 이 일수 이상이면 '장기 품목' — 남아도 버릴 위험이 낮아 넉넉히 */
  longShelf: 14,
  zLong: 2.05,
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
