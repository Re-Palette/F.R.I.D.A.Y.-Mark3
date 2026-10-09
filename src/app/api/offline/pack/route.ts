/**
 * GET /api/offline/pack — オフライン用の控え（オンラインの間に画面が取りに来て、端末に保存する）。
 *   - 人格（いつもの人格の要点だけの短い版。PC のローカル AI は長い指示を読むのが遅いため。記憶の欄は画面がその場で探した内容に差し替える）
 *   - 脳（Obsidian）のプロフィール・最近の記憶・ノートの段落
 *   - その時点の ToDo・リマインダー・カレンダー（今後 7 日）
 * ネットが切れたら、画面はこの控えとローカル AI（Ollama）で答える。API キー・PC のファイルの場所は含めない。
 */
import { buildCompactInstruction } from "@/agents/chat/persona";
import { CalendarAccess, refreshTokenFrom } from "@/integrations/google-calendar";
import { listReminders } from "@/integrations/reminders";
import { getTasksOverview } from "@/integrations/tasks";
import { getContextConfig, getTimezone } from "@/lib/config";
import { isBrainConfigured } from "@/memory/github-brain";
import { OFFLINE_RECALL, offlineSnapshot } from "@/memory/obsidian";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 記憶の欄の目印（画面がこの見出しを、その場で探した記憶に置き換える） */
const RECALL_MARK = "__FRIDAY_RECALL__";

const soft = <T,>(p: Promise<T>, fallback: T, ms = 6000) =>
  Promise.race([p.catch(() => fallback), new Promise<T>((r) => setTimeout(() => r(fallback), ms))]);

export async function GET(req: Request): Promise<Response> {
  const brain = isBrainConfigured();
  const timezone = getTimezone();
  const refresh = refreshTokenFrom(req);
  const calendar = refresh ? new CalendarAccess(refresh, timezone) : undefined;
  const [snapshot, tasks, reminders, events] = await Promise.all([
    brain ? soft(offlineSnapshot(), null, 15000) : null,
    brain ? soft(getTasksOverview(), null) : null,
    brain ? soft(listReminders(), null) : null,
    calendar ? soft(calendar.upcoming(7), null) : null,
  ]);
  const now = new Date();
  // PC のローカル AI は長い指示を読むのが遅いので、オフラインでは短い人格を使う
  const persona = (voice: boolean) =>
    buildCompactInstruction({ now, timezone, voice, tasks, reminders, events, recallMark: brain ? `## ${RECALL_MARK}\n` : null });
  return Response.json(
    {
      version: 2,
      at: now.getTime(),
      timezone,
      persona: { text: persona(false), voice: persona(true) },
      recallMark: `## ${RECALL_MARK}\n`,
      // 記憶・会話も短めに（読む量を減らして速く答える）
      recall: { ...OFFLINE_RECALL, PROFILE_CHARS: 600, RECENT_MEMORY_CHARS: 900, TOP_CHUNKS: 3, RECALL_BUDGET_CHARS: 1500 },
      context: { maxMessages: Math.min(8, getContextConfig().maxMessages), maxChars: 3000 },
      brain: snapshot ? { connected: true, ...snapshot } : { connected: false, profile: "", memory: "", chunks: [] },
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
