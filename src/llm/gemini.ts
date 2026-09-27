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
  /** 実際に応答したモデル（最初のチャンクにだけ付く） */
  model?: string;
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
  if (res.status === 503 || status === "UNAVAILABLE") {
    return new FridayError(
      "UPSTREAM_ERROR",
      "Gemini が混雑しています。数秒おいてからもう一度話しかけてください。",
      503,
      true,
    );
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

async function request(opts: GeminiStreamOptions, model: string, withThinking: boolean): Promise<Response> {
  const { config } = opts;
  const url = `${config.baseUrl}/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`;
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

/** thinkingConfig を受け付けないと分かったモデル（毎回 400 → 再送にならないよう記憶） */
const noThinkingModels = new Set<string>();

/** 一時的な障害（混雑・瞬断）とみなしてよいか */
const isTransient = (status: number) => status === 500 || status === 502 || status === 503 || status === 504;

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
      },
      { once: true },
    );
  });

const MAX_ATTEMPTS = 3;

/**
 * 一時的に使えないモデル（無料枠の使い切りなど）。期限まではスキップして次の候補を使う。
 * 未提供（404）のモデルはプロセスが続く限りスキップする。
 */
const unavailableUntil = new Map<string, number>();
const RATE_LIMIT_COOLDOWN = 10 * 60_000;

function isAvailable(model: string): boolean {
  const until = unavailableUntil.get(model);
  if (until === undefined) return true;
  if (Date.now() >= until) {
    unavailableUntil.delete(model);
    return true;
  }
  return false;
}

/**
 * 1 つのモデルでストリームを開始する。本文を読み始める前なので、ここでの再試行はユーザーに見えない。
 *  - 混雑 (5xx) や瞬断は短い間隔で自動再試行
 *  - thinkingLevel 非対応モデルは設定を外して再送し、以後は外したまま送る
 */
async function connectModel(opts: GeminiStreamOptions, model: string): Promise<Response> {
  let withThinking = Boolean(opts.config.thinkingLevel) && !noThinkingModels.has(model);

  for (let attempt = 1; ; attempt++) {
    let res: Response;
    try {
      res = await request(opts, model, withThinking);
    } catch (err) {
      if (err instanceof FridayError && err.retryable && attempt < MAX_ATTEMPTS) {
        await sleep(350 * attempt, opts.signal);
        continue;
      }
      throw err;
    }
    if (res.ok) return res;

    if (isTransient(res.status) && attempt < MAX_ATTEMPTS) {
      await res.body?.cancel().catch(() => {});
      await sleep(500 * attempt, opts.signal);
      continue;
    }

    const err = await mapHttpError(res, model);
    if (withThinking && isThinkingConfigError(err)) {
      noThinkingModels.add(model);
      withThinking = false;
      continue;
    }
    throw err;
  }
}

/**
 * 候補モデルを優先順に試す。使い切り（429）や未提供（404）なら次の候補へ自動で切り替える。
 */
async function connect(opts: GeminiStreamOptions): Promise<{ res: Response; model: string }> {
  const candidates = opts.config.models.filter(isAvailable);
  // すべて使えない状態なら、念のため全候補をもう一度試す
  const order = candidates.length ? candidates : opts.config.models;
  let lastError: FridayError | undefined;

  for (const model of order) {
    try {
      return { res: await connectModel(opts, model), model };
    } catch (err) {
      if (!(err instanceof FridayError)) throw err;
      if (err.code === "RATE_LIMITED") {
        unavailableUntil.set(model, Date.now() + RATE_LIMIT_COOLDOWN);
      } else if (err.code === "MODEL_NOT_FOUND") {
        unavailableUntil.set(model, Number.POSITIVE_INFINITY);
      } else {
        throw err;
      }
      lastError = err;
    }
  }

  if (lastError?.code === "RATE_LIMITED") {
    throw new FridayError(
      "RATE_LIMITED",
      "今日の無料枠を使い切りました。日本時間の夕方（16〜17時ごろ）にリセットされます。",
      429,
      true,
    );
  }
  throw new FridayError(
    "MODEL_NOT_FOUND",
    `利用できるモデルが見つかりません（${opts.config.models.join(", ")}）。GEMINI_MODEL を確認してください。`,
    404,
  );
}

/**
 * 軽量な接続確認（models.get）。生成は行わないのでトークンを消費しない。
 * API キー・モデル名の検証と、TLS 接続の事前確立（ウォームアップ）を兼ねる。
 */
export async function pingGemini(config: GeminiConfig, signal?: AbortSignal): Promise<FridayError | null> {
  if (!config.apiKey) {
    return new FridayError("MISSING_API_KEY", "Gemini API キーが設定されていません。", 503);
  }
  let lastError: FridayError | null = null;
  for (const model of config.models) {
    try {
      const res = await fetch(`${config.baseUrl}/models/${encodeURIComponent(model)}`, {
        headers: { "x-goog-api-key": config.apiKey },
        signal,
        cache: "no-store",
      });
      if (res.ok) {
        await res.body?.cancel().catch(() => {});
        return null;
      }
      lastError = await mapHttpError(res, model);
      // キーの問題はどのモデルでも同じなので打ち切る
      if (lastError.code !== "MODEL_NOT_FOUND") return lastError;
    } catch {
      return new FridayError("NETWORK_ERROR", "Gemini に接続できませんでした。", 503, true);
    }
  }
  return config.models.length > 1
    ? new FridayError(
        "MODEL_NOT_FOUND",
        `利用できるモデルが見つかりません（${config.models.join(", ")}）。GEMINI_MODEL を確認してください。`,
        404,
      )
    : lastError;
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

  const { res, model } = await connect(opts);
  let modelReported = false;
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
        if (!modelReported) {
          chunk.model = model;
          modelReported = true;
        }
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
