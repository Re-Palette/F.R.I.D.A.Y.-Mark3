/**
 * Chat Agent — 会話担当（Gemini Flash 系）。
 * 自然な日常会話・相談・雑談を低コスト・高速に処理する。
 */
import type { Agent, AgentContext, AgentOutputChunk } from "@/agents/types";
import { needsSearch } from "@/agents/search/needs-search";
import { getWeather, type WeatherReport } from "@/integrations/weather";
import { readNewsSettings } from "@/integrations/news";
import { getGeminiConfig, getSearchMode, settingsHint } from "@/lib/config";
import { streamGemini, type GeminiContent } from "@/llm/gemini";
import type { CalendarEvent } from "@/integrations/google-calendar";
import type { MemoryRecord } from "@/memory/long-term";
import { buildSystemInstruction } from "./persona";

/**
 * 脳・カレンダー・天気を集めるのに待てる時間。間に合わなければ無しで返答する（返答の速さ優先）。
 * どれも前回の結果をキャッシュから即座に返すので、普段はほぼ待たない（上限は初回や障害時の保険）。
 */
const CONTEXT_BUDGET_MS = { text: 900, voice: 450 };

/** この長さ未満の普通の発言は、Gemini に考えさせる量を最小にして最初の一言を速くする */
const QUICK_REPLY_CHARS = 120;

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

    // 長期記憶（Obsidian の脳）・予定（Google カレンダー）・天気を同時に集める。時間切れなら無しで返答
    const prepStart = Date.now();
    const budget = ctx.voice ? CONTEXT_BUDGET_MS.voice : CONTEXT_BUDGET_MS.text;
    const briefing = Boolean(ctx.news?.deliver);
    const [memories, events, weather, newsSettings] = await Promise.all([
      ctx.memory.connected ? within(ctx.memory.recall(latest, ctx.messages), budget, [] as MemoryRecord[], "recall") : [],
      ctx.calendar ? within<CalendarEvent[] | null>(ctx.calendar.upcoming(7), budget, null, "calendar") : null,
      within<WeatherReport | null>(getWeather(), budget, null, "weather"),
      // ニュースをまとめるときだけ、興味のある分野を最新の設定で
      ctx.news && briefing ? within(readNewsSettings(), budget, ctx.news.settings, "news") : ctx.news?.settings,
    ]);
    const prepMs = Date.now() - prepStart;
    const news = ctx.news && newsSettings ? { ...ctx.news, settings: newsSettings } : ctx.news;

    // Web 検索: 最新情報が必要そうな発言だけ（無料枠の回数を節約）
    const mode = getSearchMode();
    // ニュースをまとめるときは検索する（FRIDAY_SEARCH=off のときだけは検索しない）
    const search = mode !== "off" && (mode === "always" || briefing || needsSearch(latest));

    const contents: GeminiContent[] = ctx.messages.map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }],
    }));

    // 音声会話は「最初の一言の速さ」優先: 考える量を最小にし、返答も短く
    // ニュースのまとめは長くなるので上限を広げる
    // 短い普通の発言（検索・まとめ以外）も考える量を最小にする（最初の一言が速くなる）
    const quick = !search && !briefing && latest.length < QUICK_REPLY_CHARS;
    const runConfig = ctx.voice
      ? { ...config, thinkingLevel: "minimal" as const, maxOutputTokens: briefing ? 1200 : Math.min(config.maxOutputTokens, 400) }
      : briefing
        ? { ...config, maxOutputTokens: Math.max(config.maxOutputTokens, 3000) }
        : quick
          ? { ...config, thinkingLevel: "minimal" as const }
          : config;

    let first = true;
    for await (const chunk of streamGemini({
      config: runConfig,
      systemInstruction: buildSystemInstruction({
        now: ctx.now,
        timezone: ctx.timezone,
        memories,
        memoryConnected: ctx.memory.connected,
        calendar: ctx.calendar ? { connected: true, events } : { connected: false },
        weather,
        search,
        news,
        voice: ctx.voice,
      }),
      contents,
      signal: ctx.signal,
      googleSearch: search,
    })) {
      // 準備（脳・カレンダー・天気）にかかった時間を最初の塊で知らせる（画面に表示して遅さの原因を見分ける）
      yield first ? { ...chunk, prepMs } : chunk;
      first = false;
    }
  },
};
