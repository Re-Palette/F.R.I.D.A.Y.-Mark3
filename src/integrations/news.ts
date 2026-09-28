/**
 * ニュースのまとめ（毎日決まった時間以降、その日最初に話しかけたときに伝える）。
 *
 * 設定は脳の「FRIDAY/ニュース.md」に置く（Obsidian でも声でも変えられる）:
 *   ## 時間        … 07:00
 *   ## 興味のある分野 … 箇条書き
 * 脳が無いときは環境変数 NEWS_TIME / NEWS_TOPICS（カンマ区切り）を使う。
 * その日に伝えたかどうかは Cookie（端末ごと）で覚える。
 */
import { BRAIN_DIR, isBrainConfigured, listNotes, readNote, updateNote } from "@/memory/github-brain";

export const NEWS_PATH = `${BRAIN_DIR}/ニュース.md`;
export const NEWS_COOKIE = "friday_news";
const DEFAULT_TIME = "07:00";
const MAX_TOPICS = 12;

export interface NewsSettings {
  /** "07:00"（この時刻以降、その日最初の会話で伝える）。"off" なら自動では伝えない */
  time: string;
  topics: string[];
  /** 脳に保存されている設定か */
  fromBrain: boolean;
}

const TIME = /^([01]?\d|2[0-3]):([0-5]\d)$/;

export function normalizeTime(v: string | undefined): string | null {
  const t = (v ?? "").trim().replace(/[：]/g, ":").replace(/[０-９]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0xfee0));
  if (/^(off|なし|オフ|停止)$/i.test(t)) return "off";
  const m = TIME.exec(t);
  return m ? `${m[1].padStart(2, "0")}:${m[2]}` : null;
}

function cleanTopics(list: unknown[]): string[] {
  const out: string[] = [];
  for (const v of list) {
    const t = String(v ?? "").replace(/^[-・*\s]+/, "").trim().slice(0, 40);
    if (t && !out.includes(t)) out.push(t);
  }
  return out.slice(0, MAX_TOPICS);
}

function envSettings(): NewsSettings {
  return {
    time: normalizeTime(process.env.NEWS_TIME) ?? DEFAULT_TIME,
    topics: cleanTopics((process.env.NEWS_TOPICS ?? "").split(/[,、]/)),
    fromBrain: false,
  };
}

/** ノートの本文から設定を読む */
export function parseNewsNote(text: string): Omit<NewsSettings, "fromBrain"> {
  let section = "";
  let time: string | null = null;
  const topics: string[] = [];
  for (const line of text.split("\n")) {
    const h = /^##\s+(.*)$/.exec(line);
    if (h) {
      section = h[1];
      continue;
    }
    if (/時間|時刻/.test(section) && !time) time = normalizeTime(line.replace(/^[-・*\s]+/, "")) ?? null;
    if (/興味|分野|トピック/.test(section) && /^\s*[-・*]\s*\S/.test(line)) topics.push(line);
  }
  return { time: time ?? DEFAULT_TIME, topics: cleanTopics(topics) };
}

function renderNote(s: Pick<NewsSettings, "time" | "topics">): string {
  return `# ニュース

F.R.I.D.A.Y. が毎日「時間」を過ぎてから最初に話しかけたときに、その日のニュースをまとめて伝えます。
「興味のある分野」のニュースは分野ごとに詳しく伝えます。自由に書き換えてください（時間を off にすると自動では伝えません）。

## 時間
${s.time}

## 興味のある分野
${s.topics.length ? s.topics.map((t) => `- ${t}`).join("\n") : "- "}
`;
}

export async function readNewsSettings(): Promise<NewsSettings> {
  if (!isBrainConfigured()) return envSettings();
  const file = (await listNotes()).find((f) => f.path === NEWS_PATH);
  if (!file) return envSettings();
  return { ...parseNewsNote(await readNote(file)), fromBrain: true };
}

/** 設定を変える（脳が必要） */
export async function saveNewsSettings(change: { time?: string; topics?: string[] }): Promise<NewsSettings> {
  const current = await readNewsSettings();
  const next = {
    time: change.time !== undefined ? (normalizeTime(change.time) ?? current.time) : current.time,
    topics: change.topics !== undefined ? cleanTopics(change.topics) : current.topics,
  };
  await updateNote(NEWS_PATH, () => renderNote(next), "F.R.I.D.A.Y.: ニュースの設定を更新");
  return { ...next, fromBrain: true };
}

/** その地域の今日の日付と時刻 */
export function localNow(tz: string, now = new Date()): { date: string; time: string } {
  const date = new Intl.DateTimeFormat("sv-SE", { timeZone: tz }).format(now);
  const time = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(now);
  return { date, time };
}

/** ニュースを頼まれているか（「ニュース」「今日何があった」など） */
export function asksForNews(text: string): boolean {
  // 「ニュースの時間を変えて」「興味に〇〇を追加」などの設定変更は、まとめを頼んでいるのではない
  if (/ニュース/.test(text) && /時間|時刻|分野|興味|設定|追加|外して|削除|オフ|やめて|止めて/.test(text)) return false;
  return /ニュース|今日(は)?何があった|世の中で何|話題(は|になってる)/.test(text);
}
