/**
 * E.D.I.T.H. の REAL-TIME NEWS（分野ごとの最新の話題）。サーバー側だけで使う。
 * Gemini に Google 検索で調べさせ、1 件ずつ「その文が実際にどのページに基づくか」（groundingSupports）を見て出典を付ける。
 * 出典が付かなかった話題は出さない（作り話を実際のニュースとして見せない）。見出し・要約は検索結果を元に Gemini がまとめたもの。
 */
import { getGeminiConfig, getTimezone } from "@/lib/config";
import { streamGemini, type GeminiChunk, type GeminiSource } from "@/llm/gemini";
import { findPlaces, type Place } from "@/lib/edith-geo";
import { FridayError } from "@/lib/errors";

export const EDITH_CATEGORIES = ["news", "research", "market", "travel", "culture", "tech", "education", "more"] as const;
export type EdithCategory = (typeof EDITH_CATEGORIES)[number];

/** 分野ごとに調べる内容 */
const TOPIC: Record<EdithCategory, string> = {
  news: "世界の主要ニュース（政治・社会・国際情勢）",
  research: "注目の科学研究・論文・学術の発表",
  market: "世界の経済・金融市場・企業の動き",
  travel: "世界の観光・旅行・交通の話題",
  culture: "世界の文化・エンタメ・トレンド",
  tech: "世界のテクノロジー・AI・イノベーション",
  education: "世界の教育・学習・大学の話題",
  more: "世界の環境・気候・宇宙・健康の話題",
};

export interface EdithNewsItem {
  title: string;
  summary: string;
  /** 主な国・地域（Gemini が書いたもの） */
  region: string;
  /** 地図に印を付ける場所（地域名から見つけた代表地点。見つからなければ無し） */
  place: Place | null;
  /** 実際に参照したページ（Google 検索の結果） */
  sources: GeminiSource[];
}

export interface EdithNews {
  category: EdithCategory;
  items: EdithNewsItem[];
  /**
   * この一覧を作るのに Google 検索で参照したページ（話題ごとの出典が結び付けられなかったときにまとめて出す）。
   * 話題ごとの出典ではないので、画面では「参照したページ」として分けて表示する。
   */
  refs: GeminiSource[];
  /** 取得した時刻（ISO） */
  fetchedAt: string;
}

/** 1 行「・見出し｜要約｜地域」を読み取る */
/**
 * 1 行 1 件の話題を読み取る。Gemini の書き方の揺れも受け付ける：
 *   「・見出し｜要約｜地域」「1. 見出し | 要約 | 地域」「- **見出し**｜要約｜地域」「・見出し：要約（地域）」
 * 区切り（｜）の無い行は、箇条書き・番号付きの行だけを見出しとして読む（前置きの文は読まない）。
 */
export function parseNewsLines(text: string): { line: string; title: string; summary: string; region: string }[] {
  const out: { line: string; title: string; summary: string; region: string }[] = [];
  const lead = /^([・\-*•●]|\d{1,2}[.)．、]|[①-⑩])\s*/;
  for (const raw of text.split("\n")) {
    const l = raw.trim();
    if (!l || /^#|^(出典|参考|ソース|sources?)[:：]/i.test(l)) continue;
    const bulleted = lead.test(l);
    const body = l
      .replace(lead, "")
      .replace(/\*\*|__/g, "")
      .replace(/\[\d+(,\s*\d+)*\]/g, "") // 引用番号 [1] [2, 3]
      .trim();
    let parts = body.split(/\s*[｜|]\s*/).filter(Boolean);
    if (parts.length < 2) {
      if (!bulleted) continue;
      // 「見出し：要約（地域）」の形
      const m = body.match(/^(.{4,40}?)[：:]\s*(.+?)(?:[（(]([^（）()]{1,12})[）)])?$/);
      parts = m ? [m[1], m[2], m[3] ?? ""] : [body];
    }
    const [title = "", summary = "", region = ""] = parts.map((x) => x.trim());
    if (title.length < 4 || title.length > 80) continue;
    out.push({ line: body, title, summary, region: region || "世界" });
  }
  return out.slice(0, 8);
}

