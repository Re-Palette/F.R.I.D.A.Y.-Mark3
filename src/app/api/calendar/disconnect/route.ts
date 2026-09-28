/**
 * POST /api/calendar/disconnect — この端末の Google カレンダー接続を解除する。
 */
import { CALENDAR_COOKIE } from "@/integrations/google-calendar";
import { cookieHeader } from "@/lib/secure-cookie";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function POST(): Response {
  const res = Response.json({ ok: true });
  res.headers.append("Set-Cookie", cookieHeader(CALENDAR_COOKIE, "", 0));
  return res;
}
