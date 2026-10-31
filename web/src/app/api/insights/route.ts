import { requireSession, storeOf } from "@/lib/auth/session";
import { getInsights } from "@/lib/insights";

export async function GET(req: Request) {
  const s = requireSession(req);
  if (s instanceof Response) return s;
  return Response.json(await getInsights(storeOf(req, s)));
}
