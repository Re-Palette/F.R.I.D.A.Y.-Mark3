/**
 * ローカル AI（この PC で動く AI）の設定と、使う先（Ollama / LM Studio）の切り替え。画面側で動く。
 *
 *   SETTINGS で選んだ設定（この端末だけ・オフラインでも変えられる）
 *     engine      … "ollama"（既定）/ "lmstudio"
 *     ollamaModel … Ollama のモデル（既定 qwen3:0.6b）
 *     model       … LM Studio のモデル（空なら読み込み中のモデル）
 *     replyLength … 短い会話の返事の長さ（num_predict。60 = 短い（既定）/ 120 = 普通）
 *     quickLocal  … 短い日常会話をローカル AI で答えるか（既定オン）
 *     thinking    … 答える前に考えるか（既定オフ）
 *
 * ローカル AI に FRIDAY のツール（記憶・ToDo・予定など）を実行する権限は渡さない。
 * オフライン時の保留（端末に溜めて、オンラインに戻ったらサーバーの Core が実行する）は offline-core が受け持つ。
 */
import { DEFAULT_LM_STUDIO_URL, LMStudioError, listLMStudioModels, normalizeLMStudioUrl, pickLMStudioModel, streamLMStudio } from "@/llm/lmstudio";
import { DEFAULT_OLLAMA_MODEL, DEFAULT_OLLAMA_URL, hasModel, listOllamaModels, normalizeOllamaUrl, OllamaError, streamOllama } from "@/llm/ollama";
import type { AIChunk, AIRequest } from "@/llm/provider";

export type LocalEngine = "ollama" | "lmstudio";
export type ReplyLength = 60 | 120;

