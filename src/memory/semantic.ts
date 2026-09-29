/**
 * MEMORY AI — ノートの段落を「意味」で探すための索引（埋め込み）。
 *
 * - 索引は脳の「.friday/embeddings.json」に保存（Obsidian には表示されない隠しフォルダ）。
 *   1 段落 = 256 個の数字を 1 バイトずつに縮めて保存するので、ノートが増えても軽い。
 * - 索引づくりは返答とは別のとき（入力中・画面を開いたとき・夜の自動日記）に少しずつ進める。
 * - 返答のときは、発言を 1 回だけ埋め込みにして、索引との近さを測る（時間切れなら使わない）。
 */
import { createHash } from "node:crypto";
import { EMBED_DIMS, embed, embeddingModel } from "@/llm/embeddings";
import { readFresh, updateNote } from "@/memory/github-brain";

const INDEX_PATH = ".friday/embeddings.json";
const MAX_VECTORS = 2500;
/** 1 回の索引づくりで新しく埋め込む段落の数（無料枠を使いすぎないため） */
const BATCH_LIMIT = 300;

export interface IndexedChunk {
  id: string;
  text: string;
}

export const chunkId = (path: string, heading: string, text: string) =>
  createHash("sha1").update(`${path}\n${heading}\n${text}`).digest("hex").slice(0, 12);

interface Index {
  model: string;
  vectors: Map<string, Int8Array>;
}

let index: Index | null = null;
let loading: Promise<Index> | null = null;
let building: Promise<number> | null = null;

const toInt8 = (v: Float32Array) => Int8Array.from(v, (x) => Math.max(-127, Math.min(127, Math.round(x * 127))));
const b64 = (v: Int8Array) => Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString("base64");
const fromB64 = (s: string) => new Int8Array(Buffer.from(s, "base64"));

async function loadIndex(): Promise<Index> {
  if (index) return index;
  loading ??= (async () => {
    const vectors = new Map<string, Int8Array>();
    let model = embeddingModel() ?? "";
    try {
      const raw = await readFresh(INDEX_PATH);
      if (raw) {
        const json = JSON.parse(raw) as { model?: string; dims?: number; vectors?: Record<string, string> };
        if (json.dims === EMBED_DIMS && json.model) {
          model = json.model;
          for (const [id, v] of Object.entries(json.vectors ?? {})) vectors.set(id, fromB64(v));
        }
      }
    } catch {
      /* 索引が無い・壊れている → 作り直す */
    }
    index = { model, vectors };
    return index;
  })().finally(() => (loading = null));
  return loading;
}

/** 索引にある段落の数（MEMORY 画面の表示用） */
export async function indexSize(): Promise<number> {
  return (await loadIndex()).vectors.size;
}

/**
 * まだ埋め込みの無い段落を少しずつ索引に足し、脳に保存する。追加した数を返す。
 * 同時に 1 つしか走らない。
 */
export function updateIndex(chunks: IndexedChunk[]): Promise<number> {
  building ??= (async () => {
    const idx = await loadIndex();
    const live = new Set(chunks.map((c) => c.id));
    const missing = chunks.filter((c) => !idx.vectors.has(c.id)).slice(0, BATCH_LIMIT);
    let removed = 0;
    for (const id of idx.vectors.keys()) {
      if (!live.has(id)) {
        idx.vectors.delete(id);
        removed++;
      }
    }
    if (!missing.length && !removed) return 0;
    if (missing.length) {
      const { model, vectors } = await embed(missing.map((c) => c.text), "RETRIEVAL_DOCUMENT");
      // モデルが変わったら古い索引は捨てる（比べられないため）
      if (model !== idx.model) {
        idx.vectors.clear();
        idx.model = model;
      }
      missing.forEach((c, i) => vectors[i] && idx.vectors.set(c.id, toInt8(vectors[i])));
    }
    // 多すぎる分は古いものから捨てる
    while (idx.vectors.size > MAX_VECTORS) idx.vectors.delete(idx.vectors.keys().next().value as string);
    const body = JSON.stringify({ model: idx.model, dims: EMBED_DIMS, vectors: Object.fromEntries([...idx.vectors].map(([id, v]) => [id, b64(v)])) });
    await updateNote(INDEX_PATH, () => body, `F.R.I.D.A.Y.: 記憶の索引を更新（+${missing.length}）`);
    return missing.length;
  })().finally(() => (building = null));
  return building;
}

/**
 * 発言と段落の「意味の近さ」（-1〜1）。索引に無い段落は含まれない。
 * 索引が空・埋め込みに失敗したときは null（言葉の一致だけで探す）。
 */
export async function similarity(query: string, ids: string[]): Promise<Map<string, number> | null> {
  const idx = await loadIndex();
  if (!idx.vectors.size || !query.trim()) return null;
  const { model, vectors } = await embed([query], "RETRIEVAL_QUERY", 4000);
  if (model !== idx.model || !vectors[0]) return null;
  const q = toInt8(vectors[0]);
  const out = new Map<string, number>();
  for (const id of ids) {
    const v = idx.vectors.get(id);
    if (!v) continue;
    let dot = 0;
    for (let i = 0; i < EMBED_DIMS; i++) dot += q[i] * v[i];
    out.set(id, dot / (127 * 127));
  }
  return out;
}
