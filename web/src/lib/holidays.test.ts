// 공휴일 캘린더 연동·공휴일 운영 방식 — 손으로 만든 값(제공 데이터 아님)
import { describe, expect, it } from "vitest";
import { forecastMenus, type ForecastContext } from "./engine/forecast";
import { DEFAULT_SETTINGS } from "./engine/settings";
import { parseHolidayIcs } from "./holidays";

const ev = (d: string, name: string, desc: string) => `BEGIN:VEVENT\r\nDTSTART;VALUE=DATE:${d}\r\nSUMMARY:${name}\r\nDESCRIPTION:${desc}\r\nEND:VEVENT\r\n`;

describe("공휴일 캘린더", () => {
  it("iCal에서 '공휴일'만 뽑고 기념일은 뺀다", () => {
    const ics = `BEGIN:VCALENDAR\r\n${ev("20261009", "한글날", "공휴일")}${ev("20261001", "국군의날", "기념일\\n기념일을 숨기려면")}${ev("20261005", "쉬는 날 개천절", "공휴일")}END:VCALENDAR`;
    expect(parseHolidayIcs(ics)).toEqual([{ date: "2026-10-05", name: "쉬는 날 개천절" }, { date: "2026-10-09", name: "한글날" }]);
  });
});

describe("공휴일 운영 방식", () => {
  const ctx: ForecastContext = { dowIdx: { 월: 1, 화: 1, 수: 1, 목: 1, 금: 1, 토: 1, 일: 1 }, holMult: 1.5, holidays: new Set(["2026-10-09"]) };
  const basis = [{ menuId: "M1", level: 10, sampleDays: 28 }];
  const qty = (mode?: "auto" | "weekday" | "closed") =>
    forecastMenus(basis, [], "S01", ["2026-10-08", "2026-10-09"], ctx, { ...DEFAULT_SETTINGS, holidayPlan: mode ? { "2026-10-09": mode } : undefined }).map((f) => f.qty);
  it("기본은 지난 공휴일 배수", () => expect(qty()).toEqual([10, 15]));
  it("평일처럼", () => expect(qty("weekday")).toEqual([10, 10]));
  it("쉬는 날은 판매 0 (공휴일 아닌 날은 그대로)", () => expect(qty("closed")).toEqual([10, 0]));
});
