/**
 * ElevenLabs 音声合成（サーバー専用）。API キーはここでのみ使い、ブラウザには渡さない。
 */
import { peekAppSettings } from "@/integrations/settings";
import { getTtsConfig, settingsHint, type TtsConfig } from "@/lib/config";
import type { Tone } from "@/lib/tone";

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
/**
 * 文の雰囲気ごとの声の微調整（ふだんは落ち着いて。感情は控えめに、少しだけにじませる）。
 *   stability … 高いほど揺れが少ない（ふだん 0.65）／ style … 感情の強調（ふだん 0）／ speed … ふだんの速さに掛ける
 */
const TONE_SETTINGS: Record<Tone, { stability: number; style: number; speed: number }> = {
  calm: { stability: 0.65, style: 0, speed: 1 },
  curious: { stability: 0.55, style: 0.1, speed: 1 },
  warm: { stability: 0.52, style: 0.15, speed: 1.02 },
  concern: { stability: 0.62, style: 0.05, speed: 0.95 },
};
/** 前の文（previous_text）を受け付けなかった（モデルが非対応） */
let prevRejected = false;

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
export async function synthesize(text: string, signal?: AbortSignal, previousText?: string, tone: Tone = "calm"): Promise<ReadableStream<Uint8Array>> {
  // 画面の SETTINGS で変えた速さがあればそちらを使う
  const base = getTtsConfig();
  const config = { ...base, speed: peekAppSettings().voiceSpeed ?? base.speed };
  if (!isTtsConfigured(config)) {
    throw new TtsError("TTS_NOT_CONFIGURED", "ElevenLabs が設定されていません。", 503, true);
  }
  const url = `${config.baseUrl}/v1/text-to-speech/${encodeURIComponent(config.voiceId!)}/stream?output_format=mp3_44100_128`;
  const send = async (withSpeed: boolean, withPrev = !prevRejected) => {
    const body: Record<string, unknown> = { text, model_id: config.model };
    // 前の文を渡すと、文ごとに分けて作った声でも抑揚がつながる（ElevenLabs の previous_text）
    if (withPrev && previousText) body.previous_text = previousText;
    // 落ち着いた秘書の声に：ふだんは感情の揺れを抑え、文の雰囲気（興味・前進・心配）に合わせて、ほんの少しだけ変える
    const vs = await loadVoiceSettings(config);
    const t = TONE_SETTINGS[tone];
    const speed = Math.min(1.2, Math.max(0.7, Math.round(config.speed * t.speed * 100) / 100));
    body.voice_settings = { ...vs, stability: t.stability, style: t.style, ...(withSpeed && speed !== 1 ? { speed } : {}) };
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
  // 前の文の指定が原因で拒否されたら、指定なしで送り直し、以後は指定しない
  if ((res.status === 400 || res.status === 422) && !prevRejected && previousText) {
    await res.body?.cancel().catch(() => {});
    res = await send(!speedRejected, false);
    if (res.ok) prevRejected = true;
  }
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

/* ---------- 残りの利用枠 ---------- */

export interface TtsQuota {
  used: number;
  limit: number;
  /** 次に枠が戻る時刻（ミリ秒） */
  resetAt?: number;
  tier?: string;
}

/** ElevenLabs の今月の利用枠（使った文字数・上限）。キーに読む権限が無いときなどは null */
export async function ttsQuota(): Promise<TtsQuota | null> {
  const config = getTtsConfig();
  if (!isTtsConfigured(config)) return null;
  const res = await fetch(`${config.baseUrl}/v1/user/subscription`, {
    headers: { "xi-api-key": config.apiKey! },
    signal: AbortSignal.timeout(5000),
    cache: "no-store",
  }).catch(() => null);
  if (!res?.ok) return null;
  const j = (await res.json().catch(() => ({}))) as { character_count?: number; character_limit?: number; next_character_count_reset_unix?: number; tier?: string };
  if (typeof j.character_count !== "number" || typeof j.character_limit !== "number") return null;
  return { used: j.character_count, limit: j.character_limit, resetAt: j.next_character_count_reset_unix ? j.next_character_count_reset_unix * 1000 : undefined, tier: j.tier };
}
