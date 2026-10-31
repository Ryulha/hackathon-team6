import { describeQty } from "@/lib/engine/units";
import type { Ingredient } from "@/lib/types";

/** 수량: 알아보기 쉬운 단위를 크게, 원래 단위를 작게 ("2.3박스 11.5kg") */
export function Qty({ qty, ing, inline = false }: { qty: number; ing: Ingredient; inline?: boolean }) {
  const d = describeQty(qty, ing);
  return (
    <span className={inline ? "" : "inline-flex flex-col items-end leading-tight"}>
      <span className="tabular-nums">{d.main}</span>
      <span className="hint tabular-nums">{inline ? ` (${d.sub})` : d.sub}</span>
    </span>
  );
}

/**
 * 며칠 분량 배지. 빨강은 '다음 입고 전에 떨어짐'(risk)일 때만 —
 * 매일 입고받는 품목은 1~2일분만 두는 게 정상이라 일수만으로 경고하지 않는다.
 */
export function DaysLeft({ days, risk = false, suffix = "치" }: { days: number; risk?: boolean; suffix?: string }) {
  if (!Number.isFinite(days)) return <span className="badge badge-muted">사용 예정 없음</span>;
  const tone = risk ? "badge-high" : "badge-muted";
  const text = days < 1 ? "1일" + suffix + " 미만" : `${days < 10 ? days.toFixed(1) : Math.round(days)}일${suffix}`;
  return <span className={`badge ${tone}`}>{text}</span>;
}
