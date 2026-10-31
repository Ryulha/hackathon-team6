export const fmt = (n: number, digits = 0) =>
  Number.isFinite(n) ? n.toLocaleString("ko-KR", { maximumFractionDigits: digits }) : "∞";
export const won = (n: number) => `${fmt(n)}원`;

export const SEVERITY_LABEL = { high: "긴급", medium: "주의", low: "참고" } as const;

/** "09:00" → "16:00" 까지 남은 시간. 지났으면 null */
export function timeLeft(now: string, cutoff: string): string | null {
  const m = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
  const d = m(cutoff) - m(now);
  if (!(d > 0)) return null;
  return d >= 60 ? `${Math.floor(d / 60)}시간${d % 60 ? ` ${d % 60}분` : ""}` : `${d}분`;
}
