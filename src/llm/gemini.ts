/**
 * Gemini API クライアント（REST + SSE ストリーミング）。
 * SDK を入れずに fetch だけで実装し、依存を最小にしている。
 * どの Agent からも使える汎用レイヤー。Agent 固有の知識はここに置かない。
 */
import { FridayError } from "@/lib/errors";
import type { GeminiConfig } from "@/lib/config";

export interface GeminiContent {
  role: "user" | "model";
  parts: { text: string }[];
}

export interface GeminiStreamOptions {
  config: GeminiConfig;
  systemInstruction?: string;
  contents: GeminiContent[];
  signal?: AbortSignal;
}

export interface GeminiChunk {
  text: string;
  finishReason?: string;
}

interface GeminiResponsePart {
  text?: string;
  thought?: boolean;
}

interface GeminiStreamResponse {
  candidates?: {
    content?: { parts?: GeminiResponsePart[] };
    finishReason?: string;
  }[];
  promptFeedback?: { blockReason?: string };
  error?: { code?: number; message?: string; status?: string };
}

function buildBody(opts: GeminiStreamOptions, withThinking: boolean) {
  const { config } = opts;
  const generationConfig: Record<string, unknown> = {
    temperature: config.temperature,
    maxOutputTokens: config.maxOutputTokens,
  };
  if (withThinking && config.thinkingLevel) {
    generationConfig.thinkingConfig = { thinkingLevel: config.thinkingLevel };
  }
  return JSON.stringify({
    ...(opts.systemInstruction
      ? { systemInstruction: { parts: [{ text: opts.systemInstruction }] } }
      : {}),
    contents: opts.contents,
    generationConfig,
  });
}

async function mapHttpError(res: Response, model: string): Promise<FridayError> {
  let detail = "";
  let status = "";
  try {
    const json = (await res.json()) as GeminiStreamResponse | GeminiStreamResponse[];
    const err = Array.isArray(json) ? json[0]?.error : json.error;
    detail = err?.message ?? "";
    status = err?.status ?? "";
  } catch {
    /* body が JSON でない場合は無視 */
  }

  if (res.status === 429 || status === "RESOURCE_EXHAUSTED") {
    return new FridayError(
      "RATE_LIMITED",
      "Gemini のレート制限に達しました。少し時間をおいてから話しかけてください。",
      429,
      true,
    );
  }
  if (
    res.status === 401 ||
    res.status === 403 ||
    /API key not valid|API_KEY_INVALID|permission/i.test(detail)
  ) {
    return new FridayError(
      "INVALID_API_KEY",
      "Gemini API キーが無効か、権限がありません。.env.local の GEMINI_API_KEY を確認してください。",
      401,
    );
  }
  if (res.status === 404) {
    return new FridayError(
      "MODEL_NOT_FOUND",
      `モデル「${model}」が見つかりません。.env.local の GEMINI_MODEL を確認してください。`,
      404,
    );
  }
  if (res.status === 400) {
    return new FridayError("BAD_REQUEST", `Gemini がリクエストを拒否しました: ${detail || "400 Bad Request"}`, 400);
  }
  return new FridayError(
    "UPSTREAM_ERROR",
    `Gemini 側でエラーが発生しました（${res.status}）。少し待ってから再試行してください。`,
    502,
    true,
  );
}

/** thinkingConfig 非対応モデルで 400 が返った場合に判定する */
function isThinkingConfigError(err: FridayError): boolean {
  return err.code === "BAD_REQUEST" && /thinking/i.test(err.message);
}

async function request(opts: GeminiStreamOptions, withThinking: boolean): Promise<Response> {
  const { config } = opts;
  const url = `${config.baseUrl}/models/${encodeURIComponent(config.model)}:streamGenerateContent?alt=sse`;
  try {
    return await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": config.apiKey ?? "",
      },
      body: buildBody(opts, withThinking),
      signal: opts.signal,
      cache: "no-store",
    });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") throw err;
    throw new FridayError(
      "NETWORK_ERROR",
      "Gemini に接続できませんでした。ネットワーク接続を確認してください。",
      503,
      true,
    );
  }
}

/**
 * Gemini からのテキストを生成順に yield する。
 * 最初のトークンまでの時間を最小にするため、SSE をそのまま逐次パースする。
 */
export async function* streamGemini(opts: GeminiStreamOptions): AsyncGenerator<GeminiChunk> {
  if (!opts.config.apiKey) {
    throw new FridayError(
      "MISSING_API_KEY",
      "Gemini API キーが設定されていません。.env.local に GEMINI_API_KEY を設定してサーバーを再起動してください。",
      503,
    );
  }

  let res = await request(opts, true);
  if (!res.ok) {
    const err = await mapHttpError(res, opts.config.model);
    // モデルが thinkingLevel 非対応なら、設定を外して一度だけ再試行
    if (opts.config.thinkingLevel && isThinkingConfigError(err)) {
      res = await request(opts, false);
      if (!res.ok) throw await mapHttpError(res, opts.config.model);
    } else {
      throw err;
    }
  }
  if (!res.body) {
    throw new FridayError("UPSTREAM_ERROR", "Gemini から空のレスポンスが返りました。", 502, true);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let producedText = false;

  const handleEvent = (raw: string): GeminiChunk | null => {
    const data = raw
      .split(/\r?\n/)
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trimStart())
      .join("\n");
    if (!data) return null;

    let json: GeminiStreamResponse;
    try {
      json = JSON.parse(data) as GeminiStreamResponse;
    } catch {
      return null;
    }
    if (json.error) {
      throw new FridayError(
        json.error.code === 429 ? "RATE_LIMITED" : "UPSTREAM_ERROR",
        json.error.code === 429
          ? "Gemini のレート制限に達しました。少し時間をおいてから話しかけてください。"
          : "Gemini の応答中にエラーが発生しました。もう一度試してください。",
        502,
        true,
      );
    }
    if (json.promptFeedback?.blockReason) {
      throw new FridayError(
        "SAFETY_BLOCKED",
        "この内容は Gemini の安全フィルターによりブロックされました。言い方を変えて試してください。",
        400,
      );
    }
    const candidate = json.candidates?.[0];
    const text =
      candidate?.content?.parts
        ?.filter((p) => !p.thought && typeof p.text === "string")
        .map((p) => p.text)
        .join("") ?? "";
    const finishReason = candidate?.finishReason;
    if (!text && !finishReason) return null;
    return { text, finishReason };
  };

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let sep: RegExpExecArray | null;
      const boundary = /\r?\n\r?\n/;
      while ((sep = boundary.exec(buffer))) {
        const rawEvent = buffer.slice(0, sep.index);
        buffer = buffer.slice(sep.index + sep[0].length);
        const chunk = handleEvent(rawEvent);
        if (!chunk) continue;
        if (chunk.text) producedText = true;
        if (chunk.finishReason === "SAFETY" && !producedText) {
          throw new FridayError(
            "SAFETY_BLOCKED",
            "この内容は Gemini の安全フィルターによりブロックされました。言い方を変えて試してください。",
            400,
          );
        }
        yield chunk;
      }
    }
    const tail = buffer.trim() ? handleEvent(buffer) : null;
    if (tail) yield tail;
  } finally {
    // 途中で中断された場合も上流の接続を確実に閉じる（完了済みなら何もしない）
    await reader.cancel().catch(() => {});
  }
}
