import { describe, expect, it, vi } from "vitest";
import { createToken, SESSION_COOKIE } from "@/lib/auth/session";
import { context } from "../../../../tests/briefing-fixture";
import { fallbackBrief, type BriefContext } from "@/lib/briefing";
vi.mock("@/lib/briefing-service", () => ({
  explain: vi.fn(async (c: BriefContext) => ({ source: "calculation", brief: fallbackBrief(c), message: "기본 설명" })),
}));
import { POST } from "./route";

const request = (store?: string, body: unknown = context()) => new Request("http://localhost/api/briefing", {
  method: "POST", headers: { "content-type": "application/json", ...(store ? { cookie: `${SESSION_COOKIE}=${createToken("test-user", store)}` } : {}) },
  body: JSON.stringify(body),
});

describe("briefing POST", () => {
  it("로그인하지 않은 요청 거부", async () => expect((await POST(request())).status).toBe(401));
  it("로그인 매장과 다른 매장의 설명 요청 거부", async () => expect((await POST(request("S01"))).status).toBe(400));
  it("해당 매장 입력은 저장 없이 설명 응답 반환", async () => {
    const r = await POST(request("S03"));
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect((await r.json()).source).toBe("calculation");
  });
  it("큰 본문과 잘못된 JSON은 앱 오류로 전파하지 않음", async () => {
    expect((await POST(request("S03", { ...context(), extra: "x".repeat(31000) }))).status).toBe(400);
    const req = request("S03");
    vi.spyOn(req, "text").mockResolvedValue("{");
    expect((await POST(req)).status).toBe(400);
  });
});
