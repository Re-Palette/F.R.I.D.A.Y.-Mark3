/**
 * POST /api/lecture/summary — 授業の文字起こしから、まとめを作る
 *   { subject, transcript, minutes } → { ok, summary }
 * 文字起こしはまとめを作るためだけに使い、保存しない（保存は画面側のブラウザの中だけ）。
 */
import { MAX_TRANSCRIPT, summarizeLecture } from "@/integrations/lecture";
import { toFridayError } from "@/lib/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req: Request): Promise<Response> {
  const body = (await req.json().catch(() => null)) as { subject?: unknown; transcript?: unknown; minutes?: unknown; date?: unknown } | null;
  const transcript = typeof body?.transcript === "string" ? body.transcript.trim() : "";
  if (transcript.length < 20) {
    return Response.json({ ok: false, error: "文字起こしが短すぎて、まとめられません。" }, { status: 400 });
  }
  const subject = typeof body?.subject === "string" ? body.subject.trim().slice(0, 60) : "";
  const minutes = typeof body?.minutes === "number" && Number.isFinite(body.minutes) ? Math.min(600, Math.max(0, body.minutes)) : 0;
  const headers = { "Cache-Control": "no-store" };
  try {
    // 長すぎるときは最後の方を残す（授業の終わりの課題・連絡を落とさないように、前半を少し削る）
    const text = transcript.length > MAX_TRANSCRIPT ? `（前半の一部を省略）\n${transcript.slice(-MAX_TRANSCRIPT)}` : transcript;
    // 授業の日付（締め切りの「来週まで」などを日付に直すため）
    const date = typeof body?.date === "string" && /^\d{4}-\d{2}-\d{2}/.test(body.date) ? body.date.slice(0, 10) : undefined;
    return Response.json({ ok: true, summary: await summarizeLecture({ subject, transcript: text, minutes, date }) }, { headers });
  } catch (err) {
    const message = err instanceof Error && err.message.includes("まとめ") ? err.message : toFridayError(err).message;
    return Response.json({ ok: false, error: message }, { status: 502, headers });
  }
}
