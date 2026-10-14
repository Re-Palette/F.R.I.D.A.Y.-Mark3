/**
 * 調べもの（Web 検索）を外の検索 API で行う。キーはサーバーの中だけで使う。
 *   1. LangSearch（LANGSEARCH_API_KEY。無料・1 日の上限あり。ページの本文も取れる）
 *   2. Brave Search（BRAVE_SEARCH_API_KEY）
 *   どちらも無い・失敗したときは null（呼ぶ側が Gemini の Google 検索に戻す）
 * F.R.I.D.A.Y. は、取ってきた検索結果（見出し・本文や説明・日付）を読んで要約して答える。
 * 同じ検索は 10 分のあいだ覚えておく（回数を節約）。
 */

const LANGSEARCH_ENDPOINT = "https://api.langsearch.com/v1/web-search";
const BRAVE_ENDPOINT = "https://api.search.brave.com/res/v1/web/search";
const CACHE_MS = 10 * 60_000;
const CACHE_MAX = 50;
/** 検索結果の数（多すぎると要約が遅くなる） */
const COUNT = 8;
/** 1 件あたり AI に渡す本文の長さ */
const TEXT_CHARS = 1200;

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;
type Env = Record<string, string | undefined>;

export type SearchProvider = "langsearch" | "brave";

export interface SearchResult {
  title: string;
  url: string;
  /** 本文の抜き出し・説明 */
  snippet: string;
  /** ページの日付（分かるときだけ） */
  age: string | null;
  /** ニュースの記事か */
  news: boolean;
}

export interface WebSearch {
  query: string;
  provider: SearchProvider;
  results: SearchResult[];
}

export const PROVIDER_LABEL: Record<SearchProvider, string> = { langsearch: "LangSearch", brave: "Brave Search" };

/** 使う検索 API（LangSearch を優先）。キーが無ければ null */
export function searchProvider(env: Env = process.env): SearchProvider | null {
  if (env.LANGSEARCH_API_KEY?.trim()) return "langsearch";
  if (env.BRAVE_SEARCH_API_KEY?.trim() || env.BRAVE_API_KEY?.trim()) return "brave";
  return null;
}

/** 発言の中の「指示語」（前の話の続き） */
const FOLLOW_UP = /^(それ|あれ|これ|その|あの|この|さっき|そっち|そいつ|じゃあ|では|で、|なら)|(それ|あれ|その件|そこ)(の|は|って|に)/;

/**
 * 発言から検索の言葉を作る。頼む言葉（「調べて」「教えて」など）を取り、
 * 「それの最新は？」のような続きの質問は、ひとつ前の発言を前に付ける。
 */
export function searchQuery(latest: string, previousUser?: string): string {
  const clean = (s: string) =>
    s
      .replace(/^(ねえ|ねぇ|ヘイ|hey|ok)?[\s、,]*(フライデー|friday|f\.r\.i\.d\.a\.y\.|イーディス|エディス|edith|e\.d\.i\.t\.h\.|カレン|karen)[\s、,。!！]*/i, "")
      .replace(/(について|のこと)?を?(ネットで|ウェブで|webで|web で)?(調べて|検索して|ググって|教えて|探して)(ください|くれる|くれない|ほしい|欲しい)?[。！!？?]*$/i, "")
      .replace(/(ください|下さい|お願い(します)?)[。！!]*$/, "")
      .replace(/[\s　]+/g, " ")
      .trim();
  let q = clean(latest);
  const prev = previousUser ? clean(previousUser) : "";
  if (prev && (FOLLOW_UP.test(q) || q.length < 6)) q = `${prev.slice(0, 60)} ${q}`;
  return (q || latest.trim()).slice(0, 200);
}

/** 新しさが大事な検索か（ニュース・今日のこと）。そのときは 1 週間以内のページに絞る */
const RECENT = /ニュース|速報|今日|昨日|今朝|今夜|いま起き|最新の(ニュース|情報|発表)/;

const cache = new Map<string, { at: number; value: WebSearch }>();

const stripTags = (s: string) =>
  s
    .replace(/<[^>]+>/g, "")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();

