/**
 * 振り返り・日記の材料集め（会話ログ・日記・ToDo・予定・記憶）。
 */
import type { CalendarAccess, CalendarEvent } from "@/integrations/google-calendar";
import { readDatedNotes } from "@/integrations/documents";
import { getTasksOverview, type Task } from "@/integrations/tasks";
import { LOG_DIR, listNotes, MEMORY_PATH, readNote } from "@/memory/github-brain";

export interface ReviewMaterial {
  from: string;
  to: string;
  logs: { date: string; text: string }[];
  diaries: { date: string; text: string }[];
  done: Task[];
  open: Task[];
  events: CalendarEvent[] | null;
  /** 記憶.md のうち、期間中に書き足された部分 */
  memories: string;
}

const addDays = (day: string, n: number) => {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/** 記憶.md から from 以降の見出し（## YYYY-MM-DD）の部分を取り出す */
async function memoriesSince(from: string): Promise<string> {
  const file = (await listNotes()).find((f) => f.path === MEMORY_PATH);
  if (!file) return "";
  const text = await readNote(file);
  const parts = text.split(/^## (?=\d{4}-\d{2}-\d{2})/m).slice(1);
  return parts
    .filter((p) => p.slice(0, 10) >= from)
    .map((p) => `## ${p.trim()}`)
    .join("\n")
    .slice(-4000);
}

/** days 日前から今日までの材料 */
export async function gatherReview(tz: string, days: number, calendar?: CalendarAccess): Promise<ReviewMaterial> {
  const to = new Intl.DateTimeFormat("sv-SE", { timeZone: tz }).format(new Date());
  const from = addDays(to, -(days - 1));
  const perLog = days <= 1 ? 12_000 : 2500;
  const [logs, diaries, tasks, events, memories] = await Promise.all([
    readDatedNotes(LOG_DIR, from, to, perLog).catch(() => []),
    readDatedNotes("日記", from, to, 1500).catch(() => []),
    getTasksOverview().catch(() => ({ projects: [], todos: [], done: [] })),
    calendar ? calendar.between(-(days - 1), days).catch(() => null) : Promise.resolve(null),
    memoriesSince(from).catch(() => ""),
  ]);
  return { from, to, logs, diaries, done: tasks.done, open: tasks.todos, events, memories };
}

/** 会話に渡す文章にする */
export function formatMaterial(m: ReviewMaterial): string {
  const logs = m.logs.length ? m.logs.map((l) => `### ${l.date}\n${l.text}`).join("\n\n") : "（会話ログなし）";
  const diaries = m.diaries.length ? m.diaries.map((d) => `### ${d.date}\n${d.text}`).join("\n\n") : "（日記なし）";
  const events =
    m.events === null
      ? "（カレンダー未接続・読み込めず）"
      : m.events.length
        ? m.events.map((e) => `- ${e.dayLabel} ${e.rangeLabel} ${e.title}`).join("\n")
        : "（予定なし）";
  const done = m.done.length ? m.done.map((t) => `- ${t.text}${t.project ? `［${t.project}］` : ""}`).join("\n") : "（なし）";
  const open = m.open.length
    ? m.open.slice(0, 30).map((t) => `- ${t.text}${t.project ? `［${t.project}］` : ""}${t.due ? `（期限 ${t.due}）` : ""}`).join("\n")
    : "（なし）";
  return `期間: ${m.from} 〜 ${m.to}

## 予定（カレンダー）
${events}

## 完了した ToDo（期間外のものも含む）
${done}

## 未完了の ToDo
${open}

## この期間に覚えたこと
${m.memories || "（なし）"}

## 日記
${diaries}

## 会話ログ
${logs}`;
}

/** 振り返りを頼まれているか */
export function asksForReview(text: string): boolean {
  return /振り返|ふりかえ|レビュー|今週(は|って)?どうだった|(一|1)週間(の|を)?(まとめ|分析)/.test(text);
}

/** 日記を頼まれているか */
export function asksForDiary(text: string): boolean {
  return /日記/.test(text) && /書いて|作って|まとめて|つけて/.test(text);
}
