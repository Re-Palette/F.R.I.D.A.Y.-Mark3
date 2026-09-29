/**
 * 合言葉ロックの門番。ログインしていないアクセスはログイン画面へ（API は 401）。
 */
import { NextResponse, type NextRequest } from "next/server";
import { AUTH_COOKIE, getAuthMode, safeEqual, sessionToken } from "@/lib/auth";

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  // ログイン画面と、Google の審査用に公開が必要なプライバシーポリシーは合言葉なしで開ける
  if (pathname === "/login" || pathname === "/api/login" || pathname === "/privacy") return NextResponse.next();
  // アプリのアイコンと manifest は、ブラウザが Cookie なしで読みに来るので公開する
  if (pathname === "/manifest.webmanifest" || pathname === "/sw.js" || pathname.startsWith("/icons/")) return NextResponse.next();
  // 自動実行（Vercel Cron）は合言葉の代わりに CRON_SECRET で確かめる（各ルートで検証）
  if (pathname.startsWith("/api/cron/")) return NextResponse.next();

  const mode = getAuthMode();
  if (mode === "open") return NextResponse.next();

  const cookie = request.cookies.get(AUTH_COOKIE)?.value ?? "";
  if (mode === "locked" && safeEqual(cookie, await sessionToken())) return NextResponse.next();

  if (pathname.startsWith("/api/")) {
    return NextResponse.json(
      { type: "error", code: "UNAUTHORIZED", message: "合言葉でログインしてください。", retryable: false },
      { status: 401 },
    );
  }
  return NextResponse.redirect(new URL("/login", request.url));
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
