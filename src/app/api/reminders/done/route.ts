/**
 * POST /api/reminders/done — 知らせたリマインダーを完了（[x]）にする。
 */
import { markReminderDone } from "@/integrations/reminders";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as { id?: unknown };
  if (typeof body.id !== "string" || !/^[0-9a-f]{12}$/.test(body.id)) return Response.json({ ok: false }, { status: 400 });
  try {
    return Response.json({ ok: await markReminderDone(body.id) });
  } catch {
    return Response.json({ ok: false }, { status: 502 });
  }
}
