import { HOME, ROLE_LABEL, requireSession } from "@/lib/auth/session";

/** 로그인한 사람의 역할·소속 매장 — 화면 구성(메뉴·첫 화면)에 사용 */
export async function GET(req: Request) {
  const s = requireSession(req);
  if (s instanceof Response) return s;
  return Response.json({ username: s.username, storeId: s.storeId, role: s.role, roleLabel: ROLE_LABEL[s.role], home: HOME[s.role] });
}
