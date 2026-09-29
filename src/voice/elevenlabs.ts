/**
 * ElevenLabs 音声合成（サーバー専用）。API キーはここでのみ使い、ブラウザには渡さない。
 */
import { peekAppSettings } from "@/integrations/settings";
import { getTtsConfig, settingsHint, type TtsConfig } from "@/lib/config";

export const MAX_TTS_CHARS = 1000;

export class TtsError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
    /** true なら以後このセッションでは ElevenLabs を使わない（キー誤り・枠切れなど） */
    public readonly fatal: boolean,
  ) {
    super(message);
  }
}

export function isTtsConfigured(config: TtsConfig = getTtsConfig()): boolean {
  return Boolean(config.apiKey && config.voiceId);
}

async function mapError(res: Response): Promise<TtsError> {
  let status = "";
  let detail = "";
  try {
    const json = (await res.json()) as { detail?: { status?: string; message?: string } | string };
    if (typeof json.detail === "string") detail = json.detail;
    else {
      status = json.detail?.status ?? "";
      detail = json.detail?.message ?? "";
    }
  } catch {
    /* noop */
  }
  const text = `${status} ${detail}`;

  if (/quota|credit|limit/i.test(text) || res.status === 402) {
    return new TtsError("TTS_QUOTA", "ElevenLabs の利用枠を使い切りました。ブラウザの声で読み上げます。", 429, true);
  }
  if (res.status === 429) {
    return new TtsError("TTS_RATE_LIMITED", "ElevenLabs が混雑しています。", 429, false);
  }
  if (res.status === 401 || res.status === 403 || /api.?key|unauthori|permission/i.test(text)) {
    return new TtsError(
      "TTS_INVALID_KEY",
      `ElevenLabs の API キーが無効か、権限が足りません。${settingsHint("ELEVENLABS_API_KEY")}`,
      401,
      true,
    );
  }
  if (res.status === 404 || /voice/i.test(text)) {
    return new TtsError(
      "TTS_VOICE_NOT_FOUND",
      `ElevenLabs の声（Voice ID）が見つからないか、API から使えない声です。${settingsHint("ELEVENLABS_VOICE_ID")}`,
      404,
      true,
    );
  }
  return new TtsError("TTS_UPSTREAM", `ElevenLabs でエラーが発生しました（${res.status}）。`, 502, false);
}

/** 声ごとの設定（安定度など）。速さだけ上書きするために保持する */
let voiceSettings: { key: string; value: Record<string, unknown> } | undefined;
/** 速さ指定を受け付けなかった（モデル / 声が非対応） */
let speedRejected = false;

async function loadVoiceSettings(config: TtsConfig): Promise<Record<string, unknown>> {
  const key = `${config.apiKey}::${config.voiceId}`;
  if (voiceSettings?.key === key) return voiceSettings.value;
  let value: Record<string, unknown> = {};
  try {
    const res = await fetch(`${config.baseUrl}/v1/voices/${encodeURIComponent(config.voiceId!)}/settings`, {
      headers: { "xi-api-key": config.apiKey! },
      signal: AbortSignal.timeout(4000),
      cache: "no-store",
    });
    if (res.ok) value = ((await res.json()) as Record<string, unknown>) ?? {};
  } catch {
    /* 取れなければ速さだけ指定する */
  }
  voiceSettings = { key, value };
  return value;
}

/** 文章を音声（MP3）のストリームにする */
export async function synthesize(text: string, signal?: AbortSignal): Promise<ReadableStream<Uint8Array>> {
  // 画面の SETTINGS で変えた速さがあればそちらを使う
  const base = getTtsConfig();
  const config = { ...base, speed: peekAppSettings().voiceSpeed ?? base.speed };
  if (!isTtsConfigured(config)) {
    throw new TtsError("TTS_NOT_CONFIGURED", "ElevenLabs が設定されていません。", 503, true);
  }
  const url = `${config.baseUrl}/v1/text-to-speech/${encodeURIComponent(config.voiceId!)}/stream?output_format=mp3_44100_128`;
  const send = async (withSpeed: boolean) => {
    const body: Record<string, unknown> = { text, model_id: config.model };
    if (withSpeed && config.speed !== 1) {
      body.voice_settings = { ...(await loadVoiceSettings(config)), speed: config.speed };
    }
    try {
      return await fetch(url, {
        method: "POST",
        headers: { "xi-api-key": config.apiKey!, "Content-Type": "application/json", Accept: "audio/mpeg" },
        body: JSON.stringify(body),
        signal,
        cache: "no-store",
      });
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") throw err;
      throw new TtsError("TTS_NETWORK", "ElevenLabs に接続できませんでした。", 503, false);
    }
  };

  let res = await send(!speedRejected);
  // 速さ指定が原因で拒否されたら、指定なしで送り直し、以後は指定しない
  if ((res.status === 400 || res.status === 422) && !speedRejected && config.speed !== 1) {
    await res.body?.cancel().catch(() => {});
    speedRejected = true;
    res = await send(false);
  }
  if (!res.ok || !res.body) throw await mapError(res);
  return res.body;
}

let lastWarm = 0;

/** 聞き取り中に呼び、ElevenLabs への接続を事前に確立しておく（音声は生成しない） */
export function warmTts(): void {
  const config = getTtsConfig();
  if (!isTtsConfigured(config) || Date.now() - lastWarm < 2500) return;
  lastWarm = Date.now();
  void loadVoiceSettings(config);
  void fetch(`${config.baseUrl}/v1/voices/${encodeURIComponent(config.voiceId!)}`, {
    headers: { "xi-api-key": config.apiKey! },
    signal: AbortSignal.timeout(4000),
    cache: "no-store",
  })
    .then((r) => r.body?.cancel())
    .catch(() => {});
}

/* ---------- 設定の確認（キャッシュ付き） ---------- */

let cache: { key: string; at: number; error: TtsError | null } | undefined;

/** Voice ID と API キーを確認する（音声は生成しないので利用枠を消費しない） */
export async function checkTts(): Promise<TtsError | null> {
  const config = getTtsConfig();
  if (!isTtsConfigured(config)) return new TtsError("TTS_NOT_CONFIGURED", "ElevenLabs が設定されていません。", 503, true);
  const key = `${config.apiKey}::${config.voiceId}::${config.baseUrl}`;
  if (cache && cache.key === key && Date.now() - cache.at < (cache.error ? 15_000 : 5 * 60_000)) return cache.error;

  let error: TtsError | null = null;
  try {
    const res = await fetch(`${config.baseUrl}/v1/voices/${encodeURIComponent(config.voiceId!)}`, {
      headers: { "xi-api-key": config.apiKey! },
      signal: AbortSignal.timeout(8000),
      cache: "no-store",
    });
    if (res.ok) await res.body?.cancel().catch(() => {});
    else error = await mapError(res);
  } catch {
    error = new TtsError("TTS_NETWORK", "ElevenLabs に接続できませんでした。", 503, false);
  }
  cache = { key, at: Date.now(), error };
  return error;
}
