/**
 * GET /api/spotify/callback — Spotify で許可したあとに戻ってくる場所。
 * 更新用トークンを暗号化して Cookie に保存し、トップ画面へ戻す。
 */
import {
  exchangeSpotifyCode,
  sealSpotifyToken,
  SPOTIFY_COOKIE,
  SPOTIFY_COOKIE_MAX_AGE,
  SPOTIFY_STATE_COOKIE,
  SpotifyError,
  spotifyRedirectUri,
} from "@/integrations/spotify";
import { cookieHeader, readCookie } from "@/lib/secure-cookie";
import { safeEqual } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function back(req: Request, query: string, cookies: string[] = []): Response {
  const res = new Response(null, { status: 302, headers: { Location: new URL(`/?${query}`, req.url).toString() } });
  for (const c of [...cookies, cookieHeader(SPOTIFY_STATE_COOKIE, "", 0)]) res.headers.append("Set-Cookie", c);
  return res;
}

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state") ?? "";
  const expected = readCookie(req, SPOTIFY_STATE_COOKIE) ?? "";

  if (url.searchParams.get("error")) return back(req, "spotify=denied");
  if (!code || !expected || !safeEqual(state, expected)) return back(req, "spotify=failed");
  try {
    const refresh = await exchangeSpotifyCode(code, spotifyRedirectUri(req));
    return back(req, "spotify=connected", [cookieHeader(SPOTIFY_COOKIE, sealSpotifyToken(refresh), SPOTIFY_COOKIE_MAX_AGE)]);
  } catch (err) {
    console.warn("[friday] spotify connect failed:", err instanceof Error ? err.message : err);
    return back(req, `spotify=failed&reason=${encodeURIComponent(err instanceof SpotifyError ? err.code : "UNKNOWN")}`);
  }
}