/** その行の文に結びついた出典（groundingSupports の文が行に含まれるもの） */
export function sourcesForLine(line: string, grounding: GeminiChunk["grounding"]): GeminiSource[] {
  if (!grounding) return [];
  const norm = (s: string) => s.replace(/[\s・\-*•｜|]|\[\d+(,\s*\d+)*\]/g, "");
  const target = norm(line);
  const out: GeminiSource[] = [];
  for (const s of grounding.supports) {
    const seg = norm(s.text);
    if (seg.length < 6) continue;
    if (!target.includes(seg.slice(0, Math.min(seg.length, 40))) && !seg.includes(target.slice(0, Math.min(target.length, 20)))) continue;
    for (const i of s.chunks) {
      const c = grounding.chunks[i];
      if (c && !out.some((o) => o.uri === c.uri)) out.push(c);
    }
  }
  return out.slice(0, 3);
}

/** 1 回の取得で Google 検索を使うので、無料枠を減らさないよう 1 時間は覚えておく */
const CACHE_MS = 60 * 60_000;
const cache = new Map<EdithCategory, { at: number; value: Promise<EdithNews> }>();

export function getEdithNews(category: EdithCategory, signal?: AbortSignal): Promise<EdithNews> {
  const hit = cache.get(category);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  // 一時的な失敗なら 1 回だけやり直す（上限で断られたときはやり直さない：枠を無駄にしない）
  const value = fetchNews(category, signal).catch((err: unknown) => {
    if (err instanceof FridayError && err.code === "RATE_LIMITED") throw err;
    return fetchNews(category, signal);
  });
  cache.set(category, { at: Date.now(), value });
  value.then(
    (n) => {
      if (!n.items.length) cache.delete(category); // 空の結果は覚えない（次はやり直す）
    },
    () => cache.delete(category), // 失敗は覚えない
  );
  return value;
}

/** 少しずつ届く検索の情報をまとめる（出典の並びが同じなら、文と出典の結び付きを足していく） */
function mergeGrounding(prev: GeminiChunk["grounding"], next: NonNullable<GeminiChunk["grounding"]>): GeminiChunk["grounding"] {
  if (!prev) return next;
  const same = prev.chunks.length === next.chunks.length && prev.chunks.every((c, i) => c?.uri === next.chunks[i]?.uri);
  if (!same) return next.chunks.length >= prev.chunks.length ? next : prev;
  return { chunks: prev.chunks, supports: [...prev.supports, ...next.supports] };
}

async function fetchNews(category: EdithCategory, signal?: AbortSignal): Promise<EdithNews> {
  const config = getGeminiConfig();
  const today = new Intl.DateTimeFormat("ja-JP", { timeZone: getTimezone(), year: "numeric", month: "long", day: "numeric", weekday: "short" }).format(new Date());
  const ask = `今日は${today}。「${TOPIC[category]}」の、ここ数日の最新の話題を 6 件、Google 検索で調べてください。
1 行 1 件、次の形だけで書いてください（前置き・出典・URL は書かない）：
・見出し（30 字以内）｜要約（60 字以内）｜主な国・地域（日本語の国名か都市名。世界全体なら「世界」）
検索で確かめられた話題だけを書き、確かめられないことは書かないでください。`;
  let text = "";
  let grounding: GeminiChunk["grounding"];
  const refs: GeminiSource[] = [];
  for await (const chunk of streamGemini({
    config: { ...config, thinkingLevel: "low", maxOutputTokens: 1500 },
    systemInstruction: "あなたは世界のニュースを正確に短くまとめる係。検索結果に書かれた事実だけを書く。",
    contents: [{ role: "user", parts: [{ text: ask }] }],
    googleSearch: true,
    signal,
  })) {
    text += chunk.text;
    if (chunk.grounding) grounding = mergeGrounding(grounding, chunk.grounding);
    for (const src of chunk.sources ?? []) if (!refs.some((r) => r.uri === src.uri)) refs.push(src);
  }
  const lines = parseNewsLines(text);
  const all = lines.map((l) => ({
    title: l.title,
    summary: l.summary,
    region: l.region,
    place: findPlaces(`${l.region} ${l.title}`, 1)[0] ?? null,
    sources: sourcesForLine(l.line, grounding),
  }));
  const linked = all.filter((i) => i.sources.length > 0);
  // 話題ごとの出典が結び付けられたものだけを出す。1 件も結び付けられなかったが検索で参照したページはあるときは、
  // 話題を出し、参照したページをまとめて「参照したページ」として出す（検索していない作り話は出さない）
  const items = linked.length ? linked : refs.length ? all : [];
  console.info(`[edith-news] ${category}: lines=${lines.length} linked=${linked.length} refs=${refs.length} supports=${grounding?.supports.length ?? 0} shown=${items.length}`);
  return { category, items, refs: linked.length ? [] : refs.slice(0, 6), fetchedAt: new Date().toISOString() };
}
