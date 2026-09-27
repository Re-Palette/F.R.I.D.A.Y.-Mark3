/**
 * F.R.I.D.A.Y. Core — 依頼を受け取り、Router で Agent を選び、結果をストリームで返す。
 *
 *   ユーザー → Core → Router → Agent（Chat / Search / ...）→ Core → ユーザー
 */
import type { ChatMessage, StreamEvent } from "@/core/types";
import { routeRequest } from "@/core/router";
import { getContextConfig, getGeminiConfig, getTimezone } from "@/lib/config";
import { FridayError, toFridayError } from "@/lib/errors";
import { buildConversationWindow } from "@/memory/context";
import { getLongTermMemory } from "@/memory/long-term";

export const MAX_MESSAGE_CHARS = 16000;
const MAX_HISTORY_ITEMS = 400;

/** クライアントから来た履歴を検証・正規化する */
export function sanitizeHistory(input: unknown): ChatMessage[] {
  if (!Array.isArray(input)) {
    throw new FridayError("BAD_REQUEST", "messages が不正です。", 400);
  }
  const messages = input
    .slice(-MAX_HISTORY_ITEMS)
    .filter(
      (m): m is ChatMessage =>
        !!m &&
        typeof m === "object" &&
        (m.role === "user" || m.role === "assistant") &&
        typeof m.content === "string" &&
        m.content.trim().length > 0,
    )
    .map((m) => ({ role: m.role, content: m.content.slice(0, MAX_MESSAGE_CHARS) }));

  if (messages.length === 0 || messages[messages.length - 1].role !== "user") {
    throw new FridayError("BAD_REQUEST", "送信するメッセージがありません。", 400);
  }
  return messages;
}

/** 事前チェック（ストリーム開始前に HTTP ステータスで返したいエラー） */
export function preflight(): void {
  if (!getGeminiConfig().apiKey) {
    throw new FridayError(
      "MISSING_API_KEY",
      "Gemini API キーが設定されていません。.env.local に GEMINI_API_KEY を設定してサーバーを再起動してください。",
      503,
    );
  }
}

export async function* handleConversation(
  history: ChatMessage[],
  signal?: AbortSignal,
): AsyncGenerator<StreamEvent> {
  try {
    const window = buildConversationWindow(history, getContextConfig());
    const agent = await routeRequest(window.messages);

    const meta = {
      type: "meta" as const,
      agent: agent.id,
      model: agent.describe().model,
      contextMessages: window.messages.length,
    };
    yield meta;

    let finishReason: string | undefined;
    for await (const chunk of agent.run({
      messages: window.messages,
      memory: getLongTermMemory(),
      now: new Date(),
      timezone: getTimezone(),
      signal,
    })) {
      // 候補の先頭以外に自動で切り替わった場合は、実際のモデル名を知らせ直す
      if (chunk.model && chunk.model !== meta.model) yield { ...meta, model: chunk.model };
      if (chunk.text) yield { type: "delta", text: chunk.text };
      if (chunk.finishReason) finishReason = chunk.finishReason;
    }
    yield { type: "done", finishReason };
  } catch (err) {
    if (signal?.aborted) return;
    const e = toFridayError(err);
    if (e.code === "UNKNOWN") console.error("[friday] conversation error:", err);
    yield { type: "error", code: e.code, message: e.message, retryable: e.retryable };
  }
}
