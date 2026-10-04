/**
 * /api/tts — 文章を ElevenLabs の声（MP3）にして返す（GET: ストリーミング再生用 / POST）。
 * 合言葉ロックの内側（proxy で保護）。API キーはサーバー側でのみ使用する。
 */
import { withReadings } from "@/lib/reading";
import { detectTone, isTone } from "@/lib/tone";
import { MAX_TTS_CHARS, synthesize, TtsError } from "@/voice/elevenlabs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function respond(req: Request, raw: unknown, prevRaw?: unknown, toneRaw?: unknown): Promise<Response> {
  const text = typeof raw === "string" ? raw.trim().slice(0, MAX_TTS_CHARS) : "";
  if (!text) return Response.json({ code: "BAD_REQUEST", message: "読み上げる文章がありません。", fatal: false }, { status: 400 });

  try {
    // 直前に読んだ文（声の抑揚を前の文から自然につなげる）
    const prev = typeof prevRaw === "string" ? prevRaw.trim().slice(-300) : undefined;
    // 文の雰囲気（送られてこなければ文から見分ける）
    const tone = isTone(toneRaw) ? toneRaw : detectTone(text);
    // 名前の読み（陽大 → はると）は声にするときだけ置き換える
    const audio = await synthesize(withReadings(text), req.signal, prev ? withReadings(prev) : undefined, tone);
    return new Response(audio, { headers: { "Content-Type": "audio/mpeg", "Cache-Control": "no-store" } });
  } catch (err) {
    const e = err instanceof TtsError ? err : new TtsError("TTS_UPSTREAM", "音声を作れませんでした。", 500, false);
    return Response.json({ code: e.code, message: e.message, fatal: e.fatal }, { status: e.status });
  }
}

/** GET /api/tts?text=... — <audio> 要素で届いた端から再生（ストリーミング再生）するための入口 */
export async function GET(req: Request): Promise<Response> {
  const q = new URL(req.url).searchParams;
  return respond(req, q.get("text"), q.get("prev"), q.get("tone"));
}

export async function POST(req: Request): Promise<Response> {
  let body: { text?: unknown; prev?: unknown; tone?: unknown } = {};
  try {
    body = (await req.json()) as { text?: unknown; prev?: unknown; tone?: unknown };
  } catch {
    /* noop */
  }
  return respond(req, body.text, body.prev, body.tone);
}
