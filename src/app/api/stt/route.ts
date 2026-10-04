/**
 * POST /api/stt — スマホの音声会話の文字起こし
 *   { audio: base64, mimeType: "audio/wav" } → { ok, text }
 * 音声は文字にするためだけに使い、保存しない。
 */
import { MAX_AUDIO_CHARS, transcribe } from "@/integrations/stt";
import { toFridayError } from "@/lib/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function POST(req: Request): Promise<Response> {
  const headers = { "Cache-Control": "no-store" };
  const body = (await req.json().catch(() => null)) as { audio?: unknown; mimeType?: unknown } | null;
  const audio = typeof body?.audio === "string" ? body.audio : "";
  const mimeType = typeof body?.mimeType === "string" && /^audio\/[\w.+-]+$/.test(body.mimeType) ? body.mimeType : "audio/wav";
  if (!audio || audio.length > MAX_AUDIO_CHARS || !/^[A-Za-z0-9+/=]+$/.test(audio.slice(0, 200))) {
    return Response.json({ ok: false, error: "音声が空か、長すぎます。" }, { status: 400, headers });
  }
  try {
    return Response.json({ ok: true, text: await transcribe(audio, mimeType, req.signal) }, { headers });
  } catch (err) {
    return Response.json({ ok: false, error: toFridayError(err).message }, { status: 502, headers });
  }
}
