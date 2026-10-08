/**
 * サーバー側の AI Provider と、Gemini が使えないときの切り替え（サーバーが PC の上で動いているときだけ）。
 * Vercel 上では Gemini だけを使い、使えなければエラーを画面に返す（画面の AI Router が LM Studio に切り替える）。
 */
import { getGeminiConfig, serverLocalAi } from "@/lib/config";
import { FridayError, toFridayError } from "@/lib/errors";
import { checkGemini } from "./health";
import { streamGemini, type GeminiChunk } from "./gemini";
import { LMStudioError, lmStudioProvider, streamLMStudio } from "./lmstudio";
import { shouldFallback, type AIChunk, type AIProvider, type AIRequest } from "./provider";

export const geminiProvider: AIProvider = {
  id: "gemini",
  label: "Gemini",
  async check() {
    return (await checkGemini()) === null;
  },
  async *stream(req: AIRequest) {
    yield* streamGemini({
      config: { ...getGeminiConfig(), ...(req.maxTokens ? { maxOutputTokens: req.maxTokens } : {}) },
      systemInstruction: req.system,
      contents: req.messages.map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] })),
      signal: req.signal,
    });
  },
};

/** サーバーから使えるローカル AI（PC 上で動かしているときだけ。Vercel では null） */
export function serverLocalProvider(): AIProvider | null {
  const config = serverLocalAi();
  return config ? lmStudioProvider(config) : null;
}

/** 画面に出すローカル AI のモデル名 */
export const localModelLabel = (model: string | undefined) => `LOCAL AI${model ? ` (${model})` : ""}`;

/**
 * まず Gemini で答え、まだ一文字も返していないうちに接続できない・枠切れなどで失敗したら、
 * 同じ system prompt と会話のまま LM Studio で答え直す（サーバーが PC の上で動いているときだけ）。
 */
export async function* withLocalFallback(gemini: AsyncIterable<GeminiChunk>, local: () => AIRequest): AsyncGenerator<GeminiChunk | AIChunk> {
  let started = false;
  try {
    for await (const chunk of gemini) {
      if (chunk.text) started = true;
      yield chunk;
    }
  } catch (err) {
    const e = toFridayError(err);
    const config = serverLocalAi();
    const req = local();
    if (started || !config || req.signal?.aborted || !shouldFallback(e.code)) throw err;
    console.warn(`[friday] Gemini unavailable (${e.code}) → LM Studio`);
    try {
      for await (const chunk of streamLMStudio(config, req)) yield chunk.model ? { ...chunk, model: localModelLabel(chunk.model) } : chunk;
    } catch (localErr) {
      if (req.signal?.aborted) throw localErr;
      const why = localErr instanceof LMStudioError ? localErr.message : "ローカル AI も使えませんでした。";
      throw new FridayError(e.code, `${e.message}（${why}）`, e.status, e.retryable);
    }
  }
}
