/**
 * GET /api/status — 各 Agent の稼働状態（UI の ONLINE / OFFLINE 表示用）。
 * API キーの値そのものは返さず、設定済みかどうかだけを返す。
 */
import { listAgents } from "@/core/router";
import type { StatusResponse } from "@/core/types";
import { getContextConfig } from "@/lib/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(): Response {
  const agents: StatusResponse["agents"] = {};
  for (const agent of listAgents()) {
    const d = agent.describe();
    agents[agent.id] = { status: d.ready ? "online" : "offline", model: d.model, reason: d.reason };
  }
  const body: StatusResponse = { agents, context: { maxMessages: getContextConfig().maxMessages } };
  return Response.json(body, { headers: { "Cache-Control": "no-store" } });
}
