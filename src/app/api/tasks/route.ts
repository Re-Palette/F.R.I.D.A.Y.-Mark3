/**
 * POST /api/tasks — 画面から ToDo を追加・完了・進捗を記録する（脳のノートを書き換える）。
 *   { action: "add", text, project?, due? } / { action: "toggle", path, text, done } / { action: "progress", project, progress }
 */
import { addTodo, getTasksOverview, setProgress, setTodoDone } from "@/integrations/tasks";
import { isBrainConfigured } from "@/memory/github-brain";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  if (!isBrainConfigured()) return Response.json({ error: "脳（Obsidian）が接続されていません。" }, { status: 400 });
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  try {
    if (body.action === "add") await addTodo(body);
    else if (body.action === "toggle") await setTodoDone(body);
    else if (body.action === "progress") await setProgress(body);
    else return Response.json({ error: "不明な操作です。" }, { status: 400 });
    return Response.json({ ok: true, ...(await getTasksOverview()) });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "保存できませんでした。" }, { status: 400 });
  }
}
