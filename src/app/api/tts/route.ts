/**
 * /api/tts — 文章を ElevenLabs の声（MP3）にして返す（GET: ストリーミング再生用 / POST）。
 * 合言葉ロックの内側（proxy で保護）。API キーはサーバー側でのみ使用する。
 */
import { MAX_TTS_CHARS, synthesize, TtsError } from "@/voice/elevenlabs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function respond(req: Request, raw: unknown): Promise<Response> {
  const text = typeof raw === "string" ? raw.trim().slice(0, MAX_TTS_CHARS) : "";
  if (!text) return Response.json({ code: "BAD_REQUEST", message: "読み上げる文章がありません。", fatal: false }, { status: 400 });

  try {
    const audio = await synthesize(text, req.signal);
    return new Response(audio, { headers: { "Content-Type": "audio/mpeg", "Cache-Control": "no-store" } });
  } catch (err) {
    const e = err instanceof TtsError ? err : new TtsError("TTS_UPSTREAM", "音声を作れませんでした。", 500, false);
    return Response.json({ code: e.code, message: e.message, fatal: e.fatal }, { status: e.status });
  }
}

/** GET /api/tts?text=... — <audio> 要素で届いた端から再生（ストリーミング再生）するための入口 */
export async function GET(req: Request): Promise<Response> {
  return respond(req, new URL(req.url).searchParams.get("text"));
}

export async function POST(req: Request): Promise<Response> {
  let text: unknown;
  try {
    text = ((await req.json()) as { text?: unknown }).text;
  } catch {
    /* noop */
  }
  return respond(req, text);
}
