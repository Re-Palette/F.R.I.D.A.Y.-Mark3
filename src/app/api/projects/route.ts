/**
 * GET /api/projects — 右パネル用のプロジェクト一覧と未完了の ToDo（脳のノートから）。
 */
import { getTasksOverview } from "@/integrations/tasks";
import { isBrainConfigured } from "@/memory/github-brain";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const headers = { "Cache-Control": "no-store" };
  if (!isBrainConfigured()) return Response.json({ configured: false, projects: [], todos: [] }, { headers });
  try {
    return Response.json({ configured: true, ...(await getTasksOverview()) }, { headers });
  } catch {
    return Response.json({ configured: true, error: true, projects: [], todos: [] }, { headers });
  }
}
