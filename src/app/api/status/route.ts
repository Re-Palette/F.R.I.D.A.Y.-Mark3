/**
 * GET /api/status — 各 Agent の稼働状態（UI の ONLINE / OFFLINE 表示用）。
 * Chat Agent は Gemini に実際に問い合わせて API キーとモデル名を検証する（結果はキャッシュ）。
 * API キーの値そのものは返さない。
 */
import { listAgents } from "@/core/router";
import type { StatusResponse } from "@/core/types";
import { getContextConfig } from "@/lib/config";
import { checkGemini } from "@/llm/health";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
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

  const body: StatusResponse = { agents, context: { maxMessages: getContextConfig().maxMessages } };
  return Response.json(body, { headers: { "Cache-Control": "no-store" } });
}
