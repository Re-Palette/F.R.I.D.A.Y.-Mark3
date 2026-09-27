/**
 * POST /api/tts — 文章を ElevenLabs の声（MP3）にして返す。
 * 合言葉ロックの内側（proxy で保護）。API キーはサーバー側でのみ使用する。
 */
import { MAX_TTS_CHARS, synthesize, TtsError } from "@/voice/elevenlabs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  let text = "";
  try {
    const body = (await req.json()) as { text?: unknown };
    text = typeof body.text === "string" ? body.text.trim().slice(0, MAX_TTS_CHARS) : "";
  } catch {
    /* noop */
  }
  if (!text) return Response.json({ code: "BAD_REQUEST", message: "読み上げる文章がありません。", fatal: false }, { status: 400 });

  try {
    const audio = await synthesize(text, req.signal);
    return new Response(audio, { headers: { "Content-Type": "audio/mpeg", "Cache-Control": "no-store" } });
  } catch (err) {
    const e = err instanceof TtsError ? err : new TtsError("TTS_UPSTREAM", "音声を作れませんでした。", 500, false);
    return Response.json({ code: e.code, message: e.message, fatal: e.fatal }, { status: e.status });
  }
}
