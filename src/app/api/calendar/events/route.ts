/**
 * GET /api/calendar/events — 今日（?days=n で n 日分）の予定（右パネル用）。
 */
import type { CalendarResponse } from "@/core/types";
import { CalendarAccess, CalendarError, isCalendarConfigured, refreshTokenFrom } from "@/integrations/google-calendar";
import { getTimezone } from "@/lib/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  const headers = { "Cache-Control": "no-store" };
  if (!isCalendarConfigured()) return Response.json({ configured: false, connected: false } satisfies CalendarResponse, { headers });
  const refresh = refreshTokenFrom(req);
  if (!refresh) return Response.json({ configured: true, connected: false } satisfies CalendarResponse, { headers });

  const days = Math.min(14, Math.max(1, Number(new URL(req.url).searchParams.get("days")) || 1));
  try {
    const events = await new CalendarAccess(refresh, getTimezone()).upcoming(days, 50);
    return Response.json({ configured: true, connected: true, events } satisfies CalendarResponse, { headers });
  } catch (err) {
    const e = err instanceof CalendarError ? err : new CalendarError("CALENDAR_UPSTREAM", "予定を読み込めませんでした。");
    return Response.json(
      { configured: true, connected: !e.reconnect, reason: e.message } satisfies CalendarResponse,
      { headers },
    );
  }
}