export interface LocalAiPrefs {
  engine: LocalEngine;
  /** LM Studio のモデル（空なら読み込み中のモデル） */
  model: string;
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
/** サーバーの環境変数（LM_STUDIO_* / OLLAMA_*）から届いた接続先 */
const SERVER_KEY = "friday.localai.v1";

export const DEFAULT_PREFS: LocalAiPrefs = { engine: "ollama", model: "", ollamaModel: DEFAULT_OLLAMA_MODEL, replyLength: 60, quickLocal: true, thinking: false };

export function localAiPrefs(): LocalAiPrefs {
  try {
    const raw = JSON.parse(localStorage.getItem(PREFS_KEY) ?? "null") as Partial<LocalAiPrefs> | null;
    return {
      engine: raw?.engine === "lmstudio" ? "lmstudio" : "ollama",
      model: typeof raw?.model === "string" ? raw.model : "",
      ollamaModel: typeof raw?.ollamaModel === "string" && raw.ollamaModel ? raw.ollamaModel : DEFAULT_OLLAMA_MODEL,
      replyLength: raw?.replyLength === 120 ? 120 : 60,
      quickLocal: raw?.quickLocal !== false,
      thinking: raw?.thinking === true,
    };
  } catch {
    return { ...DEFAULT_PREFS };
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
  baseUrl?: string;
  model?: string;
  ollamaBaseUrl?: string;
}

function serverLocal(): ServerLocal {
  try {
    return (JSON.parse(localStorage.getItem(SERVER_KEY) ?? "null") as ServerLocal | null) ?? {};
  } catch {
    return {};
  }
}

/** サーバーの設定（/api/ai/health）を覚えておく（オフラインでも使えるように） */
export function rememberLocalAiConfig(cfg: { baseUrl?: string; model?: string; ollamaBaseUrl?: string }): void {
  try {
    const prev = serverLocal();
    localStorage.setItem(
      SERVER_KEY,
      JSON.stringify({
        baseUrl: normalizeLMStudioUrl(cfg.baseUrl ?? prev.baseUrl),
        model: cfg.model ?? prev.model ?? "",
        ollamaBaseUrl: normalizeOllamaUrl(cfg.ollamaBaseUrl ?? prev.ollamaBaseUrl),
      }),
    );
  } catch {
    /* noop */
  }
}

export interface LocalAiConfig {
  engine: LocalEngine;
  baseUrl: string;
  model: string;
  thinking: boolean;
  replyLength: ReplyLength;
}

/** いま使うローカル AI の接続先とモデル */
export function localAiConfig(): LocalAiConfig {
  const prefs = localAiPrefs();
  const server = serverLocal();
  return prefs.engine === "lmstudio"
    ? { engine: "lmstudio", baseUrl: normalizeLMStudioUrl(server.baseUrl ?? DEFAULT_LM_STUDIO_URL), model: prefs.model || server.model || "", thinking: prefs.thinking, replyLength: prefs.replyLength }
    : { engine: "ollama", baseUrl: normalizeOllamaUrl(server.ollamaBaseUrl ?? DEFAULT_OLLAMA_URL), model: prefs.ollamaModel, thinking: prefs.thinking, replyLength: prefs.replyLength };
}

export const engineLabel = (engine: LocalEngine) => (engine === "ollama" ? "Ollama" : "LM Studio");

/** 使えるモデルの一覧（つながらなければ null） */
export function localAiModels(signal?: AbortSignal): Promise<string[] | null> {
  const cfg = localAiConfig();
  return cfg.engine === "ollama" ? listOllamaModels(cfg.baseUrl, signal) : listLMStudioModels(cfg.baseUrl, signal);
}

export type LocalAiProblem = "unavailable" | "no-model" | "timeout" | "error";

/** ローカル AI が使えるか（使うモデル名も返す） */
export async function checkLocalAi(signal?: AbortSignal): Promise<{ ok: boolean; model?: string; problem?: LocalAiProblem }> {
  const cfg = localAiConfig();
  if (cfg.engine === "ollama") {
    const models = await listOllamaModels(cfg.baseUrl, signal);
    if (!models) return { ok: false, problem: "unavailable" };
    return hasModel(models, cfg.model) ? { ok: true, model: cfg.model } : { ok: false, model: cfg.model, problem: "no-model" };
  }
  if (cfg.model) return (await listLMStudioModels(cfg.baseUrl, signal)) ? { ok: true, model: cfg.model } : { ok: false, problem: "unavailable" };
  const model = await pickLMStudioModel(cfg.baseUrl, signal);
  return model ? { ok: true, model } : { ok: false, problem: model === null ? "unavailable" : "no-model" };
}

/**
 * ローカル AI で返事を作る（使う先は設定どおり）。
 * maxTokens は LM Studio の上限、numPredict は Ollama の上限（省略時は設定の返事の長さ）。
 */
export function streamLocal(req: AIRequest & { numPredict?: number }, cfg: LocalAiConfig = localAiConfig()): AsyncGenerator<AIChunk> {
  return cfg.engine === "ollama"
    ? streamOllama({ baseUrl: cfg.baseUrl, model: cfg.model, numPredict: req.numPredict ?? cfg.replyLength, thinking: cfg.thinking }, req)
    : streamLMStudio({ baseUrl: cfg.baseUrl, model: cfg.model, thinking: cfg.thinking }, req);
}

/** 失敗がローカル AI 側のもの（届かない・モデル未導入・時間切れなど）か */
export function isLocalAiError(err: unknown): err is OllamaError | LMStudioError {
  return err instanceof OllamaError || err instanceof LMStudioError;
}

/** 届かない・モデルが無いときの直し方（画面に出す） */
export function localAiHelp(engine: LocalEngine = localAiConfig().engine, problem: LocalAiProblem = "unavailable"): string {
  if (engine === "ollama") {
    if (problem === "no-model") return `設定のモデルが Ollama に入っていません。PC で「ollama pull ${localAiConfig().model}」を実行するか、SETTINGS → LOCAL AI で入っているモデルを選んでください。`;
    const origin = typeof location !== "undefined" ? location.origin : "（FRIDAY のアドレス）";
    return `① Ollama が起動しているか（タスクトレイのラマのアイコン）　② 環境変数 OLLAMA_ORIGINS に「${origin}」を設定して Ollama を再起動したか　③ Chrome に「ローカル ネットワークへのアクセス」を許可したか（FRIDAY の画面上部の鍵のマーク → サイトの設定）を確かめてください。`;
  }
  return "① LM Studio の「ローカルモデルAPI」でサーバーが ON か　② 同じ画面の「CORS を有効にする」が ON か　③ Chrome に「このデバイス上の他のアプリ（ローカル ネットワーク）へのアクセス」を許可したか（FRIDAY の画面上部の鍵のマーク → サイトの設定 → ローカル ネットワークへのアクセス を「許可」）を確かめてください。";
}

/**
 * ローカル AI に届くか、届かないなら理由を調べる（SETTINGS の「試す」用）。
 *   blocked: すぐ失敗した（起動していない・接続が許可されていない）
 *   waiting: 返事が無い（Chrome の許可の確認を待っている・固まっている）
 *   no-model: 設定のモデルが入っていない
 */
export async function diagnoseLocalAi(): Promise<{ ok: true; models: string[] } | { ok: false; reason: "blocked" | "waiting" | "http" | "no-model"; message: string }> {
  const cfg = localAiConfig();
  const name = engineLabel(cfg.engine);
  const url = cfg.engine === "ollama" ? `${cfg.baseUrl}/api/tags` : `${cfg.baseUrl}/models`;
  try {
    const res = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(8000) });
    if (!res.ok) return { ok: false, reason: "http", message: `${name} がエラーを返しました（${res.status}）。${res.status === 403 ? localAiHelp(cfg.engine) : ""}` };
    const json = (await res.json()) as { data?: { id?: string }[]; models?: { name?: string }[] };
    const models = cfg.engine === "ollama" ? (json.models ?? []).map((m) => m.name ?? "").filter(Boolean) : (json.data ?? []).map((m) => m.id ?? "").filter(Boolean);
    if (cfg.engine === "ollama" && !hasModel(models, cfg.model)) return { ok: false, reason: "no-model", message: localAiHelp("ollama", "no-model") };
    return { ok: true, models };
  } catch (err) {
    if (err instanceof DOMException && err.name === "TimeoutError") {
      return { ok: false, reason: "waiting", message: `${name}（${cfg.baseUrl}）から返事がありません。Chrome が「アクセスを許可しますか」と聞いていないか、画面の上部を確認してください。${localAiHelp(cfg.engine)}` };
    }
    return { ok: false, reason: "blocked", message: `${name}（${cfg.baseUrl}）に接続できません。${localAiHelp(cfg.engine)}` };
  }
}

/** ローカル AI の失敗を、画面に出す分かりやすい文にする */
export function describeLocalAiError(err: unknown, engine: LocalEngine = localAiConfig().engine): string {
  if (err instanceof OllamaError) {
    if (err.code === "OLLAMA_UNAVAILABLE") return `${err.message}${localAiHelp("ollama")}`;
    if (err.code === "OLLAMA_NO_MODEL") return `${err.message} SETTINGS → LOCAL AI で入っているモデルを選べます。`;
    if (err.code === "OLLAMA_TIMEOUT") return `${err.message} 初回はモデルの読み込みに時間がかかります。もう一度試すか、より小さいモデル（qwen3:0.6b）を選んでください。`;
    return err.message;
  }
  if (err instanceof LMStudioError) return `${err.message}${err.code === "LOCAL_AI_UNAVAILABLE" ? localAiHelp("lmstudio") : ""}`;
  return `ローカル AI（${engineLabel(engine)}）で答えられませんでした。`;
}
