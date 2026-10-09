/**
 * Ollama（PC で動くローカル AI）の接続。Ollama の API（/api/chat・/api/tags）を使う。
 * サーバーでも画面（ブラウザ）でも動く（fetch だけ。依存なし）。
 *
 * - つなぎ先はこの PC の中（localhost / 127.0.0.1 / ::1）だけ。外部の URL は既定に戻す
 * - 返事は少しずつ受け取る（stream）。「考える」処理は止める（think: false。止められないモデルなら付けずに送り直す）
 * - keep_alive 30m（30 分はモデルをメモリに置いたままにして、次の返事を速く）、num_ctx 2048、num_predict は呼ぶ側が決める
 * - friday-fast のようにモデル自身に指示（SYSTEM）が入っているモデルには、FRIDAY 側の指示を送らない
 * - 失敗は「起動していない・接続が許可されていない」「時間切れ」「モデル未導入」「そのほか」に分けて知らせる
 */
import type { AIChunk, AIProvider, AIRequest } from "./provider";
import { isLoopbackUrl, ThinkFilter } from "./local-util";

export const DEFAULT_OLLAMA_URL = "http://localhost:11434";
export const DEFAULT_OLLAMA_MODEL = "qwen3:0.6b";
export const OLLAMA_KEEP_ALIVE = "30m";
export const OLLAMA_NUM_CTX = 2048;
/** 最初の文字が届くまで待てる時間（モデルの読み込みを含む） */
export const OLLAMA_FIRST_TOKEN_MS = 45_000;

export interface OllamaConfig {
  baseUrl: string;
  model: string;
  /** 返事の長さの上限（トークン数） */
  numPredict: number;
  numCtx?: number;
  keepAlive?: string;
  /** 答える前に考えるか（既定は考えない） */
  thinking?: boolean;
  /** 最初の文字が届くまで待てる時間（ミリ秒） */
  firstTokenMs?: number;
}

export type OllamaErrorCode = "OLLAMA_UNAVAILABLE" | "OLLAMA_TIMEOUT" | "OLLAMA_NO_MODEL" | "OLLAMA_ERROR";

export class OllamaError extends Error {
  constructor(
    public readonly code: OllamaErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "OllamaError";
  }
}

/** 設定の URL を整える（外部の URL・壊れた URL なら既定の localhost に戻す。末尾の /api などは取る） */
export function normalizeOllamaUrl(raw: string | undefined | null): string {
  const url = (raw ?? "").trim().replace(/\/+$/, "").replace(/\/api(\/chat)?$/, "");
  if (!url || !isLoopbackUrl(url)) return DEFAULT_OLLAMA_URL;
  return url;
}

/** モデル自身に指示（SYSTEM）が入っていて、FRIDAY 側の指示を送らないモデルか */
export function usesOwnSystem(model: string): boolean {
  return /^friday-fast(:|$)/i.test(model.trim());
}

/** インストール済みのモデルの一覧（つながらなければ null） */
export async function listOllamaModels(baseUrl: string, signal?: AbortSignal): Promise<string[] | null> {
  try {
    const res = await fetch(`${baseUrl}/api/tags`, { signal, cache: "no-store" });
    if (!res.ok) return null;
    const json = (await res.json()) as { models?: { name?: string; model?: string }[] };
    return (json.models ?? []).map((m) => m.name || m.model || "").filter(Boolean);
  } catch {
    return null;
  }
}

/** モデル名が一覧にあるか（"qwen3:0.6b" と "qwen3:0.6b" / "friday-fast" と "friday-fast:latest" を同じとみなす） */
export function hasModel(models: string[], model: string): boolean {
  const norm = (m: string) => (m.includes(":") ? m : `${m}:latest`).toLowerCase();
  return models.some((m) => norm(m) === norm(model));
}

const NOT_FOUND = /not found|try pulling|no such model/i;
const NO_THINK = /does not support think|thinking is not supported|unknown field.*think|invalid.*think/i;

