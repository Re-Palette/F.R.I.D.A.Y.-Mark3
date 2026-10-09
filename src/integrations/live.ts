/**
 * リアルタイム音声会話（Gemini Live API）の準備。サーバー側だけで使う。
 *   - Gemini API キーは渡さず、使い捨ての鍵（1 回だけ・数分で切れる）を作って画面に渡す
 *   - 使える Live 用のモデルを Google に聞いて選ぶ（名前が変わっても動くように）
 *   - 予定・天気・ToDo などを最初の指示にまとめる（会話の途中では取りに行かない＝待たせない）
 * 声は画面と Google の間で直接やりとりし、このサーバーには届かない（保存もしない）。
 */
import { getGeminiConfig } from "@/lib/config";
import { buildCompactInstruction } from "@/agents/chat/persona";
import { KAREN_SECTION } from "@/agents/chat/karen-persona";
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
  /** K.A.R.E.N.（クリエイティブ AI）として話す */
  persona?: "karen";
}

/** K.A.R.E.N. の制作・編集を画面に頼む道具の名前（画面の live-voice.ts と同じ） */
export const KAREN_TOOL = "karen_operate";
/** F.R.I.D.A.Y. の操作（予定・ToDo・メールの下書き・音楽・ページやアプリを開くなど）を頼む道具の名前（画面の live-voice.ts と同じ） */
export const FRIDAY_TOOL = "friday_action";

const FRIDAY_LIVE = `
- 次のような操作を頼まれたら、まず「入れますね」「開きますね」のように一言だけ言ってから、${FRIDAY_TOOL} を呼ぶ（request にはユーザーの頼みを、日時や名前を補って日本語の 1 文で入れる）：
  予定の追加・変更・削除、ToDo の追加・完了、リマインダー、覚えておくこと、Gmail の下書き（送信はしない）、音楽の再生・停止、Web ページやパソコンのアプリ（Spotify・Slack・Zoom など）を開く・タブを閉じる、文書づくり、ホログラム。
- ${FRIDAY_TOOL} の結果（result・done）を、1〜2 文で短く伝える。ok が false なら、うまくいかなかったことと理由を短く伝える。結果に無いことを「やりました」と言わない。
- 予定・天気・ToDo を聞かれただけのとき（操作でないとき）は、${FRIDAY_TOOL} を呼ばずに上の情報から答える。`;

const KAREN_LIVE = `

# K.A.R.E.N. のリアルタイム音声会話
- 3D モデルの制作・形の追加・色や大きさや向きや位置の変更・削除・回転・保存・書き出し・制作のキャンセルを頼まれたら、必ず ${KAREN_TOOL} を呼ぶ（request にはユーザーの頼みを日本語でそのまま入れる）。自分では作らない。
- ${KAREN_TOOL} の結果（notices）を短く伝える。started なら「制作を始めます」のように言い、「作りました」とは言わない。
- 「フライデーに戻して」などの切り替えは画面が行うので、「通常モードに戻ります」とだけ言う。`;

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
`;
  out += ctx.persona === "karen" ? KAREN_SECTION + KAREN_LIVE : FRIDAY_LIVE;
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
