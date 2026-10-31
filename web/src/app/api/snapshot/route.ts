import { getSnapshot } from "@/lib/data";

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export async function GET(req: Request) {
  const q = new URL(req.url).searchParams;
  const asOf = q.get("asOf");
  try {
    const snap = await getSnapshot(asOf && DATE.test(asOf) ? asOf : null, q.get("store"));
    return Response.json(snap);
  } catch (e) {
    console.error(e);
    return Response.json({ error: "데이터를 불러오지 못했습니다. 파이프라인(build.py) 실행 여부를 확인하세요." }, { status: 500 });
  }
}
