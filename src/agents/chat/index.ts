/**
 * Chat Agent — 会話担当（Gemini Flash 系）。
 * 自然な日常会話・相談・雑談を低コスト・高速に処理する。
 */
import type { Agent, AgentContext, AgentOutputChunk } from "@/agents/types";
import { getGeminiConfig, settingsHint } from "@/lib/config";
import { streamGemini, type GeminiContent } from "@/llm/gemini";
import type { MemoryRecord } from "@/memory/long-term";
import { buildSystemInstruction } from "./persona";

/** 脳から思い出すのに待てる時間。間に合わなければ記憶なしで返答する（返答の速さ優先） */
const RECALL_BUDGET_MS = { text: 1500, voice: 700 };

async function recallWithin(ctx: AgentContext, query: string): Promise<MemoryRecord[]> {
  if (!ctx.memory.connected) return [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<MemoryRecord[]>((resolve) => {
    timer = setTimeout(() => resolve([]), ctx.voice ? RECALL_BUDGET_MS.voice : RECALL_BUDGET_MS.text);
  });
  const recall = ctx.memory.recall(query, ctx.messages).catch((err) => {
    console.warn("[friday] recall failed:", err instanceof Error ? err.message : err);
    return [] as MemoryRecord[];
  });
  try {
    return await Promise.race([recall, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export const chatAgent: Agent = {
  id: "chat",

  describe() {
    const config = getGeminiConfig();
    return config.apiKey
      ? { model: config.model, ready: true }
      : { model: config.model, ready: false, reason: `Gemini API キーが設定されていません。${settingsHint("GEMINI_API_KEY")}` };
  },

  async *run(ctx: AgentContext): AsyncIterable<AgentOutputChunk> {
    const config = getGeminiConfig();
    const latest = ctx.messages[ctx.messages.length - 1]?.content ?? "";

    // 長期記憶: Obsidian の脳から関係するノートを思い出す（時間切れなら記憶なし）
    const memories = await recallWithin(ctx, latest);

    const contents: GeminiContent[] = ctx.messages.map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }],
    }));

    // 音声会話は「最初の一言の速さ」優先: 考える量を最小にし、返答も短く
    const runConfig = ctx.voice
      ? { ...config, thinkingLevel: "minimal" as const, maxOutputTokens: Math.min(config.maxOutputTokens, 400) }
      : config;

    yield* streamGemini({
      config: runConfig,
      systemInstruction: buildSystemInstruction({
        now: ctx.now,
        timezone: ctx.timezone,
        memories,
        memoryConnected: ctx.memory.connected,
        voice: ctx.voice,
      }),
      contents,
      signal: ctx.signal,
    });
  },
};
