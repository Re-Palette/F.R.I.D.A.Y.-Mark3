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

/** POST — 画面から予定を追加する { title, start: "YYYY-MM-DDTHH:MM" | "YYYY-MM-DD", end?, location?, allDay? } */
export async function POST(req: Request): Promise<Response> {
  const refresh = isCalendarConfigured() ? refreshTokenFrom(req) : undefined;
  if (!refresh) return Response.json({ error: "Google カレンダーに接続されていません。" }, { status: 400 });
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  try {
    const event = await new CalendarAccess(refresh, getTimezone()).add({
      title: String(body.title ?? ""),
      start: String(body.start ?? ""),
      end: typeof body.end === "string" && body.end ? body.end : undefined,
      location: typeof body.location === "string" ? body.location : undefined,
      allDay: body.allDay === true,
    });
    return Response.json({ ok: true, event });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "追加できませんでした。" }, { status: 400 });
  }
}

/** DELETE ?id=… — 画面から予定を削除する */
export async function DELETE(req: Request): Promise<Response> {
  const refresh = isCalendarConfigured() ? refreshTokenFrom(req) : undefined;
  if (!refresh) return Response.json({ error: "Google カレンダーに接続されていません。" }, { status: 400 });
  const id = new URL(req.url).searchParams.get("id") ?? "";
  try {
    const removed = await new CalendarAccess(refresh, getTimezone()).remove(id);
    return Response.json({ ok: true, removed });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "削除できませんでした。" }, { status: 400 });
  }
}
