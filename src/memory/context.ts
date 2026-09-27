/**
 * 短期記憶（現在の会話コンテキスト）。
 *
 * セッション中の会話履歴から「今 Gemini に渡す分」だけを切り出す。
 * 履歴を無制限に送らないよう、件数と文字数の両方で上限をかける。
 * 長期記憶（./long-term.ts）とは完全に分離している。
 */
import type { ChatMessage } from "@/core/types";
import type { ContextConfig } from "@/lib/config";

export interface ConversationWindow {
  messages: ChatMessage[];
  /** 上限により切り捨てられた古いメッセージ数（将来の要約・Memory Agent 用） */
  dropped: number;
}

export function buildConversationWindow(
  history: ChatMessage[],
  { maxMessages, maxChars }: ContextConfig,
): ConversationWindow {
  const picked: ChatMessage[] = [];
  let chars = 0;

  // 新しい方から詰めていく。最新のユーザー発言は必ず含める。
  for (let i = history.length - 1; i >= 0; i--) {
    const msg = history[i];
    const len = msg.content.length;
    if (picked.length > 0 && (picked.length >= maxMessages || chars + len > maxChars)) break;
    picked.unshift(msg);
    chars += len;
  }

  // Gemini は user から始まる会話を前提にするので、先頭の assistant は落とす
  while (picked.length > 1 && picked[0].role !== "user") picked.shift();

  return { messages: picked, dropped: history.length - picked.length };
}
