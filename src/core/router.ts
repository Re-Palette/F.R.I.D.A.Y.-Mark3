/**
 * Agent Router — ユーザーの依頼内容から担当 Agent を決める。
 *
 * Phase 1 では Chat Agent しか存在しないため、常に "chat" を返す。
 * トリガーワードに依存しない設計にするため、将来は軽量な分類モデル
 * （Gemini Flash による intent 判定など）でここを置き換える想定。
 */
import type { Agent } from "@/agents/types";
import type { AgentId, ChatMessage } from "@/core/types";
import { chatAgent } from "@/agents/chat";

const registry: Partial<Record<AgentId, Agent>> = {
  chat: chatAgent,
  // search: searchAgent,   ← 将来ここに登録するだけで Router から呼べるようになる
};

export function getAgent(id: AgentId): Agent | undefined {
  return registry[id];
}

export function listAgents(): Agent[] {
  return Object.values(registry).filter((a): a is Agent => Boolean(a));
}

export async function routeRequest(_messages: ChatMessage[]): Promise<Agent> {
  return chatAgent;
}
