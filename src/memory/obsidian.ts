/**
 * Obsidian の脳を使った長期記憶（LongTermMemory の実装）。
 *
 * 思い出す: プロフィールと最近の記憶は毎回、それ以外のノートは会話に関係する段落だけを渡す。
 * 覚える:   F.R.I.D.A.Y. が「覚えるべき」と判断したことを 記憶.md に、会話を日ごとの会話ログに書く。
 */
import type { ChatMessage } from "@/core/types";
import { getTimezone } from "@/lib/config";
import {
  appendConversationLog,
  appendMemories,
  ensureBrain,
  listNotes,
  MEMORY_PATH,
  PROFILE_PATH,
  readNote,
  type BrainFile,
} from "./github-brain";
import type { LongTermMemory, MemoryRecord, SaveTurnInput } from "./long-term";

const MAX_NOTES = 400; // 読み込むノート数の上限
const MAX_NOTE_BYTES = 40_000; // 大きすぎるノートは読まない
const PROFILE_CHARS = 2000;
const RECENT_MEMORY_CHARS = 2500;
const CHUNK_CHARS = 600;
const TOP_CHUNKS = 4;
const RECALL_BUDGET_CHARS = 5000;

/* ---------- 検索（日本語でも効くよう 2 文字ずつの一致で点数化） ---------- */

const STRIP = /[\s、。，．,.!！?？「」『』（）()・…ー〜\-#*_>`[\]|:：/]/g;

function bigrams(text: string): Set<string> {
  const t = text.replace(STRIP, "").toLowerCase();
  const out = new Set<string>();
  for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2));
  return out;
}

/** よく出るだけで意味の薄い並び（検索のノイズ） */
const COMMON = new Set(["です", "ます", "した", "ない", "ある", "いる", "する", "こと", "もの", "これ", "それ", "って", "けど", "から", "ので", "よう", "という"]);

function score(query: Set<string>, chunk: string): number {
  const grams = bigrams(chunk);
  let hit = 0;
  for (const g of query) if (!COMMON.has(g) && grams.has(g)) hit++;
  return hit / Math.sqrt(grams.size + 20);
}

interface Chunk {
  path: string;
  heading: string;
  text: string;
}

/** ノートを見出し・段落ごとに区切る */
function toChunks(path: string, text: string): Chunk[] {
  const chunks: Chunk[] = [];
  let heading = path.replace(/\.md$/, "").split("/").pop() ?? path;
  let buf = "";
  const flush = () => {
    const t = buf.trim();
    if (t) chunks.push({ path, heading, text: t.slice(0, CHUNK_CHARS) });
    buf = "";
  };
  for (const line of text.split("\n")) {
    const h = /^#{1,6}\s+(.*)$/.exec(line);
    if (h) {
      flush();
      heading = h[1].trim();
      continue;
    }
    if (buf.length + line.length > CHUNK_CHARS) flush();
    buf += line + "\n";
  }
  flush();
  return chunks;
}

async function loadAll(files: BrainFile[]): Promise<Map<string, string>> {
  const target = files.filter((f) => f.size <= MAX_NOTE_BYTES).slice(0, MAX_NOTES);
  const out = new Map<string, string>();
  // 同時 8 件まで取得（2 回目以降は SHA キャッシュで即座に返る）
  for (let i = 0; i < target.length; i += 8) {
    const batch = target.slice(i, i + 8);
    const texts = await Promise.all(batch.map((f) => readNote(f).catch(() => "")));
    batch.forEach((f, j) => out.set(f.path, texts[j]));
  }
  return out;
}

export class ObsidianMemory implements LongTermMemory {
  readonly connected = true;
  healthy = true;

  async recall(query: string, history: ChatMessage[]): Promise<MemoryRecord[]> {
    try {
      const records = await this.search(query, history);
      this.healthy = true;
      return records;
    } catch (err) {
      this.healthy = false;
      throw err;
    }
  }

  private async search(query: string, history: ChatMessage[]): Promise<MemoryRecord[]> {
    // 初回の脳づくりの確認は待たない（返答を遅らせないため裏で進める）
    ensureBrain(getTimezone()).catch(() => {});
    const files = await listNotes();
    const notes = await loadAll(files);
    const records: MemoryRecord[] = [];

    const profile = notes.get(PROFILE_PATH);
    if (profile?.trim()) records.push({ source: PROFILE_PATH, title: "プロフィール", content: profile.slice(0, PROFILE_CHARS) });

    const memory = notes.get(MEMORY_PATH);
    if (memory?.trim()) records.push({ source: MEMORY_PATH, title: "最近の記憶", content: memory.slice(-RECENT_MEMORY_CHARS) });

    // 検索語: 最新の発言を重視し、直前の数発言も少し混ぜる
    const recent = history.slice(-4).map((m) => m.content).join(" ");
    const q = bigrams(`${query} ${query} ${recent}`.slice(0, 600));
    const candidates: (Chunk & { s: number })[] = [];
    for (const [path, text] of notes) {
      if (path === PROFILE_PATH || path === MEMORY_PATH) continue;
      for (const c of toChunks(path, text)) {
        const s = score(q, `${c.heading} ${c.text}`);
        if (s > 0.35) candidates.push({ ...c, s });
      }
    }
    candidates.sort((a, b) => b.s - a.s);

    let budget = RECALL_BUDGET_CHARS;
    for (const c of candidates.slice(0, TOP_CHUNKS)) {
      if (budget <= 0) break;
      const content = c.text.slice(0, budget);
      budget -= content.length;
      records.push({ source: c.path, title: `${c.path.replace(/\.md$/, "")} › ${c.heading}`, content });
    }
    return records;
  }

  async save({ user, assistant, memories, voice }: SaveTurnInput): Promise<void> {
    const tz = getTimezone();
    try {
      await ensureBrain(tz);
      if (memories.length) await appendMemories(memories, tz);
      if (user.trim() && assistant.trim()) await appendConversationLog(user, assistant, tz, voice);
      this.healthy = true;
    } catch (err) {
      this.healthy = false;
      throw err;
    }
  }
}

/** 脳の状態（UI 表示用）。失敗は 15 秒だけ覚えておき、GitHub に連打しない */
let lastFailure: { at: number; reason: string } | undefined;

export async function checkBrain(): Promise<{ connected: boolean; notes?: number; reason?: string }> {
  if (lastFailure && Date.now() - lastFailure.at < 15_000) return { connected: false, reason: lastFailure.reason };
  try {
    await ensureBrain(getTimezone());
    const files = await listNotes();
    lastFailure = undefined;
    return { connected: true, notes: files.length };
  } catch (err) {
    const reason = err instanceof Error ? err.message : "脳に接続できませんでした。";
    lastFailure = { at: Date.now(), reason };
    return { connected: false, reason };
  }
}

/** 会話を始める前に、脳の一覧とノートを読み込んでおく（思い出すのを速くする） */
let lastWarm = 0;
export function warmBrain(): Promise<void> {
  if (Date.now() - lastWarm < 20_000) return Promise.resolve();
  lastWarm = Date.now();
  return listNotes()
    .then(loadAll)
    .then(() => undefined)
    .catch(() => undefined);
}
