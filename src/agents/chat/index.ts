/**
 * Chat Agent — 会話担当（Gemini Flash 系）。
 * 自然な日常会話・相談・雑談を低コスト・高速に処理する。
 */
import type { Agent, AgentContext, AgentOutputChunk } from "@/agents/types";
import { getGeminiConfig, settingsHint } from "@/lib/config";
import { streamGemini, type GeminiContent } from "@/llm/gemini";
import type { CalendarEvent } from "@/integrations/google-calendar";
import type { MemoryRecord } from "@/memory/long-term";
import { buildSystemInstruction } from "./persona";

/** 脳・カレンダーから情報を集めるのに待てる時間。間に合わなければ無しで返答する（返答の速さ優先） */
const CONTEXT_BUDGET_MS = { text: 1500, voice: 700 };

/** 時間内に終わらなければ fallback を返す（失敗も fallback） */
async function within<T>(task: Promise<T>, ms: number, fallback: T, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  const safe = task.catch((err) => {
    console.warn(`[friday] ${label} failed:`, err instanceof Error ? err.message : err);
    return fallback;
  });
  try {
    return await Promise.race([safe, timeout]);
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

    // 長期記憶（Obsidian の脳）と今後の予定（Google カレンダー）を同時に集める。時間切れなら無しで返答
    const budget = ctx.voice ? CONTEXT_BUDGET_MS.voice : CONTEXT_BUDGET_MS.text;
    const [memories, events] = await Promise.all([
      ctx.memory.connected ? within(ctx.memory.recall(latest, ctx.messages), budget, [] as MemoryRecord[], "recall") : [],
      ctx.calendar ? within<CalendarEvent[] | null>(ctx.calendar.upcoming(7), budget, null, "calendar") : null,
    ]);

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
        calendar: ctx.calendar ? { connected: true, events } : { connected: false },
        voice: ctx.voice,
      }),
      contents,
      signal: ctx.signal,
    });
  },
};
