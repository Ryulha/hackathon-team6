import { HOME, SESSION_COOKIE, SESSION_MAX_AGE, checkPassword, createToken } from "@/lib/auth/session";

// 같은 아이디로 연속 실패 시 잠시 막기 (서버 인스턴스 단위, 데모 수준)
const fails = new Map<string, { n: number; until: number }>();
const LIMIT = 5;
const LOCK_MS = 5 * 60 * 1000;

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const username = String(body?.username ?? "").trim().toLowerCase();
  const password = String(body?.password ?? "");
  if (!username || !password) return Response.json({ error: "아이디와 비밀번호를 입력하세요." }, { status: 400 });

  const f = fails.get(username);
  if (f && f.n >= LIMIT && f.until > Date.now()) {
    return Response.json({ error: "로그인 시도가 너무 많습니다. 5분 뒤 다시 시도하세요." }, { status: 429 });
  }
  const acc = checkPassword(username, password);
  if (!acc) {
    const cur = f && f.until > Date.now() ? f : { n: 0, until: 0 };
    fails.set(username, { n: cur.n + 1, until: Date.now() + LOCK_MS });
    return Response.json({ error: "아이디 또는 비밀번호가 맞지 않습니다." }, { status: 401 });
  }
  fails.delete(username);

  const res = Response.json({ username: acc.username, storeId: acc.storeId, role: acc.role, home: HOME[acc.role] });
  res.headers.append("Set-Cookie", [
    `${SESSION_COOKIE}=${createToken(acc)}`, "Path=/", "HttpOnly", "SameSite=Lax", `Max-Age=${SESSION_MAX_AGE}`,
    ...(process.env.NODE_ENV === "production" ? ["Secure"] : []),
  ].join("; "));
  return res;
}
