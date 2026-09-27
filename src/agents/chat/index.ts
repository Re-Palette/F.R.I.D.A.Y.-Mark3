/**
 * Chat Agent — 会話担当（Gemini Flash 系）。
 * 自然な日常会話・相談・雑談を低コスト・高速に処理する。
 */
import type { Agent, AgentContext, AgentOutputChunk } from "@/agents/types";
import { getGeminiConfig } from "@/lib/config";
import { streamGemini, type GeminiContent } from "@/llm/gemini";
import { buildSystemInstruction } from "./persona";

export const chatAgent: Agent = {
  id: "chat",

  describe() {
    const config = getGeminiConfig();
    return config.apiKey
      ? { model: config.model, ready: true }
      : { model: config.model, ready: false, reason: "GEMINI_API_KEY が未設定です" };
  },

  async *run(ctx: AgentContext): AsyncIterable<AgentOutputChunk> {
    const config = getGeminiConfig();
    const latest = ctx.messages[ctx.messages.length - 1]?.content ?? "";

    // 長期記憶（Phase 1 では常に空）。将来は Memory Agent / Obsidian 検索に置き換わる。
    const memories = ctx.memory.connected ? await ctx.memory.recall(latest, ctx.messages) : [];

    const contents: GeminiContent[] = ctx.messages.map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }],
    }));

    yield* streamGemini({
      config,
      systemInstruction: buildSystemInstruction({
        now: ctx.now,
        timezone: ctx.timezone,
        memories,
        memoryConnected: ctx.memory.connected,
      }),
      contents,
      signal: ctx.signal,
    });
  },
};
