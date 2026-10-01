/**
 * GET /api/spotify/connect — Spotify のログイン・許可画面へ移動する。
 */
import { randomBytes } from "node:crypto";
import { isSpotifyConfigured, SPOTIFY_STATE_COOKIE, spotifyAuthUrl, spotifyRedirectUri } from "@/integrations/spotify";
import { cookieHeader } from "@/lib/secure-cookie";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(req: Request): Response {
  if (!isSpotifyConfigured()) return Response.redirect(new URL("/?spotify=not-configured", req.url), 302);
  const state = randomBytes(16).toString("hex");
  const res = new Response(null, { status: 302, headers: { Location: spotifyAuthUrl(spotifyRedirectUri(req), state) } });
  res.headers.append("Set-Cookie", cookieHeader(SPOTIFY_STATE_COOKIE, state, 600));
  return res;
}
