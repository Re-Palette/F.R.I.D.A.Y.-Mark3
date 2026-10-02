/**
 * POST /api/focus — 集中モードの記録を脳（Obsidian）の「FRIDAY/集中ログ.md」に書き足す
 *   { task, minutes, startedAt, completed } → { ok }
 */
import { appendFocusLog } from "@/integrations/brain-notes";
import { isBrainConfigured } from "@/memory/github-brain";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  if (!isBrainConfigured()) return Response.json({ ok: false, error: "脳（Obsidian）が接続されていません。" }, { status: 503 });
  const b = (await req.json().catch(() => null)) as { task?: unknown; minutes?: unknown; startedAt?: unknown; completed?: unknown } | null;
  const minutes = Number(b?.minutes);
  const startedAt = Number(b?.startedAt);
  if (!Number.isFinite(minutes) || minutes <= 0 || !Number.isFinite(startedAt)) return Response.json({ ok: false, error: "記録の形が正しくありません。" }, { status: 400 });
  try {
    await appendFocusLog({ task: typeof b?.task === "string" ? b.task.slice(0, 60) : "", minutes: Math.min(600, Math.round(minutes)), startedAt, completed: b?.completed === true });
    return Response.json({ ok: true });
  } catch (err) {
    return Response.json({ ok: false, error: err instanceof Error ? err.message : "記録できませんでした。" }, { status: 502 });
  }
}
