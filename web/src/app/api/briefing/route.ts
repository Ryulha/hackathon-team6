import { requireSession } from "@/lib/auth/session";
import { validContext } from "@/lib/briefing";
import { explain } from "@/lib/briefing-service";

export const maxDuration = 15;

export async function POST(req: Request) {
  const session = requireSession(req);
  if (session instanceof Response) return session;
  const headers = { "Cache-Control": "no-store" };
  try {
    // 설명 전용 입력. 이 요청은 DB·발주서를 저장하거나 수정하지 않는다.
    const text = await req.text();
    if (text.length > 30_000) return Response.json({ error: "설명할 데이터가 너무 큽니다." }, { status: 400, headers });
    const context: unknown = JSON.parse(text);
    if (!validContext(context, session.storeId)) return Response.json({ error: "현재 매장의 계산 결과를 확인해 주세요." }, { status: 400, headers });
    const result = await explain(context, `${session.storeId}:${session.username}`, {
      enabled: process.env.GEMINI_ENABLED !== "0", apiKey: process.env.GEMINI_API_KEY, model: process.env.GEMINI_MODEL,
    });
    return Response.json(result, { headers });
  } catch {
    return Response.json({ error: "설명을 준비하지 못했습니다. 계산 근거는 계속 확인할 수 있습니다." }, { status: 400, headers });
  }
}