/** 返事を少しずつ受け取る（Ollama の /api/chat。1 行に 1 つの JSON が届く） */
export async function* streamOllama(config: OllamaConfig, req: AIRequest): AsyncGenerator<AIChunk> {
  const model = config.model || DEFAULT_OLLAMA_MODEL;
  const own = usesOwnSystem(model);
  const messages = [
    ...(own || !req.system.trim() ? [] : [{ role: "system", content: req.system }]),
    ...req.messages.map((m) => ({ role: m.role, content: m.content })),
  ];
  // 最初の文字が届くまでの時間切れ（ユーザーが止めたのとは区別する）
  const timeout = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    timeout.abort();
  }, config.firstTokenMs ?? OLLAMA_FIRST_TOKEN_MS);
  const onAbort = () => timeout.abort();
  req.signal?.addEventListener("abort", onAbort);
  const send = (withThink: boolean) =>
    fetch(`${config.baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages,
        stream: true,
        ...(withThink ? { think: config.thinking === true } : {}),
        keep_alive: config.keepAlive ?? OLLAMA_KEEP_ALIVE,
        options: { num_ctx: config.numCtx ?? OLLAMA_NUM_CTX, num_predict: config.numPredict, ...(req.temperature !== undefined ? { temperature: req.temperature } : {}) },
      }),
      signal: timeout.signal,
    });
  const fail = (err: unknown): never => {
    if (req.signal?.aborted) throw err;
    if (timedOut) throw new OllamaError("OLLAMA_TIMEOUT", "ローカル AI（Ollama）の返事が時間内に届きませんでした。");
    if (err instanceof OllamaError) throw err;
    throw new OllamaError("OLLAMA_UNAVAILABLE", "ローカル AI（Ollama）に接続できません。");
  };
  try {
    let res: Response;
    try {
      res = await send(true);
      if (res.status === 400) {
        const detail = await res.clone().text().catch(() => "");
        if (NO_THINK.test(detail)) res = await send(false); // 「考える」を止められないモデル
      }
    } catch (err) {
      return fail(err);
    }
    if (!res.ok || !res.body) {
      const detail = await res.text().catch(() => "");
      let message = "";
      try {
        message = (JSON.parse(detail) as { error?: string }).error ?? "";
      } catch {
        message = detail;
      }
      if (res.status === 404 || NOT_FOUND.test(message)) {
        throw new OllamaError("OLLAMA_NO_MODEL", `モデル「${model}」が Ollama に入っていません（ollama pull ${model} で入れられます）。`);
      }
      if (res.status === 403) throw new OllamaError("OLLAMA_UNAVAILABLE", "Ollama が FRIDAY からの接続を許可していません（OLLAMA_ORIGINS の設定が必要です）。");
      throw new OllamaError("OLLAMA_ERROR", `ローカル AI（Ollama）がエラーを返しました（${res.status}）。`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    const think = new ThinkFilter();
    let buf = "";
    let first = true;
    let finishReason: string | undefined;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          let json: { model?: string; message?: { content?: string }; done?: boolean; done_reason?: string; error?: string };
          try {
            json = JSON.parse(line);
          } catch {
            continue; // 壊れた行は無視
          }
          if (json.error) {
            throw NOT_FOUND.test(json.error)
              ? new OllamaError("OLLAMA_NO_MODEL", `モデル「${model}」が Ollama に入っていません（ollama pull ${model} で入れられます）。`)
              : new OllamaError("OLLAMA_ERROR", `ローカル AI（Ollama）がエラーを返しました：${json.error.slice(0, 120)}`);
          }
          if (first) clearTimeout(timer); // 返事が始まったら時間切れにしない
          // 「考える」を止めていても、考えた文が本文に混ざるモデルがあるので取り除く
          const text = think.push(json.message?.content ?? "");
          if (json.done) finishReason = json.done_reason === "length" ? "MAX_TOKENS" : "STOP";
          if (text || first) {
            yield first ? { text, model: json.model || model } : { text };
            first = false;
          }
        }
      }
    } catch (err) {
      return fail(err);
    }
    const rest = think.flush();
    if (rest) yield { text: rest };
    yield { text: "", finishReason: finishReason ?? "STOP" };
  } finally {
    clearTimeout(timer);
    req.signal?.removeEventListener("abort", onAbort);
  }
}

export function ollamaProvider(config: OllamaConfig): AIProvider {
  return {
    id: "ollama",
    label: "LOCAL AI (Ollama)",
    async check(signal) {
      const models = await listOllamaModels(config.baseUrl, signal);
      return Boolean(models && hasModel(models, config.model || DEFAULT_OLLAMA_MODEL));
    },
    stream: (req) => streamOllama(config, req),
  };
}
