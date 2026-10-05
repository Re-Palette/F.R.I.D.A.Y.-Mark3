/**
 * /api/session — 会話の同期（スマホとパソコンで同じ会話を続ける）
 *   GET → { configured, session }　POST { messages, clearedAt, removed } → まとめた結果 { configured, session }
 * 保存先は脳（GitHub）の .friday/session.json。写真・ファイルの中身は同期しない。
 */
import { readSession, saveSession } from "@/integrations/session-sync";
import { MAX_MESSAGES, parseSession } from "@/lib/session-merge";
import { isBrainConfigured } from "@/memory/github-brain";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const headers = { "Cache-Control": "no-store" };

export async function GET(): Promise<Response> {
  if (!isBrainConfigured()) return Response.json({ configured: false }, { headers });
  try {
    return Response.json({ configured: true, session: await readSession() }, { headers });
  } catch {
    return Response.json({ configured: true, error: "会話を読み込めませんでした。" }, { status: 502, headers });
  }
}

export async function POST(req: Request): Promise<Response> {
  if (!isBrainConfigured()) return Response.json({ configured: false }, { headers });
  const text = await req.text();
  if (text.length > 900_000) return Response.json({ error: "会話が大きすぎます。" }, { status: 413, headers });
  const incoming = parseSession(text);
  incoming.messages = incoming.messages.slice(-MAX_MESSAGES);
  incoming.updatedAt = 0;
  try {
    return Response.json({ configured: true, session: await saveSession(incoming) }, { headers });
  } catch {
    return Response.json({ configured: true, error: "会話を保存できませんでした。" }, { status: 502, headers });
  }
}
