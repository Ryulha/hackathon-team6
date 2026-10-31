import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, verifyToken } from "@/lib/auth/session";

/**
 * 로그인하지 않으면 대시보드 대신 로그인 화면으로.
 * API 는 401 (각 라우트에서도 세션을 다시 확인한다 — proxy 만 믿지 않음).
 */
export function proxy(req: NextRequest) {
  const { pathname, search } = req.nextUrl;
  const session = verifyToken(req.cookies.get(SESSION_COOKIE)?.value);
  const isLogin = pathname === "/login";
  const isAuthApi = pathname.startsWith("/api/auth/");

  if (session) {
    if (isLogin) return NextResponse.redirect(new URL("/", req.url));
    return NextResponse.next();
  }
  if (isLogin || isAuthApi) return NextResponse.next();
  if (pathname.startsWith("/api/")) return Response.json({ error: "로그인이 필요합니다." }, { status: 401 });
  const to = new URL("/login", req.url);
  if (pathname !== "/") to.searchParams.set("next", pathname + search);
  return NextResponse.redirect(to);
}

export const config = {
  // 정적 파일·이미지·로고·파비콘은 로그인 없이
  matcher: ["/((?!_next/static|_next/image|brand/|icon.png|favicon.ico).*)"],
};
