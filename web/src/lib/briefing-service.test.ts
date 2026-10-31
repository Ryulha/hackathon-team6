import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { explain } from "./briefing-service";
import { context, brief, gemini } from "../../tests/briefing-fixture";

let sequence = 0;
const actor = () => `test:${sequence++}`;
afterEach(() => vi.restoreAllMocks());

describe("Gemini optional explanation", () => {
  it("키 없음·기능 꺼짐·품목 없음이면 API를 부르지 않음", async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const options of [{}, { apiKey: "test", enabled: false }]) {
      const r = await explain(context(), actor(), { ...options, fetcher });
      expect(r.source).toBe("calculation");
    }
    await explain({ ...context(), items: [] }, actor(), { apiKey: "test", fetcher });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("키는 헤더에만 보내고 구조화된 응답을 검증", async () => {
    const fetcher = vi.fn<typeof fetch>(async (url, options) => {
      expect(String(url)).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-lite-latest:generateContent");
      expect(options?.headers).toMatchObject({ "x-goog-api-key": "test-secret" });
      expect(String(options?.body)).not.toContain("test-secret");
      const body = JSON.parse(String(options?.body));
      expect(body.generationConfig.responseMimeType).toBe("application/json");
      expect(options?.signal).toBeTruthy();
      return Response.json(gemini());
    });
    const r = await explain(context(), actor(), { apiKey: "test-secret", fetcher });
    expect(r.source).toBe("gemini");
    expect(r.brief).toEqual(brief());
    expect(JSON.stringify(r)).not.toContain("test-secret");
  });
  it.each([400, 401, 403, 404, 429, 500, 503])("HTTP %i에서도 기본 설명으로 복귀, 오류 원문은 기록 안 함", async (status) => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetcher = vi.fn<typeof fetch>(async () => new Response("private test-secret", { status }));
    const r = await explain(context(), actor(), { apiKey: "test-secret", fetcher });
    expect(r.source).toBe("calculation");
    expect(r.brief.items).toHaveLength(2);
    expect(JSON.stringify(r)).not.toContain("test-secret");
    expect(JSON.stringify(warning.mock.calls)).not.toContain("test-secret");
  });
  it("네트워크 실패·잘못된 JSON·잘린 응답·환각 수치는 기본 설명으로 복귀", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const responses = [
      async () => { throw new Error("private test-secret"); },
      async () => new Response("invalid JSON"),
      async () => Response.json({ candidates: [{ finishReason: "MAX_TOKENS" }] }),
      async () => Response.json(gemini({ ...brief(), overview: "100박스를 발주하세요." })),
    ];
    for (const fetcher of responses) {
      const r = await explain(context(), actor(), { apiKey: "test-secret", fetcher: fetcher as typeof fetch });
      expect(r.source).toBe("calculation");
      expect(r.brief).toEqual({ overview: expect.any(String), items: brief().items });
    }
  });
  it("시간 초과가 나면 기다림을 끝내고 기본 설명을 반환", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetcher: typeof fetch = async (_url, options) => new Promise((_resolve, reject) => {
      options!.signal!.addEventListener("abort", () => reject(options!.signal!.reason), { once: true });
    });
    const start = Date.now();
    const r = await explain(context(), actor(), { apiKey: "test", fetcher, timeoutMs: 15 });
    expect(r.source).toBe("calculation");
    expect(r.message).toContain("늦어");
    expect(Date.now() - start).toBeLessThan(1000);
  });
  it("같은 조건은 재사용하고, 수정한 수량에는 이전 AI 결과를 재사용하지 않음", async () => {
    const who = actor();
    const fetcher = vi.fn<typeof fetch>(async () => Response.json(gemini()));
    await explain(context(), who, { apiKey: "test", fetcher, now: () => 0 });
    const cached = await explain(context(), who, { apiKey: "test", fetcher, now: () => 1 });
    expect(cached.cached).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const changed = context(); changed.items[0].orderQty = 2;
    const cooling = await explain(changed, who, { apiKey: "test", fetcher, now: () => 2 });
    expect(cooling.source).toBe("calculation");
    expect(cooling.retryAfterSeconds).toBe(20);
    await explain(changed, who, { apiKey: "test", fetcher, now: () => 21000 });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
