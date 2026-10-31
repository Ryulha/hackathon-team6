// 대한민국 공휴일 캘린더 연동 — 구글 공개 캘린더(iCal). 키 없이 받을 수 있고 대체공휴일·선거일도 들어온다.
import type { CalendarRow, Holiday } from "./types";
import { EXTRA_HOLIDAYS } from "./engine/forecast";

const ICS = "https://calendar.google.com/calendar/ical/ko.south_korea%23holiday%40group.v.calendar.google.com/public/basic.ics";

/** iCal 에서 '공휴일'만 (기념일 — 어버이날·국군의날 등 — 은 영업에 영향이 적어 뺌) */
export function parseHolidayIcs(text: string): { date: string; name: string }[] {
  const out: { date: string; name: string }[] = [];
  for (const ev of text.replace(/\r/g, "").split("BEGIN:VEVENT").slice(1)) {
    const date = /^DTSTART;VALUE=DATE:(\d{4})(\d{2})(\d{2})/m.exec(ev);
    const name = /^SUMMARY:(.*)$/m.exec(ev)?.[1]?.trim();
    const desc = /^DESCRIPTION:(.*)$/m.exec(ev)?.[1] ?? "";
    if (date && name && desc.startsWith("공휴일")) out.push({ date: `${date[1]}-${date[2]}-${date[3]}`, name });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

async function fetchCalendar(): Promise<{ date: string; name: string }[] | null> {
  try {
    const r = await fetch(ICS, { next: { revalidate: 86_400 }, signal: AbortSignal.timeout(4000) });
    if (!r.ok) return null;
    const list = parseHolidayIcs(await r.text());
    return list.length ? list : null;
  } catch {
    return null;
  }
}

/** 제공 데이터 기간은 calendar.csv 그대로, 그 이후는 캘린더 연동(실패 시 가정값) */
export async function holidaysFor(calendar: CalendarRow[], providedEnd: string): Promise<Holiday[]> {
  const fromData: Holiday[] = calendar.filter((c) => Number(c.is_holiday) === 1).map((c) => ({ date: c.date, name: c.holiday_name, source: "data" }));
  const feed = await fetchCalendar();
  const after: Holiday[] = feed
    ? feed.filter((h) => h.date > providedEnd).map((h) => ({ ...h, source: "calendar" }))
    : Object.entries(EXTRA_HOLIDAYS).map(([date, name]) => ({ date, name, source: "assumed" }));
  return [...fromData, ...after];
}
