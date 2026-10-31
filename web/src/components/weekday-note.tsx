import { weekdayOf } from "@/lib/engine/dates";

/** 오늘 요일이 이 매장에서 평소보다 바쁜 날인지 (팀 데이터 분석: 요일별 평균 판매) */
export function WeekdayNote({ asOf, weekday, holiday }: { asOf: string; weekday?: { weekday: string; avg_net_sales: number }[]; holiday: number | null }) {
  if (!weekday?.length) return null;
  const wd = weekdayOf(asOf);
  const today = weekday.find((w) => w.weekday === wd);
  if (!today) return null;
  const mean = weekday.reduce((a, w) => a + w.avg_net_sales, 0) / weekday.length;
  const diff = Math.round((today.avg_net_sales / mean - 1) * 100);
  const busiest = [...weekday].sort((a, b) => b.avg_net_sales - a.avg_net_sales)[0];
  return (
    <p className="mt-2 inline-flex flex-wrap items-center gap-1.5 rounded-md bg-[var(--accent-soft)] px-2.5 py-1 text-sm">
      <span className="font-semibold">{wd}요일</span>
      은 이 매장 평균보다 판매가 <b>{diff >= 0 ? `${diff}% 많은` : `${-diff}% 적은`}</b> 날입니다.
      <span className="hint">(가장 바쁜 요일: {busiest.weekday}요일{holiday ? ` · 오늘은 공휴일이라 평소의 ${holiday.toFixed(2)}배로 예측` : ""})</span>
    </p>
  );
}