/** 検索結果を 1 つにそろえる（URL の重複・見出しの無いものは除く） */
function collect(items: { title?: string; url?: string; parts: string[]; age?: string | null; news?: boolean }[], max: number): SearchResult[] {
  const seen = new Set<string>();
  const out: SearchResult[] = [];
  for (const it of items) {
    const url = it.url?.trim();
    const title = stripTags(it.title ?? "");
    if (!url || !/^https?:\/\//.test(url) || !title || seen.has(url)) continue;
    seen.add(url);
    const parts = it.parts.map(stripTags).filter(Boolean);
    out.push({ title, url, snippet: [...new Set(parts)].join(" … ").slice(0, TEXT_CHARS), age: it.age?.trim() || null, news: Boolean(it.news) });
    if (out.length >= max) break;
  }
  return out;
}

async function langSearch(q: string, key: string, fetchImpl: FetchLike, signal?: AbortSignal): Promise<SearchResult[]> {
  const res = await fetchImpl(LANGSEARCH_ENDPOINT, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      query: q,
      count: COUNT,
      ...(RECENT.test(q) ? { freshness: "oneWeek" } : {}),
      contents: { text: { max_characters: TEXT_CHARS } },
    }),
    signal,
  });
  if (!res.ok) throw new Error(`LangSearch の応答が ${res.status} でした`);
  const data = (await res.json()) as {
    code?: number | string;
    msg?: string;
    message?: string;
    data?: { webPages?: { value?: { name?: string; url?: string; text?: string; snippet?: string; summary?: string; datePublished?: string; dateLastCrawled?: string }[] } };
  };
  if (data.code !== undefined && String(data.code) !== "200") throw new Error(`LangSearch：${data.message ?? data.msg ?? data.code}`);
  return collect(
    (data.data?.webPages?.value ?? []).map((p) => ({
      title: p.name,
      url: p.url,
      parts: [p.text ?? p.summary ?? p.snippet ?? ""],
      age: p.datePublished ? p.datePublished.slice(0, 10) : null,
    })),
    COUNT,
  );
}

interface BraveItem {
  title?: string;
  url?: string;
  description?: string;
  extra_snippets?: string[];
  age?: string;
  page_age?: string;
}

async function braveSearch(q: string, key: string, fetchImpl: FetchLike, signal?: AbortSignal): Promise<SearchResult[]> {
  const params = new URLSearchParams({
    q,
    count: String(COUNT),
    country: "JP",
    search_lang: "jp",
    ui_lang: "ja-JP",
    safesearch: "moderate",
    text_decorations: "false",
    extra_snippets: "true",
  });
  const res = await fetchImpl(`${BRAVE_ENDPOINT}?${params}`, {
    headers: { Accept: "application/json", "X-Subscription-Token": key },
    signal,
  });
  if (!res.ok) throw new Error(`Brave Search の応答が ${res.status} でした`);
  const data = (await res.json()) as { web?: { results?: BraveItem[] }; news?: { results?: BraveItem[] } };
  const item = (it: BraveItem, news: boolean) => ({
    title: it.title,
    url: it.url,
    parts: [it.description ?? "", ...(it.extra_snippets ?? []).slice(0, 2)],
    age: it.age || it.page_age || null,
    news,
  });
  // ニュースがあれば先に（最新の話題のとき役に立つ）。ただし 3 件まで
  return collect([...(data.news?.results ?? []).slice(0, 3).map((it) => item(it, true)), ...(data.web?.results ?? []).map((it) => item(it, false))], COUNT);
}

/** 検索する。キーが無いときは null。失敗したときは例外（呼ぶ側が Google 検索に戻す） */
export async function webSearch(query: string, opts: { env?: Env; fetchImpl?: FetchLike; signal?: AbortSignal; now?: () => number } = {}): Promise<WebSearch | null> {
  const env = opts.env ?? process.env;
  const provider = searchProvider(env);
  const q = query.trim();
  if (!provider || !q) return null;
  const now = opts.now ?? Date.now;
  const cacheKey = `${provider}:${q}`;
  const hit = cache.get(cacheKey);
  if (hit && now() - hit.at < CACHE_MS) return hit.value;

  const fetchImpl = opts.fetchImpl ?? fetch;
  const results =
    provider === "langsearch"
      ? await langSearch(q, env.LANGSEARCH_API_KEY!.trim(), fetchImpl, opts.signal)
      : await braveSearch(q, (env.BRAVE_SEARCH_API_KEY?.trim() || env.BRAVE_API_KEY?.trim())!, fetchImpl, opts.signal);
  const value: WebSearch = { query: q, provider, results };

  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value!);
  cache.set(cacheKey, { at: now(), value });
  return value;
}

/** AI に渡す検索結果の説明（これを読んで要約して答える） */
export function searchSection(s: WebSearch): string {
  const label = PROVIDER_LABEL[s.provider];
  const lines = s.results.map(
    (r, i) => `[${i + 1}] ${r.title}${r.news ? "（ニュース）" : ""}${r.age ? `（${r.age}）` : ""}\n${new URL(r.url).hostname}\n${r.snippet}`,
  );
  return `

# Web 検索の結果（${label}。検索語「${s.query}」）
- 今回の検索は ${label} で行った（Google 検索は使わない）。下の検索結果を読み、要点を要約して答える。
- 話し方・返事の長さ・形はいつもの会話のまま。検索で分かったことを、自分の言葉で分かりやすく要約して伝える。日付・数字・固有名詞は検索結果のとおりに書く。
- 検索結果に書かれていないことは足さない・推測で埋めない。結果どうしで食い違うときは、そう伝える。古い情報（日付が古い）なら、そう添える。
- 検索結果で答えが見つからなければ、「検索では確かな情報が見つかりませんでした」と正直に言う。
- 出典は画面に自動で表示されるので、本文に URL は書かない。
${lines.length ? lines.join("\n\n") : "（検索結果は 0 件でした）"}`;
}
