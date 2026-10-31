import { requireSession, storeOf } from "@/lib/auth/session";
import { getSnapshot } from "@/lib/data";

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export async function GET(req: Request) {
  const s = requireSession(req);
  if (s instanceof Response) return s;
  const asOf = new URL(req.url).searchParams.get("asOf");
  try {
    // 매장: 직원·점장은 소속 매장으로 고정, 슈퍼바이저만 ?store= 로 선택
    const snap = await getSnapshot(asOf && DATE.test(asOf) ? asOf : null, storeOf(req, s));
    return Response.json(snap);
  } catch (e) {
    console.error(e);
    return Response.json({ error: "데이터를 불러오지 못했습니다. 파이프라인(build.py) 실행 여부를 확인하세요." }, { status: 500 });
  }
}
