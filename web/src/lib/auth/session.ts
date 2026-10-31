// 로그인 세션 — HMAC 서명 쿠키 (proxy·라우트 핸들러 공용, Node 런타임)
// 역할: 일반 직원(매장 공용 계정) / 점장(매장 관리자) / 슈퍼바이저(전 매장)
import { createHash, createHmac, scryptSync, timingSafeEqual } from "node:crypto";

export const SESSION_COOKIE = "cc_session";
export const SESSION_MAX_AGE = 60 * 60 * 12; // 12시간

export type Role = "staff" | "manager" | "supervisor";
export const ROLE_LABEL: Record<Role, string> = { staff: "직원", manager: "점장", supervisor: "슈퍼바이저" };

/** storeId: 소속 매장. 슈퍼바이저는 "*" (전 매장) */
export type Session = { username: string; storeId: string; role: Role; exp: number };

/** 역할별 첫 화면 */
export const HOME: Record<Role, string> = { staff: "/checks", manager: "/", supervisor: "/diagnosis" };

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

export function createToken(acc: { username: string; storeId: string; role: Role }): string {
  const payload = b64(JSON.stringify({ username: acc.username, storeId: acc.storeId, role: acc.role, exp: Math.floor(Date.now() / 1000) + SESSION_MAX_AGE } satisfies Session));
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
    if (!(s.exp > Date.now() / 1000)) return null;
    return { ...s, role: s.role ?? "manager" }; // 역할 도입 전 쿠키는 점장으로
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

/** 세션이 없으면 401, 허용 역할이 아니면 403 응답을, 아니면 세션을 돌려준다 */
export function requireSession(req: Request, roles?: Role[]): Session | Response {
  const s = sessionFrom(req);
  if (!s) return Response.json({ error: "로그인이 필요합니다." }, { status: 401 });
  if (roles && !roles.includes(s.role)) return Response.json({ error: `${ROLE_LABEL[s.role]} 계정으로는 할 수 없는 작업입니다.` }, { status: 403 });
  return s;
}

/** 조회할 매장: 슈퍼바이저는 ?store= 로 고르고(기본 S01), 나머지는 소속 매장으로 고정 */
export function storeOf(req: Request, s: Session): string {
  if (s.role !== "supervisor") return s.storeId;
  const q = new URL(req.url).searchParams.get("store") ?? "";
  return /^S\d{2}$/.test(q) ? q : "S01";
}

// ---------- 계정 (데모) ----------
// 비밀번호 원문은 저장하지 않고 scrypt 해시만 둔다. 테스트 계정은 README·로그인 화면 안내에 있음.

type Account = { username: string; storeId: string; role: Role; salt: string; hash: string };

const ACCOUNTS: Account[] = [
  { username: "s01", storeId: "S01", role: "manager", salt: "84a2cd775f24c3fa57c3de5e9ccc1940", hash: "d4b2b717e143c1957cb5187af238d9c7c62ac398f9c84e3794c48c1cd9e7d459" },
  { username: "s02", storeId: "S02", role: "manager", salt: "84f0f0cdf7d21c2ee20b1a76fa7ed0a3", hash: "a0799b0a3d3f6720087df902fc8724105944c8723b3e5e9b60f78e1bebfef9e7" },
  { username: "s03", storeId: "S03", role: "manager", salt: "4073e04e6c1e94bc1329800996443525", hash: "6cb195f039bcd3e455bfc83372aa82408637b796ab5f9238fc448eba7a58b625" },
  // 매장 공용 직원 계정 — 로그인 후 휴대폰에서 자기 이름을 한 번 고른다
  { username: "s01-staff", storeId: "S01", role: "staff", salt: "243f2492afc70b49808e880267cbad6f", hash: "b531e67d20ea612213d2b9e7c3df7a51b7f979e495d2891bc2b5c24cfe95eab9" },
  { username: "s02-staff", storeId: "S02", role: "staff", salt: "3f286371f66ec8c5b36a4cacbae001f1", hash: "3ea6489376f50247e5806362e55a78249c06bcb098068e7bd160ce1d0d75f460" },
  { username: "s03-staff", storeId: "S03", role: "staff", salt: "58965501a9fbc3f49f04081e13f53e33", hash: "dc4bf13b38e7cdce59f32b023600398854ede243fd10b4a99bdf6a49588aa024" },
  { username: "sv", storeId: "*", role: "supervisor", salt: "597dba15def57befec46104c73a618f5", hash: "b61fe7be31c73a63dd02993014d1bfc6a2244450d387b04d38db7b19132b3fd9" },
];

/** 아이디·비밀번호 확인. 없는 아이디도 같은 시간이 걸리도록 항상 해시를 계산 */
export function checkPassword(username: string, password: string): Account | null {
  const acc = ACCOUNTS.find((a) => a.username === username.trim().toLowerCase());
  const salt = acc?.salt ?? "00000000000000000000000000000000";
  const got = scryptSync(password, salt, 32);
  const want = Buffer.from(acc?.hash ?? "0".repeat(64), "hex");
  return acc && timingSafeEqual(got, want) ? acc : null;
}
