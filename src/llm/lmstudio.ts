/**
 * LM Studio（PC で動くローカル AI）の接続。OpenAI 互換の Local Server API（/v1/chat/completions）を使う。
 * サーバーでも画面（ブラウザ）でも動く（fetch だけ。依存なし）。
 *
 * 安全のため、つなぎ先はこの PC の中（localhost / 127.0.0.1 / ::1）だけにする。
 * LM Studio を外部に公開する設定（ネットワークに公開）は不要で、使わない。
 */
import type { AIChunk, AIProvider, AIRequest } from "./provider";

export const DEFAULT_LM_STUDIO_URL = "http://localhost:1234/v1";

export interface LMStudioConfig {
  baseUrl: string;
  /** 使うモデル。空なら LM Studio で読み込まれているモデル（一覧の最初のもの） */
  model: string;
}

/** この PC の中を指す URL か（外部の URL は使わない） */
export function isLoopbackUrl(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    return u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "[::1]" || u.hostname === "::1";
  } catch {
    return false;
  }
}

/** 設定の URL を整える（外部の URL・壊れた URL なら既定の localhost に戻す） */
export function normalizeLMStudioUrl(raw: string | undefined | null): string {
  const url = (raw ?? "").trim().replace(/\/+$/, "");
  if (!url) return DEFAULT_LM_STUDIO_URL;
  if (!isLoopbackUrl(url)) return DEFAULT_LM_STUDIO_URL;
  return /\/v1$/.test(url) ? url : `${url}/v1`;
}

const EMBEDDING = /embed|bge|e5-|nomic|minilm/i;

/** 読み込まれているモデルの一覧（つながらなければ null） */
export async function listLMStudioModels(baseUrl: string, signal?: AbortSignal): Promise<string[] | null> {
  try {
    const res = await fetch(`${baseUrl}/models`, { signal, cache: "no-store" });
    if (!res.ok) return null;
    const json = (await res.json()) as { data?: { id?: string }[] };
    return (json.data ?? []).map((m) => m.id ?? "").filter((id) => id && !EMBEDDING.test(id));
  } catch {
    return null;
  }
}

/** 考えている途中の文（<think>…</think>）を取り除く。塊の途中でタグが切れても扱える */
export class ThinkFilter {
  private inThink = false;
  private pending = "";
  push(text: string): string {
    let s = this.pending + text;
    this.pending = "";
    let out = "";
    while (s) {
      if (this.inThink) {
        const end = s.indexOf("</think>");
        if (end < 0) {
          this.pending = s.slice(-7); // 閉じタグの書きかけを残す
          return out;
        }
        s = s.slice(end + 8);
        this.inThink = false;
        continue;
      }
      const start = s.indexOf("<think>");
      if (start < 0) {
        // 開きタグの書きかけかもしれない末尾は保留
        const lt = s.lastIndexOf("<");
        if (lt >= 0 && "<think>".startsWith(s.slice(lt))) {
          out += s.slice(0, lt);
          this.pending = s.slice(lt);
        } else out += s;
        return out;
      }
      out += s.slice(0, start);
      s = s.slice(start + 7);
      this.inThink = true;
    }
    return out;
  }
  flush(): string {
    const rest = this.inThink ? "" : this.pending;
    this.pending = "";
    return rest;
  }
}

export class LMStudioError extends Error {
  constructor(
    public readonly code: "LOCAL_AI_UNAVAILABLE" | "LOCAL_AI_NO_MODEL" | "LOCAL_AI_ERROR",
    message: string,
  ) {
    super(message);
  }
}

/** 返答を少しずつ受け取る（OpenAI 互換のストリーミング） */
export async function* streamLMStudio(config: LMStudioConfig, req: AIRequest): AsyncGenerator<AIChunk> {
  let model = config.model;
  if (!model) {
    const models = await listLMStudioModels(config.baseUrl, req.signal);
    if (models === null) throw new LMStudioError("LOCAL_AI_UNAVAILABLE", "ローカル AI（LM Studio）に接続できません。");
    model = models[0] ?? "";
    if (!model) throw new LMStudioError("LOCAL_AI_NO_MODEL", "LM Studio でモデルが読み込まれていません。");
  }
  // Qwen3 系は「考える」を省いて速く答えさせる（ほかのモデルには付けない）
  const system = /qwen3/i.test(model) ? `${req.system}\n\n/no_think` : req.system;
  let res: Response;
  try {
    res = await fetch(`${config.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        stream: true,
        temperature: req.temperature ?? 0.7,
        max_tokens: req.maxTokens ?? 2048,
        messages: [{ role: "system", content: system }, ...req.messages.map((m) => ({ role: m.role, content: m.content }))],
      }),
      signal: req.signal,
    });
  } catch (err) {
    if (req.signal?.aborted) throw err;
    throw new LMStudioError("LOCAL_AI_UNAVAILABLE", "ローカル AI（LM Studio）に接続できません。");
  }
  if (!res.ok || !res.body) {
    const detail = await res.text().catch(() => "");
    throw new LMStudioError(
      /model/i.test(detail) && res.status === 404 ? "LOCAL_AI_NO_MODEL" : "LOCAL_AI_ERROR",
      `ローカル AI（LM Studio）がエラーを返しました（${res.status}）。モデルが読み込まれているか確認してください。`,
    );
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const think = new ThinkFilter();
  let buf = "";
  let first = true;
  let finishReason: string | undefined;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") continue;
      try {
        const json = JSON.parse(data) as { model?: string; choices?: { delta?: { content?: string | null }; finish_reason?: string | null }[] };
        const choice = json.choices?.[0];
        if (choice?.finish_reason) finishReason = choice.finish_reason === "length" ? "MAX_TOKENS" : "STOP";
        const text = think.push(choice?.delta?.content ?? "");
        if (text || first) {
          yield first ? { text, model: json.model || model } : { text };
          first = false;
        }
      } catch {
        /* 壊れた行は無視 */
      }
    }
  }
  const rest = think.flush();
  if (rest) yield { text: rest };
  yield { text: "", finishReason: finishReason ?? "STOP" };
}

export function lmStudioProvider(config: LMStudioConfig): AIProvider {
  return {
    id: "lmstudio",
    label: "LOCAL AI",
    async check(signal) {
      const models = await listLMStudioModels(config.baseUrl, signal);
      return Boolean(models && (config.model ? true : models.length));
    },
    stream: (req) => streamLMStudio(config, req),
  };
}
