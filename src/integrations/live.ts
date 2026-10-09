/**
 * リアルタイム音声会話（Gemini Live API）の準備。サーバー側だけで使う。
 *   - Gemini API キーは渡さず、使い捨ての鍵（1 回だけ・数分で切れる）を作って画面に渡す
 *   - 使える Live 用のモデルを Google に聞いて選ぶ（名前が変わっても動くように）
 *   - 予定・天気・ToDo などを最初の指示にまとめる（会話の途中では取りに行かない＝待たせない）
 * 声は画面と Google の間で直接やりとりし、このサーバーには届かない（保存もしない）。
 */
import { getGeminiConfig } from "@/lib/config";
import { buildCompactInstruction } from "@/agents/chat/persona";
import type { CalendarEvent } from "@/integrations/google-calendar";
import type { TasksOverview } from "@/integrations/tasks";
import type { Reminder } from "@/integrations/reminders";
import { weatherSummary, type WeatherReport } from "@/integrations/weather";

/** 使い捨ての鍵で新しい会話を始められる時間 */
const NEW_SESSION_MS = 2 * 60_000;
/** 1 回の会話を続けられる時間 */
const SESSION_MS = 30 * 60_000;
/** モデル一覧を聞き直す間隔 */
const MODELS_TTL_MS = 60 * 60_000;

let modelCache: { at: number; model: string | null } | null = null;

export interface LiveModelInfo {
  name: string;
  supportedGenerationMethods?: string[];
}

/**
 * Live 用のモデルを選ぶ。声のまま答えるモデル（native audio / live）を優先し、文字起こし専用・音楽用は除く。
 * 同じ種類なら新しい（版の数字が大きい）ものを選ぶ。
 */
export function pickLiveModel(models: LiveModelInfo[]): string | null {
  const usable = models
    .filter((m) => m.supportedGenerationMethods?.includes("bidiGenerateContent"))
    .map((m) => m.name.replace(/^models\//, ""))
    .filter((n) => !/transcri|music|lyria|tts|image|embed/i.test(n));
  if (!usable.length) return null;
  const version = (n: string) => Number(n.match(/(\d+(?:\.\d+)?)/)?.[1] ?? 0);
  const score = (n: string) => (/native-audio|live/i.test(n) ? 1000 : 0) + version(n) * 10 + (/preview|exp/i.test(n) ? 0 : 1) - (/lite/i.test(n) ? 0.5 : 0);
  return [...usable].sort((a, b) => score(b) - score(a))[0];
}

async function liveModel(signal?: AbortSignal): Promise<string> {
  const fixed = process.env.GEMINI_LIVE_MODEL?.trim();
  if (fixed) return fixed.replace(/^models\//, "");
  if (modelCache && Date.now() - modelCache.at < MODELS_TTL_MS && modelCache.model) return modelCache.model;
  const config = getGeminiConfig();
  const res = await fetch(`${config.baseUrl}/models?pageSize=1000`, { headers: { "x-goog-api-key": config.apiKey ?? "" }, signal });
  if (!res.ok) throw new Error(`models ${res.status}`);
  const json = (await res.json()) as { models?: LiveModelInfo[] };
  const model = pickLiveModel(json.models ?? []);
  modelCache = { at: Date.now(), model };
  if (!model) throw new Error("リアルタイム会話に使えるモデルが見つかりませんでした。");
  return model;
}

/** API の入り口（https://generativelanguage.googleapis.com）。テストでは差し替えられる */
function apiOrigin(): string {
  return new URL(getGeminiConfig().baseUrl).origin;
}

/** 使い捨ての鍵を作る（1 回だけ使える。始められるのは 2 分以内、会話は 30 分まで） */
async function createToken(signal?: AbortSignal): Promise<string> {
  const config = getGeminiConfig();
  const now = Date.now();
  const res = await fetch(`${apiOrigin()}/v1alpha/auth_tokens`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": config.apiKey ?? "" },
    body: JSON.stringify({
      uses: 1,
      expireTime: new Date(now + SESSION_MS).toISOString(),
      newSessionExpireTime: new Date(now + NEW_SESSION_MS).toISOString(),
    }),
    signal,
  });
  if (!res.ok) throw new Error(`auth_tokens ${res.status}`);
  const json = (await res.json()) as { name?: string };
  if (!json.name) throw new Error("auth_tokens: no name");
  return json.name;
}

export interface LiveContext {
  now: Date;
  timezone: string;
  events: CalendarEvent[] | null;
  tasks: TasksOverview | null;
  reminders: Reminder[] | null;
  weather: WeatherReport | null;
  /** 直近の会話（古い順。続きとして話せるように） */
  recent: { role: "user" | "assistant"; content: string }[];
}

/** リアルタイム会話の最初の指示 */
export function buildLiveInstruction(ctx: LiveContext): string {
  // 文字の会話用の短い指示から、画面にしか出せない隠しタグの説明を除いて使う
  const base = buildCompactInstruction({
    now: ctx.now,
    timezone: ctx.timezone,
    voice: true,
    tasks: ctx.tasks,
    reminders: ctx.reminders,
    events: ctx.events,
    recallMark: null,
  }).split("\n\n# 隠しタグ")[0];
  let out = base;
  if (ctx.weather) out += `\n\n# 天気\n${weatherSummary(ctx.weather)}`;
  if (ctx.recent.length) {
    out += `\n\n# 直前までの会話（この続きとして話す）\n${ctx.recent
      .map((m) => `${m.role === "user" ? "ユーザー" : "あなた"}: ${m.content.replace(/\s+/g, " ").slice(0, 300)}`)
      .join("\n")}`;
  }
  out += `

# リアルタイム音声会話
- いまは声だけで会話している。返事はすぐ・短く（1〜2 文）。前置き（「承知しました」など）は付けない。
- 日本語の自然な話し言葉で、落ち着いた秘書の声で話す。
- 予定・天気・ToDo は上の情報から答える。上に無い最新情報は、Google 検索が使えるときは調べて答え、使えなければ「分からない」と正直に言う。
- メールの下書き・予定の追加や変更・ToDo の追加・ファイルの作成のような操作は、ここではできない。頼まれたら「画面の入力欄で頼んでください」と短く伝える。`;
  return out;
}

export interface LiveSetup {
  /** 画面がつなぐ WebSocket の宛先（使い捨ての鍵入り） */
  url: string;
  model: string;
  systemInstruction: string;
  voiceName: string | null;
}

export async function prepareLive(ctx: LiveContext, signal?: AbortSignal): Promise<LiveSetup> {
  const [token, model] = await Promise.all([createToken(signal), liveModel(signal)]);
  const ws = apiOrigin().replace(/^http/, "ws");
  return {
    url: `${ws}/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContentConstrained?access_token=${encodeURIComponent(token)}`,
    model,
    systemInstruction: buildLiveInstruction(ctx),
    voiceName: process.env.GEMINI_LIVE_VOICE?.trim() || null,
  };
}
