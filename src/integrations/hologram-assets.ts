/**
 * 「〇〇の 3D ホログラム」に使う、既存の 3D モデル探し（Poly Pizza：無料の低ポリゴン 3D モデル集、CC0 / CC-BY）。
 *   1. Gemini に、対象を英語の検索語（1〜3 個）にしてもらう（Poly Pizza は英語で探す）
 *   2. Poly Pizza で探す
 *   3. 候補の名前・タグを Gemini に見せ、対象そのものを表しているものを 1 つ選ばせる（無ければ使わない）
 * API キー（POLY_PIZZA_API_KEY）はサーバーだけで使う。見つからなければ null（今までの「部品で組み立てる」方式に戻る）。
 */
import { getGeminiConfig } from "@/lib/config";
import { streamGemini } from "@/llm/gemini";
import type { HoloAsset } from "@/lib/hologram-schema";

const apiBase = () => (process.env.POLY_PIZZA_API_BASE?.trim() || "https://api.poly.pizza/v1.1").replace(/\/+$/, "");
const apiKey = () => process.env.POLY_PIZZA_API_KEY?.trim() || undefined;

export function isAssetLibraryConfigured(): boolean {
  return Boolean(apiKey());
}

/** ダウンロードしてよい 3D モデルの置き場所（ほかの場所の URL は使わない） */
export function isAllowedAssetUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    const testBase = process.env.POLY_PIZZA_API_BASE?.trim();
    if (testBase && u.origin === new URL(testBase).origin) return true;
    return u.protocol === "https:" && (u.hostname === "poly.pizza" || u.hostname.endsWith(".poly.pizza"));
  } catch {
    return false;
  }
}

interface Candidate {
  id: string;
  title: string;
  tags: string[];
  category?: number | string;
  download: string;
  creator: string;
  license: string;
  animated: boolean;
  tris?: number;
}

const s = (v: unknown) => (typeof v === "string" ? v : "");

/** API の版によって項目名の書き方（Title / title など）が違うので、どちらでも読む */
function toCandidate(raw: unknown): Candidate | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const creator = (r.Creator ?? r.creator) as Record<string, unknown> | undefined;
  const c: Candidate = {
    id: s(r.ID ?? r.id),
    title: s(r.Title ?? r.title).slice(0, 80),
    tags: (Array.isArray(r.Tags ?? r.tags) ? ((r.Tags ?? r.tags) as unknown[]) : []).map(String).slice(0, 8),
    category: (r.Category ?? r.category) as number | string | undefined,
    download: s(r.Download ?? r.download),
    creator: s(creator?.Username ?? creator?.name ?? creator?.username).slice(0, 60),
    license: s(r.Licence ?? r.License ?? r.license ?? r.licence).slice(0, 30),
    animated: Boolean(r.Animated ?? r.animated),
    tris: Number(r.TriangleCount ?? r.triCount) || undefined,
  };
  return c.id && c.title && isAllowedAssetUrl(c.download) ? c : null;
}

async function search(term: string): Promise<Candidate[]> {
  const key = apiKey();
  if (!key) return [];
  try {
    const res = await fetch(`${apiBase()}/search/${encodeURIComponent(term)}?limit=16`, {
      headers: { "X-Auth-Token": key },
      signal: AbortSignal.timeout(8000),
      cache: "no-store",
    });
    if (!res.ok) {
      console.warn(`[friday] poly.pizza search ${res.status}`);
      return [];
    }
    const json = (await res.json()) as { results?: unknown[] };
    return (json.results ?? []).map(toCandidate).filter((c): c is Candidate => c !== null);
  } catch (err) {
    console.warn("[friday] poly.pizza search failed:", err instanceof Error ? err.message : err);
    return [];
  }
}

/** Gemini に短い JSON で答えさせる */
async function askJson<T>(system: string, text: string): Promise<T | null> {
  const config = getGeminiConfig();
  let out = "";
  try {
    for await (const chunk of streamGemini({
      config: { ...config, thinkingLevel: "low", maxOutputTokens: 600, temperature: 0.1 },
      systemInstruction: system,
      contents: [{ role: "user", parts: [{ text }] }],
    })) {
      out += chunk.text;
    }
    return JSON.parse(out.slice(out.indexOf("{"), out.lastIndexOf("}") + 1)) as T;
  } catch {
    return null;
  }
}

const KEYWORDS = `3D モデル集（英語のキーワード検索）で、頼まれた対象のモデルを探すための検索語を考える。
- 対象そのものを表す英語の名詞を、具体的なもの → 一般的なものの順に 1〜3 個（例：「東京タワー」→ ["tokyo tower","radio tower","tower"]、「柴犬」→ ["shiba inu","dog"]）。
- 1 個あたり 1〜3 語。小文字。
- 出力は JSON だけ：{"terms":["…"]}`;

const PICK = `3D モデル集の検索結果から、頼まれた対象を表すモデルを 1 つ選ぶ。
- 対象そのもの（またはその代表的な種類）を表すモデルだけを選ぶ。部品だけ・別の物・それが置かれた場面・キャラクターの一部・文字のロゴなどは選ばない。
- 迷ったら、名前とタグが対象に一番近く、動き（animated）の無いものを選ぶ。
- ふさわしいものが無ければ -1。
- 出力は JSON だけ：{"index": 番号}`;

const found = new Map<string, HoloAsset | null>();

/** 〇〇の 3D モデルを探す（見つからない・使えないときは null） */
export async function findHoloAsset(subject: string): Promise<HoloAsset | null> {
  if (!isAssetLibraryConfigured()) return null;
  const key = subject.trim().toLowerCase();
  if (found.has(key)) return found.get(key) ?? null;

  const kw = await askJson<{ terms?: unknown }>(KEYWORDS, `対象：${subject}`);
  const terms = (Array.isArray(kw?.terms) ? kw.terms : [])
    .map((t) => String(t).toLowerCase().replace(/[^a-z0-9 \-]/g, "").trim())
    .filter(Boolean)
    .slice(0, 3);
  // 検索語を作れなかったときは、英数字ならそのまま探す
  if (!terms.length && /^[\x20-\x7e]+$/.test(subject)) terms.push(subject.toLowerCase());
  if (!terms.length) return null; // Gemini が答えられなかった（覚えずに、次はもう一度試す）

  let pick: HoloAsset | null = null;
  for (const term of terms) {
    const list = (await search(term)).slice(0, 16);
    if (!list.length) continue;
    const menu = list
      .map((c, i) => `${i}: ${c.title}${c.tags.length ? ` [${c.tags.join(", ")}]` : ""}${c.animated ? " (animated)" : ""}`)
      .join("\n");
    const choice = await askJson<{ index?: unknown }>(PICK, `対象：${subject}\n\n# 検索結果（検索語：${term}）\n${menu}`);
    const i = Number(choice?.index);
    if (Number.isInteger(i) && i >= 0 && i < list.length) {
      const c = list[i];
      pick = {
        id: c.id,
        title: c.title,
        url: c.download,
        creator: c.creator,
        license: c.license,
        page: `https://poly.pizza/m/${encodeURIComponent(c.id)}`,
      };
      break;
    }
  }
  if (found.size >= 50) found.delete(found.keys().next().value!);
  found.set(key, pick);
  return pick;
}
