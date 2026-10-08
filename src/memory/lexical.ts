/**
 * 言葉の一致で記憶を探す仕組み（日本語でも効くよう 2 文字ずつの一致で点数化）。
 * サーバーの長期記憶（obsidian.ts）と、オフライン時に画面の中で動く記憶検索（offline-core）の両方で使う。
 * Node 専用の機能を使わないので、ブラウザでもそのまま動く。
 */
export const CHUNK_CHARS = 600;

const STRIP = /[\s、。，．,.!！?？「」『』（）()・…ー〜\-#*_>`[\]|:：/]/g;

export function bigrams(text: string): Set<string> {
  const t = text.replace(STRIP, "").toLowerCase();
  const out = new Set<string>();
  for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2));
  return out;
}

/** よく出るだけで意味の薄い並び（検索のノイズ） */
const COMMON = new Set(["です", "ます", "した", "ない", "ある", "いる", "する", "こと", "もの", "これ", "それ", "って", "けど", "から", "ので", "よう", "という"]);

export function score(query: Set<string>, chunk: string): number {
  const grams = bigrams(chunk);
  let hit = 0;
  for (const g of query) if (!COMMON.has(g) && grams.has(g)) hit++;
  return hit / Math.sqrt(grams.size + 20);
}

export interface Chunk {
  path: string;
  heading: string;
  text: string;
}

/** ノートを見出し・段落ごとに区切る */
export function toChunks(path: string, text: string): Chunk[] {
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

