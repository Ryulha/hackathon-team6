// 'YYYY-MM-DD' 문자열 날짜 유틸 (UTC 고정 — 서버/브라우저 시간대 차이 방지)

const DAY = 86_400_000;
export const WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"] as const;
export type Weekday = (typeof WEEKDAYS)[number];

const toMs = (d: string) => Date.parse(`${d}T00:00:00Z`);
const fromMs = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export const addDays = (d: string, n: number) => fromMs(toMs(d) + n * DAY);
export const diffDays = (a: string, b: string) => Math.round((toMs(a) - toMs(b)) / DAY);
export const weekdayOf = (d: string): Weekday => WEEKDAYS[new Date(toMs(d)).getUTCDay()];

export function range(start: string, endExclusive: string): string[] {
  const out: string[] = [];
  for (let d = start; d < endExclusive; d = addDays(d, 1)) out.push(d);
  return out;
}

const EN: Record<string, Weekday> = {
  sun: "일", mon: "월", tue: "화", wed: "수", thu: "목", fri: "금", sat: "토",
};

/**
 * 요일 목록 파싱. 실제 포맷 미확정(TODO 10/31) → '월,수,금' '월|수' '월수금' 'Mon/Wed' '매일' 모두 허용.
 */
export function parseWeekdays(s: string): Set<Weekday> {
  const v = (s ?? "").trim();
  if (!v || /매일|daily|all/i.test(v)) return new Set(WEEKDAYS);
  const out = new Set<Weekday>();
  for (const tok of v.split(/[\s,|;/·]+/).filter(Boolean)) {
    const en = EN[tok.slice(0, 3).toLowerCase()];
    if (en) { out.add(en); continue; }
    // '월수금' '월요일' 등 한 글자씩
    for (const ch of tok) if ((WEEKDAYS as readonly string[]).includes(ch)) out.add(ch as Weekday);
  }
  return out.size ? out : new Set(WEEKDAYS);
}

/** ID 목록 파싱: 'M01|M02', 'M01,M02', '["M01","M02"]' 등 */
export function parseList(s: string): string[] {
  return (s ?? "").replace(/[[\]"']/g, "").split(/[\s,|;/]+/).filter(Boolean);
}

/** '2026-10-02' → '10/2(금)' — 화면 문장용 짧은 날짜. ref 와 연도가 다르면 연도도 붙인다('2027/9/29(수)') */
export const shortDate = (d: string, ref?: string) =>
  `${ref && ref.slice(0, 4) !== d.slice(0, 4) ? `${d.slice(0, 4)}/` : ""}${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}(${weekdayOf(d)})`;
