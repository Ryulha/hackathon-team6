// 매장 관리자 로그인 세션 — HMAC 서명 쿠키 (proxy·라우트 핸들러 공용, Node 런타임)
import { createHash, createHmac, scryptSync, timingSafeEqual } from "node:crypto";

export const SESSION_COOKIE = "cc_session";
export const SESSION_MAX_AGE = 60 * 60 * 12; // 12시간

export type Session = { username: string; storeId: string; exp: number };

/**
 * 서명 키: SESSION_SECRET 이 있으면 그것, 없으면 이미 비밀인 DATABASE_URL 에서 파생(별도 환경변수 없이 배포 가능).
 * 둘 다 없으면 로컬 개발용 고정값.
 */
function secret(): Buffer {
  const base = process.env.SESSION_SECRET ?? process.env.DATABASE_URL ?? "local-dev-only";
  return createHash("sha256").update(`cc-session:${base}`).digest();
}

const b64 = (b: Buffer | string) => Buffer.from(b).toString("base64url");
const sign = (data: string) => createHmac("sha256", secret()).update(data).digest("base64url");

export function createToken(username: string, storeId: string): string {
  const payload = b64(JSON.stringify({ username, storeId, exp: Math.floor(Date.now() / 1000) + SESSION_MAX_AGE } satisfies Session));
  return `${payload}.${sign(payload)}`;
}

export function verifyToken(token: string | undefined): Session | null {
  if (!token) return null;
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return null;
  const expected = Buffer.from(sign(payload));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  try {
    const s = JSON.parse(Buffer.from(payload, "base64url").toString()) as Session;
    return s.exp > Date.now() / 1000 ? s : null;
  } catch {
    return null;
  }
}

/** 라우트 핸들러용: 쿠키 헤더에서 세션 읽기 */
export function sessionFrom(req: Request): Session | null {
  const raw = req.headers.get("cookie") ?? "";
  const m = raw.split(/;\s*/).find((c) => c.startsWith(`${SESSION_COOKIE}=`));
  return verifyToken(m?.slice(SESSION_COOKIE.length + 1));
}

/** 세션이 없으면 401 응답을, 있으면 세션을 돌려준다 */
export function requireSession(req: Request): Session | Response {
  return sessionFrom(req) ?? Response.json({ error: "로그인이 필요합니다." }, { status: 401 });
}

// ---------- 매장 관리자 계정 (데모: 매장마다 1개) ----------
// 비밀번호 원문은 저장하지 않고 scrypt 해시만 둔다. 테스트 계정은 README·로그인 화면 안내에 있음.

type Account = { username: string; storeId: string; salt: string; hash: string };

const ACCOUNTS: Account[] = [
  { username: "s01", storeId: "S01", salt: "84a2cd775f24c3fa57c3de5e9ccc1940", hash: "d4b2b717e143c1957cb5187af238d9c7c62ac398f9c84e3794c48c1cd9e7d459" },
  { username: "s02", storeId: "S02", salt: "84f0f0cdf7d21c2ee20b1a76fa7ed0a3", hash: "a0799b0a3d3f6720087df902fc8724105944c8723b3e5e9b60f78e1bebfef9e7" },
  { username: "s03", storeId: "S03", salt: "4073e04e6c1e94bc1329800996443525", hash: "6cb195f039bcd3e455bfc83372aa82408637b796ab5f9238fc448eba7a58b625" },
];

/** 아이디·비밀번호 확인. 없는 아이디도 같은 시간이 걸리도록 항상 해시를 계산 */
export function checkPassword(username: string, password: string): Account | null {
  const acc = ACCOUNTS.find((a) => a.username === username.trim().toLowerCase());
  const salt = acc?.salt ?? "00000000000000000000000000000000";
  const got = scryptSync(password, salt, 32);
  const want = Buffer.from(acc?.hash ?? "0".repeat(64), "hex");
  return acc && timingSafeEqual(got, want) ? acc : null;
}
