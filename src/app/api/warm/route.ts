/**
 * POST /api/warm — 入力中・聞き取り中に呼ばれ、送信前に準備を済ませておく（応答は空）。
 * Gemini への接続を温め、脳・予定・天気・ニュース設定をキャッシュに読み込んでおく。
 * 応答はすぐ返し、読み込みは after() で最後まで走らせる（サーバーレスで途中で止まらないように）。
 */
import { after } from "next/server";
import { CalendarAccess, refreshTokenFrom } from "@/integrations/google-calendar";
import { readNewsSettings } from "@/integrations/news";
import { getWeather } from "@/integrations/weather";
import { getTimezone } from "@/lib/config";
import { warmGemini } from "@/llm/health";
import { isBrainConfigured } from "@/memory/github-brain";
import { refreshMemoryIndex, warmBrain } from "@/memory/obsidian";
import { warmTts } from "@/voice/elevenlabs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function POST(req: Request): Response {
  warmGemini();
  warmTts();
  const tasks: Promise<unknown>[] = [getWeather()];
  // 脳の読み込みのあと、意味で探すための索引を少しずつ作る（10 分に 1 回まで）
  if (isBrainConfigured()) tasks.push(warmBrain().then(() => refreshMemoryIndex()), readNewsSettings());
  const refresh = refreshTokenFrom(req);
  if (refresh) tasks.push(new CalendarAccess(refresh, getTimezone()).upcoming(7));
  after(() => Promise.allSettled(tasks));
  return new Response(null, { status: 204 });
}
