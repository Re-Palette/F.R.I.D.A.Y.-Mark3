/**
 * /api/memory — MEMORY 画面用。脳の「記憶.md」とプロフィールを読み、記憶を足したり消したりする。
 *   GET → { entries, profile }　POST { text } → 追加　DELETE { date, text } → 1 件削除
 */
import { getTimezone } from "@/lib/config";
import { indexSize } from "@/memory/semantic";
import { appendMemories, isBrainConfigured, MEMORY_PATH, parseMemories, PROFILE_PATH, readFresh, removeMemory } from "@/memory/github-brain";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function current() {
  const [memory, profile] = await Promise.all([readFresh(MEMORY_PATH), readFresh(PROFILE_PATH)]);
  const indexed = await Promise.race([indexSize().catch(() => 0), new Promise<number>((r) => setTimeout(() => r(0), 1500))]);
  return { entries: parseMemories(memory ?? "").reverse(), profile: profile ?? "", indexed };
}

const noBrain = () => Response.json({ error: "脳（Obsidian）が接続されていません。", entries: [], profile: "" }, { status: 400 });

export async function GET(): Promise<Response> {
  if (!isBrainConfigured()) return noBrain();
  try {
    return Response.json(await current(), { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ error: "脳を読み込めませんでした。", entries: [], profile: "" }, { status: 502 });
  }
}

export async function POST(req: Request): Promise<Response> {
  if (!isBrainConfigured()) return noBrain();
  const body = (await req.json().catch(() => ({}))) as { text?: unknown };
  const text = typeof body.text === "string" ? body.text.replace(/\s+/g, " ").trim().slice(0, 200) : "";
  if (!text) return Response.json({ error: "覚える内容を入力してください。" }, { status: 400 });
  await appendMemories([text], getTimezone());
  return Response.json(await current());
}

export async function DELETE(req: Request): Promise<Response> {
  if (!isBrainConfigured()) return noBrain();
  const body = (await req.json().catch(() => ({}))) as { date?: unknown; text?: unknown };
  if (typeof body.date !== "string" || typeof body.text !== "string") return Response.json({ error: "不正な指定です。" }, { status: 400 });
  const ok = await removeMemory({ date: body.date, text: body.text });
  return Response.json({ ok, ...(await current()) });
}
