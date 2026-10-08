/**
 * GET /api/offline/pack — オフライン用の控え（オンラインの間に画面が取りに来て、端末に保存する）。
 *   - 人格（いつもと同じ system prompt。記憶の欄は画面がその場で探した内容に差し替える）
 *   - 脳（Obsidian）のプロフィール・最近の記憶・ノートの段落
 *   - その時点の ToDo・リマインダー・カレンダー（今後 7 日）
 * ネットが切れたら、画面はこの控えと LM Studio で答える。API キー・PC のファイルの場所は含めない。
 */
import { buildSystemInstruction } from "@/agents/chat/persona";
import { CalendarAccess, refreshTokenFrom } from "@/integrations/google-calendar";
import { listReminders } from "@/integrations/reminders";
import { peekAppSettings } from "@/integrations/settings";
import { getTasksOverview } from "@/integrations/tasks";
import { companyConnected } from "@/integrations/company";
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
  const persona = (voice: boolean) =>
    buildSystemInstruction({
      now,
      timezone,
      memories: [{ source: RECALL_MARK, title: RECALL_MARK, content: "" }],
      memoryConnected: brain,
      calendar: calendar ? { connected: true, events } : { connected: false },
      weather: null,
      search: false,
      tasks,
      reminders,
      replyLength: peekAppSettings().replyLength,
      companyConnected: companyConnected(),
      voice,
    });
  return Response.json(
    {
      version: 1,
      at: now.getTime(),
      timezone,
      persona: { text: persona(false), voice: persona(true) },
      recallMark: `## ${RECALL_MARK}\n`,
      recall: OFFLINE_RECALL,
      context: getContextConfig(),
      brain: snapshot ? { connected: true, ...snapshot } : { connected: false, profile: "", memory: "", chunks: [] },
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
