export const fmt = (n: number, digits = 0) =>
  Number.isFinite(n) ? n.toLocaleString("ko-KR", { maximumFractionDigits: digits }) : "∞";
export const won = (n: number) => `${fmt(n)}원`;

export const SEVERITY_COLOR = { high: "var(--high)", medium: "var(--medium)", low: "var(--low)" } as const;
export const SEVERITY_LABEL = { high: "긴급", medium: "주의", low: "참고" } as const;
