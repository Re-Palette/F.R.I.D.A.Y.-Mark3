/**
 * F.R.I.D.A.Y. Core — 依頼を受け取り、Router で Agent を選び、結果をストリームで返す。
 *
 *   ユーザー → Core → Router → Agent（Chat / Search / ...）→ Core → ユーザー
 */
import type { ChatMessage, StreamEvent } from "@/core/types";
import { routeRequest } from "@/core/router";
import { getContextConfig, getGeminiConfig, getTimezone, settingsHint } from "@/lib/config";
import { FridayError, toFridayError } from "@/lib/errors";
import { buildConversationWindow } from "@/memory/context";
import { getLongTermMemory, type SaveTurnInput } from "@/memory/long-term";
import { MemoryTagFilter } from "./memory-tags";

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
      `Gemini API キーが設定されていません。${settingsHint("GEMINI_API_KEY")}`,
      503,
    );
  }
}

export async function* handleConversation(
  history: ChatMessage[],
  signal?: AbortSignal,
  options: {
    voice?: boolean;
    /** 返答が最後まで終わったら 1 往復分を渡す（脳への保存用）。失敗・中断時は null */
    onTurn?: (turn: SaveTurnInput | null) => void;
  } = {},
): AsyncGenerator<StreamEvent> {
  let turn: SaveTurnInput | null = null;
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

    const memory = getLongTermMemory();
    let finishReason: string | undefined;
    let reply = "";
    const tags = new MemoryTagFilter();
    for await (const chunk of agent.run({
      messages: window.messages,
      memory,
      now: new Date(),
      timezone: getTimezone(),
      voice: options.voice ?? false,
      signal,
    })) {
      // 候補の先頭以外に自動で切り替わった場合は、実際のモデル名を知らせ直す
      if (chunk.model && chunk.model !== meta.model) yield { ...meta, model: chunk.model };
      if (chunk.text) {
        // <memory>…</memory> は画面にも読み上げにも出さない
        const text = tags.push(chunk.text);
        if (text) {
          reply += text;
          yield { type: "delta", text };
        }
      }
      if (chunk.finishReason) finishReason = chunk.finishReason;
    }
    const rest = tags.flush();
    if (rest) {
      reply += rest;
      yield { type: "delta", text: rest };
    }
    // 脳が無い・つながらないときは保存されないので、覚えたとは表示しない（保存自体は試みる）
    if (memory.save && memory.healthy !== false) for (const text of tags.facts) yield { type: "memory", text };
    turn = {
      user: window.messages[window.messages.length - 1]?.content ?? "",
      assistant: reply.trim(),
      memories: memory.save ? tags.facts : [],
      voice: options.voice ?? false,
    };
    yield { type: "done", finishReason };
  } catch (err) {
    if (signal?.aborted) return;
    const e = toFridayError(err);
    if (e.code === "UNKNOWN") console.error("[friday] conversation error:", err);
    yield { type: "error", code: e.code, message: e.message, retryable: e.retryable };
  } finally {
    options.onTurn?.(turn);
  }
}
