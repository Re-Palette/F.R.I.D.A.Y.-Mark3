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
  LOG_DIR,
  MEMORY_PATH,
  PROFILE_PATH,
  readNote,
  type BrainFile,
} from "./github-brain";
import type { LongTermMemory, MemoryRecord, SaveTurnInput } from "./long-term";
import { chunkId, similarity, updateIndex, type IndexedChunk } from "./semantic";
import { bigrams, CHUNK_CHARS, score, toChunks, type Chunk } from "./lexical";

const MAX_NOTES = 400; // 読み込むノート数の上限
const MAX_NOTE_BYTES = 40_000; // 大きすぎるノートは読まない
const PROFILE_CHARS = 2000;
const RECENT_MEMORY_CHARS = 2500;
const TOP_CHUNKS = 4;
const RECALL_BUDGET_CHARS = 5000;
/** 意味の近さを測るのに待てる時間（返答を遅らせないため短め。脳の読み込み全体の待ち時間より十分短く） */
const SEMANTIC_BUDGET_MS = 350;
/** これより意味が近ければ、言葉が一致しなくても候補にする */
const SEMANTIC_MIN = 0.62;

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
    const all: (Chunk & { id: string; s: number })[] = [];
    for (const [path, text] of notes) {
      if (path === PROFILE_PATH || path === MEMORY_PATH) continue;
      for (const c of toChunks(path, text)) {
        all.push({ ...c, id: chunkId(c.path, c.heading, c.text), s: score(q, `${c.heading} ${c.text}`) });
      }
    }

    // MEMORY AI: 意味の近さも測る（言い回しが違っても見つかる）。間に合わなければ言葉の一致だけで探す
    // 「ありがとう」「了解」のような短い発言は、言葉の一致だけで十分（意味を測る通信を省いて速く）
    const sims = query.trim().length < 6 ? null : await Promise.race([
      similarity(`${query}\n${history.slice(-2, -1).map((m) => m.content).join(" ")}`.slice(0, 800), all.map((c) => c.id)).catch(() => null),
      new Promise<null>((r) => setTimeout(() => r(null), SEMANTIC_BUDGET_MS)),
    ]);
    const combined = (c: { id: string; s: number }) => {
      const cos = sims?.get(c.id);
      const lexical = Math.min(1, c.s / 1.2);
      return cos === undefined ? lexical : 0.45 * lexical + Math.max(0, (cos - 0.45) / 0.35);
    };
    const candidates = all
      .filter((c) => c.s > 0.35 || (sims?.get(c.id) ?? 0) > SEMANTIC_MIN)
      .map((c) => ({ ...c, rank: combined(c) }))
      .sort((a, b) => b.rank - a.rank);

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

/** 索引に入れる段落（会話ログ・プロフィール・記憶は除く。ノートと文書が中心） */
export async function indexableChunks(): Promise<IndexedChunk[]> {
  const notes = await loadAll(await listNotes());
  const out: IndexedChunk[] = [];
  for (const [path, text] of notes) {
    if (path === PROFILE_PATH || path === MEMORY_PATH || path.startsWith(`${LOG_DIR}/`)) continue;
    for (const c of toChunks(path, text)) out.push({ id: chunkId(c.path, c.heading, c.text), text: `${c.heading}\n${c.text}` });
  }
  return out;
}

/** 意味で探すための索引を少しずつ作る（入力中・画面を開いたとき・夜の自動日記で呼ぶ） */
let lastIndexRun = 0;
export async function refreshMemoryIndex(force = false): Promise<number> {
  if (!force && Date.now() - lastIndexRun < 10 * 60_000) return 0;
  lastIndexRun = Date.now();
  return updateIndex(await indexableChunks());
}

/** オフライン用の控えに入れるノートの段落の上限（文字数の合計） */
const OFFLINE_CHUNK_BUDGET = 450_000;

/**
 * オフラインでも思い出せるように、脳の中身の控えを作る（画面が端末に保存し、ローカル AI（Ollama）で話すときに使う）。
 * プロフィール・最近の記憶・ノートの段落（会話ログは除く。新しいノートを優先し、上限まで）。
 */
export async function offlineSnapshot(): Promise<{ profile: string; memory: string; chunks: Chunk[] }> {
  const files = await listNotes();
  const notes = await loadAll(files);
  const chunks: Chunk[] = [];
  let budget = OFFLINE_CHUNK_BUDGET;
  for (const [path, text] of notes) {
    if (path === PROFILE_PATH || path === MEMORY_PATH || path.startsWith(`${LOG_DIR}/`)) continue;
    for (const c of toChunks(path, text)) {
      if (budget <= 0) break;
      budget -= c.text.length + c.heading.length;
      chunks.push(c);
    }
  }
  return {
    profile: (notes.get(PROFILE_PATH) ?? "").slice(0, PROFILE_CHARS),
    memory: (notes.get(MEMORY_PATH) ?? "").slice(-RECENT_MEMORY_CHARS * 2),
    chunks,
  };
}

export const OFFLINE_RECALL = { PROFILE_CHARS, RECENT_MEMORY_CHARS, TOP_CHUNKS, RECALL_BUDGET_CHARS } as const;
