/**
 * GET /api/calendar/callback — Google で許可したあとに戻ってくる場所。
 * 更新用トークンを暗号化して Cookie に保存し、トップ画面へ戻す。
 */
import {
  CALENDAR_COOKIE,
  CALENDAR_COOKIE_MAX_AGE,
  CalendarError,
  exchangeCode,
  redirectUri,
  sealRefreshToken,
  STATE_COOKIE,
} from "@/integrations/google-calendar";
import { cookieHeader, readCookie } from "@/lib/secure-cookie";
import { safeEqual } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function back(req: Request, query: string, cookies: string[] = []): Response {
  const res = new Response(null, { status: 302, headers: { Location: new URL(`/?${query}`, req.url).toString() } });
  for (const c of [...cookies, cookieHeader(STATE_COOKIE, "", 0)]) res.headers.append("Set-Cookie", c);
  return res;
}

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state") ?? "";
  const expected = readCookie(req, STATE_COOKIE) ?? "";

  if (url.searchParams.get("error")) return back(req, "calendar=denied");
  if (!code || !expected || !safeEqual(state, expected)) return back(req, "calendar=failed");

  try {
    const refresh = await exchangeCode(code, redirectUri(req));
    return back(req, "calendar=connected", [cookieHeader(CALENDAR_COOKIE, sealRefreshToken(refresh), CALENDAR_COOKIE_MAX_AGE)]);
  } catch (err) {
    console.warn("[friday] calendar connect failed:", err instanceof Error ? err.message : err);
    return back(req, `calendar=failed&reason=${encodeURIComponent(err instanceof CalendarError ? err.code : "UNKNOWN")}`);
  }
}
