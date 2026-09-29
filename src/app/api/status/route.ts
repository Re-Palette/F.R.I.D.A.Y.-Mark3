/**
 * GET /api/status — 各 Agent の稼働状態（UI の ONLINE / OFFLINE 表示用）。
 * Chat Agent は Gemini に実際に問い合わせて API キーとモデル名を検証する（結果はキャッシュ）。
 * API キーの値そのものは返さない。
 */
import { listAgents } from "@/core/router";
import type { StatusResponse } from "@/core/types";
import { getContextConfig, getSearchMode } from "@/lib/config";
import { hasGmailScope, isCalendarConfigured, refreshTokenFrom } from "@/integrations/google-calendar";
import { checkGemini } from "@/llm/health";
import { isBrainConfigured } from "@/memory/github-brain";
import { checkBrain } from "@/memory/obsidian";
import { readNewsSettings } from "@/integrations/news";
import { checkTts, isTtsConfigured } from "@/voice/elevenlabs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  // 脳（GitHub）の確認は他と並行して進める
  const brainCheck: Promise<StatusResponse["brain"]> = isBrainConfigured()
    ? checkBrain().then((b) => ({ configured: true, ...b }))
    : Promise.resolve({ configured: false, connected: false });

  const agents: StatusResponse["agents"] = {};
  for (const agent of listAgents()) {
    const d = agent.describe();
    agents[agent.id] = { status: d.ready ? "online" : "offline", model: d.model, reason: d.reason };
  }

  const chat = agents.chat;
  if (chat?.status === "online") {
    const error = await checkGemini();
    // レート制限は一時的なので ONLINE のまま扱う
    if (error && error.code !== "RATE_LIMITED") {
      agents.chat = { ...chat, status: "offline", reason: error.message };
    }
  }

  // ElevenLabs は設定されている場合だけ確認する（未設定ならブラウザの声）
  let tts: StatusResponse["tts"] = { provider: "browser" };
  if (isTtsConfigured()) {
    const error = await checkTts();
    tts = error && error.fatal ? { provider: "browser", reason: error.message } : { provider: "elevenlabs" };
  }

  const brain = await brainCheck;
  const newsSettings = await readNewsSettings().catch(() => ({ time: "07:00", topics: [] as string[] }));
  const refresh = refreshTokenFrom(req);
  const gmail = refresh ? await hasGmailScope(refresh).catch(() => false) : false;
  const calendar = { configured: isCalendarConfigured(), connected: Boolean(refresh), gmail };
  const body: StatusResponse = { agents, context: { maxMessages: getContextConfig().maxMessages }, tts, brain, calendar, search: getSearchMode(),
    news: { time: newsSettings.time, topics: newsSettings.topics },
  };
  return Response.json(body, { headers: { "Cache-Control": "no-store" } });
}
