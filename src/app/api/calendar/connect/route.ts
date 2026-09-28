/**
 * GET /api/calendar/connect — Google のログイン・許可画面へ移動する。
 */
import { randomBytes } from "node:crypto";
import { buildAuthUrl, isCalendarConfigured, redirectUri, STATE_COOKIE } from "@/integrations/google-calendar";
import { cookieHeader } from "@/lib/secure-cookie";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(req: Request): Response {
  if (!isCalendarConfigured()) {
    return Response.redirect(new URL("/?calendar=not-configured", req.url), 302);
  }
  const state = randomBytes(16).toString("hex");
  const res = new Response(null, { status: 302, headers: { Location: buildAuthUrl(redirectUri(req), state) } });
  res.headers.append("Set-Cookie", cookieHeader(STATE_COOKIE, state, 600));
  return res;
}
