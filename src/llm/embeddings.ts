/**
 * Gemini の埋め込み（文章の意味を数字の並びにする。無料枠あり）。
 * 言い回しが違っても意味の近いノートを探すのに使う。
 */
import { getGeminiConfig } from "@/lib/config";

export const EMBED_DIMS = 256;
const MODELS = (process.env.GEMINI_EMBEDDING_MODEL?.trim() || "gemini-embedding-001,text-embedding-004").split(",").map((m) => m.trim());
/** 使えなかったモデル（404 など）は以後使わない */
const unavailable = new Set<string>();

type TaskType = "RETRIEVAL_DOCUMENT" | "RETRIEVAL_QUERY";

/** 長さ 1 にそろえる（出力の次元を減らしたときは自分で正規化が必要） */
function normalize(v: number[]): Float32Array {
  let n = 0;
  for (const x of v) n += x * x;
  const len = Math.sqrt(n) || 1;
  return Float32Array.from(v, (x) => x / len);
}

export function embeddingModel(): string | undefined {
  return MODELS.find((m) => !unavailable.has(m));
}

/** 文章をまとめて埋め込みにする（最大 100 件ずつ） */
export async function embed(texts: string[], taskType: TaskType, timeoutMs = 15_000): Promise<{ model: string; vectors: Float32Array[] }> {
  const config = getGeminiConfig();
  if (!config.apiKey) throw new Error("Gemini API キーが設定されていません。");
  for (const model of MODELS) {
    if (unavailable.has(model)) continue;
    const vectors: Float32Array[] = [];
    let failed = false;
    for (let i = 0; i < texts.length; i += 100) {
      const batch = texts.slice(i, i + 100);
      const res = await fetch(`${config.baseUrl}/models/${model}:batchEmbedContents`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": config.apiKey },
        body: JSON.stringify({
          requests: batch.map((text) => ({
            model: `models/${model}`,
            content: { parts: [{ text: text.slice(0, 2000) }] },
            taskType,
            outputDimensionality: EMBED_DIMS,
          })),
        }),
        signal: AbortSignal.timeout(timeoutMs),
        cache: "no-store",
      });
      if (res.status === 404 || res.status === 400) {
        unavailable.add(model);
        failed = true;
        break;
      }
      if (!res.ok) throw new Error(`embedding ${res.status}`);
      const json = (await res.json()) as { embeddings?: { values: number[] }[] };
      for (const e of json.embeddings ?? []) vectors.push(normalize(e.values.slice(0, EMBED_DIMS)));
    }
    if (!failed) return { model, vectors };
  }
  throw new Error("使える埋め込みモデルがありません。");
}
