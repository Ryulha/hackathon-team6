import { NextResponse, type NextRequest } from "next/server";
import { HOME, SESSION_COOKIE, verifyToken, type Role } from "@/lib/auth/session";

/** 역할별로 열 수 있는 화면 (API 는 각 라우트에서 역할을 다시 확인한다 — proxy 만 믿지 않음) */
const PAGES: Record<Role, string[] | "all"> = {
  staff: ["/checks", "/count"],
  supervisor: ["/diagnosis", "/overview", "/inventory", "/assumptions"],
  manager: "all",
};
const MANAGER_BLOCKED = ["/diagnosis"];

/**
 * 로그인하지 않으면 로그인 화면으로, 로그인했으면 역할에 맞는 첫 화면·허용 화면으로.
 * API 는 401.
 */
export function proxy(req: NextRequest) {
  const { pathname, search } = req.nextUrl;
  const session = verifyToken(req.cookies.get(SESSION_COOKIE)?.value);
  const isLogin = pathname === "/login";
  const isApi = pathname.startsWith("/api/");

  if (!session) {
    if (isLogin || pathname.startsWith("/api/auth/")) return NextResponse.next();
    if (isApi) return Response.json({ error: "로그인이 필요합니다." }, { status: 401 });
    const to = new URL("/login", req.url);
    if (pathname !== "/") to.searchParams.set("next", pathname + search);
    return NextResponse.redirect(to);
  }
  if (isApi) return NextResponse.next();

  const home = HOME[session.role];
  if (isLogin) return NextResponse.redirect(new URL(home, req.url));
  const allowed = PAGES[session.role];
  const ok = allowed === "all" ? !MANAGER_BLOCKED.includes(pathname) : allowed.includes(pathname);
  if (!ok) return NextResponse.redirect(new URL(home, req.url));
  return NextResponse.next();
}

export const config = {
  // 정적 파일·이미지·로고·파비콘은 로그인 없이
  matcher: ["/((?!_next/static|_next/image|brand/|icon.png|favicon.ico).*)"],
};
