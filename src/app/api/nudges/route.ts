/**
 * GET /api/nudges — 先回りの声かけの一覧（予定の 20 分前・今日 / 明日が期限の ToDo・雨の日の傘）。
 * 画面は数分ごとにこれを読み、時間になったものを 1 回だけ話す。
 */
import { CalendarAccess, isCalendarConfigured, refreshTokenFrom } from "@/integrations/google-calendar";
import { buildNudges } from "@/integrations/nudges";
import { getTimezone } from "@/lib/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  const tz = getTimezone();
  const refresh = isCalendarConfigured() ? refreshTokenFrom(req) : undefined;
  const events = refresh ? await new CalendarAccess(refresh, tz).upcoming(2, 30).catch(() => null) : null;
  const nudges = await buildNudges({ tz, events }).catch(() => []);
  return Response.json({ nudges, now: Date.now() }, { headers: { "Cache-Control": "no-store" } });
}
