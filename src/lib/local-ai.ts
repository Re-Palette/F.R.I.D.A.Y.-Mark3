/**
 * ローカル AI（この PC で動く AI）の設定と接続。ローカル AI は Ollama だけを使う。画面側で動く。
 *
 *   SETTINGS で選んだ設定（この端末だけ・オフラインでも変えられる）
 *     ollamaModel … Ollama のモデル（既定 qwen3:0.6b）
 *     replyLength … 短い会話の返事の長さ（num_predict。60 = 短い（既定）/ 120 = 普通）
 *     quickLocal  … 短い日常会話をローカル AI で答えるか（既定オン）
 *     thinking    … 答える前に考えるか（既定オフ）
 *
 * ローカル AI に FRIDAY のツール（記憶・ToDo・予定など）を実行する権限は渡さない。
 * オフライン時の保留（端末に溜めて、オンラインに戻ったらサーバーの Core が実行する）は offline-core が受け持つ。
 */
import { DEFAULT_OLLAMA_MODEL, DEFAULT_OLLAMA_URL, hasModel, listOllamaModels, normalizeOllamaUrl, OllamaError, streamOllama } from "@/llm/ollama";
import type { AIChunk, AIRequest } from "@/llm/provider";

export type ReplyLength = 60 | 120;

export interface LocalAiPrefs {
  /** Ollama のモデル */
  ollamaModel: string;
  /** 短い会話の返事の長さ（Ollama の num_predict） */
  replyLength: ReplyLength;
  /** 短い日常会話をローカル AI で答えるか */
  quickLocal: boolean;
  /** 答える前に考えるか（既定はオフ＝速い） */
  thinking: boolean;
}

const PREFS_KEY = "friday.localai.prefs.v1";
/** サーバーの環境変数（OLLAMA_BASE_URL / OLLAMA_MODEL）から届いた接続先 */
const SERVER_KEY = "friday.localai.v1";

export const LOCAL_AI_NAME = "Ollama";

export const DEFAULT_PREFS: LocalAiPrefs = { ollamaModel: DEFAULT_OLLAMA_MODEL, replyLength: 60, quickLocal: true, thinking: false };

/** 保存してある設定を読む（以前の版で保存した項目＝使う先・LM Studio のモデルなどは読み飛ばす） */
export function localAiPrefs(): LocalAiPrefs {
  try {
    const raw = JSON.parse(localStorage.getItem(PREFS_KEY) ?? "null") as Partial<LocalAiPrefs> | null;
    return {
      ollamaModel: typeof raw?.ollamaModel === "string" && raw.ollamaModel ? raw.ollamaModel : defaultModel(),
      replyLength: raw?.replyLength === 120 ? 120 : 60,
      quickLocal: raw?.quickLocal !== false,
      thinking: raw?.thinking === true,
    };
  } catch {
    return { ...DEFAULT_PREFS, ollamaModel: defaultModel() };
  }
}

export function saveLocalAiPrefs(prefs: LocalAiPrefs): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    /* noop */
  }
}

interface ServerLocal {
  ollamaBaseUrl?: string;
  ollamaModel?: string;
}

function serverLocal(): ServerLocal {
  try {
    return (JSON.parse(localStorage.getItem(SERVER_KEY) ?? "null") as ServerLocal | null) ?? {};
  } catch {
    return {};
  }
}

/** SETTINGS で選んでいないときのモデル（サーバーの OLLAMA_MODEL → qwen3:0.6b） */
function defaultModel(): string {
  return serverLocal().ollamaModel || DEFAULT_OLLAMA_MODEL;
}

/** サーバーの設定（/api/ai/health）を覚えておく（オフラインでも使えるように） */
export function rememberLocalAiConfig(cfg: { ollamaBaseUrl?: string; ollamaModel?: string }): void {
  try {
    const prev = serverLocal();
    localStorage.setItem(
      SERVER_KEY,
      JSON.stringify({ ollamaBaseUrl: normalizeOllamaUrl(cfg.ollamaBaseUrl ?? prev.ollamaBaseUrl), ollamaModel: cfg.ollamaModel ?? prev.ollamaModel ?? "" }),
    );
  } catch {
    /* noop */
  }
}

export interface LocalAiConfig {
  baseUrl: string;
  model: string;
  thinking: boolean;
  replyLength: ReplyLength;
}

/** いま使うローカル AI（Ollama）の接続先とモデル */
export function localAiConfig(): LocalAiConfig {
  const prefs = localAiPrefs();
  return { baseUrl: normalizeOllamaUrl(serverLocal().ollamaBaseUrl ?? DEFAULT_OLLAMA_URL), model: prefs.ollamaModel, thinking: prefs.thinking, replyLength: prefs.replyLength };
}

