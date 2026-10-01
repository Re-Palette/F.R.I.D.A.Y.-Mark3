/**
 * POST /api/spotify/disconnect — この端末の Spotify 接続を解除する。
 */
import { SPOTIFY_COOKIE } from "@/integrations/spotify";
import { cookieHeader } from "@/lib/secure-cookie";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function POST(): Response {
  const res = Response.json({ ok: true });
  res.headers.append("Set-Cookie", cookieHeader(SPOTIFY_COOKIE, "", 0));
  return res;
}
