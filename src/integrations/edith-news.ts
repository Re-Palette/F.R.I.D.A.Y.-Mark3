/**
 * E.D.I.T.H. の REAL-TIME NEWS（分野ごとの最新の話題）。サーバー側だけで使う。
 * Gemini に Google 検索で調べさせ、1 件ずつ「その文が実際にどのページに基づくか」（groundingSupports）を見て出典を付ける。
 * 出典が付かなかった話題は出さない（作り話を実際のニュースとして見せない）。見出し・要約は検索結果を元に Gemini がまとめたもの。
 */
import { getGeminiConfig, getTimezone } from "@/lib/config";
import { streamGemini, type GeminiChunk, type GeminiSource } from "@/llm/gemini";
import { findPlaces, type Place } from "@/lib/edith-geo";

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
  /** 取得した時刻（ISO） */
  fetchedAt: string;
}

/** 1 行「・見出し｜要約｜地域」を読み取る */
export function parseNewsLines(text: string): { line: string; title: string; summary: string; region: string }[] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /^[・\-*•]/.test(l))
    .map((l) => {
      const body = l.replace(/^[・\-*•]\s*/, "");
      const [title = "", summary = "", region = ""] = body.split(/[｜|]/).map((x) => x.trim());
      return { line: body, title, summary, region: region || "世界" };
    })
    .filter((x) => x.title.length >= 4);
}

/** その行の文に結びついた出典（groundingSupports の文が行に含まれるもの） */
export function sourcesForLine(line: string, grounding: GeminiChunk["grounding"]): GeminiSource[] {
  if (!grounding) return [];
  const norm = (s: string) => s.replace(/[\s・\-*•｜|]/g, "");
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

const CACHE_MS = 10 * 60_000;
const cache = new Map<EdithCategory, { at: number; value: Promise<EdithNews> }>();

export function getEdithNews(category: EdithCategory, signal?: AbortSignal): Promise<EdithNews> {
  const hit = cache.get(category);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  const value = fetchNews(category, signal);
  cache.set(category, { at: Date.now(), value });
  value.catch(() => cache.delete(category)); // 失敗は覚えない（次はやり直す）
  return value;
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
  for await (const chunk of streamGemini({
    config: { ...config, thinkingLevel: "low", maxOutputTokens: 1500 },
    systemInstruction: "あなたは世界のニュースを正確に短くまとめる係。検索結果に書かれた事実だけを書く。",
    contents: [{ role: "user", parts: [{ text: ask }] }],
    googleSearch: true,
    signal,
  })) {
    text += chunk.text;
    if (chunk.grounding) grounding = chunk.grounding;
  }
  const items = parseNewsLines(text)
    .map((l) => ({
      title: l.title,
      summary: l.summary,
      region: l.region,
      place: findPlaces(`${l.region} ${l.title}`, 1)[0] ?? null,
      sources: sourcesForLine(l.line, grounding),
    }))
    .filter((i) => i.sources.length > 0);
  return { category, items, fetchedAt: new Date().toISOString() };
}
