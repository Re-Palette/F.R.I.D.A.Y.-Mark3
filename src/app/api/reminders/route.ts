/**
 * GET /api/reminders — まだ知らせていないリマインダー（画面が時間になったら知らせる）。
 */
import { listReminders } from "@/integrations/reminders";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  try {
    const reminders = await listReminders();
    return Response.json(
      { reminders: reminders.map(({ id, at, label, text }) => ({ id, at, label, text })) },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return Response.json({ reminders: [] }, { headers: { "Cache-Control": "no-store" } });
  }
}
