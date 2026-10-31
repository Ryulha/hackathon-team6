import { requireSession } from "@/lib/auth/session";
import { getSnapshot } from "@/lib/data";

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export async function GET(req: Request) {
  const s = requireSession(req);
  if (s instanceof Response) return s;
  const asOf = new URL(req.url).searchParams.get("asOf");
  try {
    // 매장은 로그인한 관리자의 매장으로 고정 (다른 매장 데이터는 볼 수 없음)
    const snap = await getSnapshot(asOf && DATE.test(asOf) ? asOf : null, s.storeId);
    return Response.json(snap);
  } catch (e) {
    console.error(e);
    return Response.json({ error: "데이터를 불러오지 못했습니다. 파이프라인(build.py) 실행 여부를 확인하세요." }, { status: 500 });
  }
}