/** Ollama に入っているモデルの一覧（つながらなければ null） */
export function localAiModels(signal?: AbortSignal): Promise<string[] | null> {
  return listOllamaModels(localAiConfig().baseUrl, signal);
}

export type LocalAiProblem = "unavailable" | "no-model" | "timeout" | "error";

/** ローカル AI が使えるか（使うモデル名も返す） */
export async function checkLocalAi(signal?: AbortSignal): Promise<{ ok: boolean; model?: string; problem?: LocalAiProblem }> {
  const cfg = localAiConfig();
  const models = await listOllamaModels(cfg.baseUrl, signal);
  if (!models) return { ok: false, problem: "unavailable" };
  return hasModel(models, cfg.model) ? { ok: true, model: cfg.model } : { ok: false, model: cfg.model, problem: "no-model" };
}

/**
 * ローカル AI（Ollama）で返事を作る。numPredict は返事の長さの上限（省略時は設定の短い会話の長さ）。
 * maxTokens は共通の形（AIRequest）の項目で、Ollama では numPredict を使う。
 */
export function streamLocal(req: AIRequest & { numPredict?: number }, cfg: LocalAiConfig = localAiConfig()): AsyncGenerator<AIChunk> {
  return streamOllama({ baseUrl: cfg.baseUrl, model: cfg.model, numPredict: req.numPredict ?? cfg.replyLength, thinking: cfg.thinking }, req);
}

/** 失敗がローカル AI 側のもの（届かない・モデル未導入・時間切れなど）か */
export function isLocalAiError(err: unknown): err is OllamaError {
  return err instanceof OllamaError;
}

/** 届かない・モデルが無いときの直し方（画面に出す） */
export function localAiHelp(problem: LocalAiProblem = "unavailable"): string {
  if (problem === "no-model") return `設定のモデルが Ollama に入っていません。PC で「ollama pull ${localAiConfig().model}」を実行するか、SETTINGS → LOCAL AI で入っているモデルを選んでください。`;
  const origin = typeof location !== "undefined" ? location.origin : "（FRIDAY のアドレス）";
  return `① Ollama が起動しているか（タスクトレイのラマのアイコン）　② 環境変数 OLLAMA_ORIGINS に「${origin}」を設定して Ollama を再起動したか　③ Chrome に「ローカル ネットワークへのアクセス」を許可したか（FRIDAY の画面上部の鍵のマーク → サイトの設定）を確かめてください。`;
}

/**
 * Ollama に届くか、届かないなら理由を調べる（SETTINGS の「接続テスト」用）。
 *   blocked: すぐ失敗した（起動していない・接続が許可されていない）
 *   waiting: 返事が無い（Chrome の許可の確認を待っている・固まっている）
 *   no-model: 設定のモデルが入っていない
 */
export async function diagnoseLocalAi(): Promise<{ ok: true; models: string[] } | { ok: false; reason: "blocked" | "waiting" | "http" | "no-model"; message: string }> {
  const cfg = localAiConfig();
  try {
    const res = await fetch(`${cfg.baseUrl}/api/tags`, { cache: "no-store", signal: AbortSignal.timeout(8000) });
    if (!res.ok) return { ok: false, reason: "http", message: `Ollama がエラーを返しました（${res.status}）。${res.status === 403 ? localAiHelp() : ""}` };
    const json = (await res.json()) as { models?: { name?: string }[] };
    const models = (json.models ?? []).map((m) => m.name ?? "").filter(Boolean);
    if (!hasModel(models, cfg.model)) return { ok: false, reason: "no-model", message: localAiHelp("no-model") };
    return { ok: true, models };
  } catch (err) {
    if (err instanceof DOMException && err.name === "TimeoutError") {
      return { ok: false, reason: "waiting", message: `Ollama（${cfg.baseUrl}）から返事がありません。Chrome が「アクセスを許可しますか」と聞いていないか、画面の上部を確認してください。${localAiHelp()}` };
    }
    return { ok: false, reason: "blocked", message: `Ollama（${cfg.baseUrl}）に接続できません。${localAiHelp()}` };
  }
}

/** ローカル AI の失敗を、画面に出す分かりやすい文にする */
export function describeLocalAiError(err: unknown): string {
  if (err instanceof OllamaError) {
    if (err.code === "OLLAMA_UNAVAILABLE") return `${err.message}${localAiHelp()}`;
    if (err.code === "OLLAMA_NO_MODEL") return `${err.message} SETTINGS → LOCAL AI で入っているモデルを選べます。`;
    if (err.code === "OLLAMA_TIMEOUT") return `${err.message} 初回はモデルの読み込みに時間がかかります。もう一度試すか、より小さいモデル（qwen3:0.6b）を選んでください。`;
    return err.message;
  }
  return "ローカル AI（Ollama）で答えられませんでした。";
}
