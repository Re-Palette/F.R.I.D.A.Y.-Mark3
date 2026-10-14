/**
 * ニュースの記事を FreeNewsApi（https://freenewsapi.ai。キー不要）から持ってくる。サーバーの中だけで使う。
 *   GET /v1/search?q=…&date=24h&size=…&country=jp&lang=ja&sort=date
 * 使う場所：E.D.I.T.H. の NEWS・朝のニュースのまとめ・通知の見出し。
 * 記事（見出し・説明・出典・日時・URL）は本物をそのまま使い、要約・日本語の見出しは Gemini が記事から作る。
 * 取れない・0 件のときは、呼ぶ側がこれまでどおり Gemini の Google 検索に戻す。
 * 環境変数：FREENEWSAPI=off で使わない。FREENEWSAPI_KEY があれば送る（無くても動く）。
 */

const DEFAULT_BASE = "https://freenewsapi.ai";
const CACHE_MS = 10 * 60_000;
const CACHE_MAX = 60;
const TIMEOUT_MS = 6000;

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;
type Env = Record<string, string | undefined>;

export interface NewsArticle {
  title: string;
  description: string;
  url: string;
  /** 出した媒体（publisher・ドメイン） */
  source: string;
  /** 公開日時（ISO。分からなければ null） */
  publishedAt: string | null;
  /** 本文（詳細を頼んだときだけ。full_text=true で返ってきたもの） */
  body?: string;
}

export interface FreeNewsQuery {
  q?: string;
  /** 期間（24h・today など。null で期間を絞らない） */
  date?: string | null;
  size?: number;
  country?: string;
  lang?: string;
  sort?: "date" | "relevance" | "crawled";
  /** 本文も返してもらう（ニュースの詳細を聞かれたとき） */
  fullText?: boolean;
}

export function freeNewsEnabled(env: Env = process.env): boolean {
  return env.FREENEWSAPI?.trim().toLowerCase() !== "off";
}

const str = (v: unknown): string => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");
const clean = (s: string) =>
  s
    .replace(/<[^>]+>/g, "")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

/** 日時を ISO に（数字なら UNIX 秒・ミリ秒） */
function isoOf(v: unknown): string | null {
  if (typeof v === "number" && Number.isFinite(v)) return new Date(v < 1e12 ? v * 1000 : v).toISOString();
  const s = str(v).trim();
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

/**
 * 返ってきた JSON から記事を取り出す。項目名の揺れを受け付ける
 * （articles / results / data / items / 配列そのもの。title / headline、url / link、description / summary など）。
 */
export function parseFreeNews(json: unknown): NewsArticle[] {
  const root = json as Record<string, unknown> | unknown[] | null;
  const pick = (o: Record<string, unknown> | null | undefined): unknown[] | null => {
    if (!o || typeof o !== "object") return null;
    for (const k of ["articles", "results", "items", "news", "data", "hits"]) {
      const v = o[k];
      if (Array.isArray(v)) return v;
      if (v && typeof v === "object") {
        const inner = pick(v as Record<string, unknown>);
        if (inner) return inner;
      }
    }
    return null;
  };
  const list = Array.isArray(root) ? root : (pick(root as Record<string, unknown>) ?? []);
  const seen = new Set<string>();
  const out: NewsArticle[] = [];
  for (const raw of list) {
    if (!raw || typeof raw !== "object") continue;
    const a = raw as Record<string, unknown>;
    const url = str(a.url ?? a.link ?? a.article_url ?? a.source_url).trim();
    const title = clean(str(a.title ?? a.headline ?? a.name));
    if (!/^https?:\/\//.test(url) || title.length < 4 || seen.has(url)) continue;
    seen.add(url);
    const src = a.source && typeof a.source === "object" ? (a.source as Record<string, unknown>) : null;
    const publisher = a.publisher && typeof a.publisher === "object" ? (a.publisher as Record<string, unknown>) : null;
    const description = clean(str(a.description ?? a.summary ?? a.snippet ?? a.excerpt ?? a.lead ?? a.text ?? a.full_text)).slice(0, 400);
    const body = clean(str(a.full_text ?? a.fullText ?? a.content ?? a.body ?? a.text)).slice(0, 3000);
    out.push({
      title,
      description,
      ...(body.length > description.length + 40 ? { body } : {}),
      url,
      source: clean(str(publisher?.name ?? a.publisher ?? src?.name ?? a.source ?? a.domain ?? a.site)) || hostOf(url),
      publishedAt: isoOf(a.published_at ?? a.publishedAt ?? a.published ?? a.pubDate ?? a.date ?? a.sec ?? a.crawled_at),
    });
  }
  return out;
}

const cache = new Map<string, { at: number; value: NewsArticle[] }>();

/** 記事を探す。失敗したときは例外（呼ぶ側が Google 検索に戻す） */
export async function freeNews(
  query: FreeNewsQuery,
  opts: { env?: Env; fetchImpl?: FetchLike; signal?: AbortSignal; now?: () => number } = {},
): Promise<NewsArticle[]> {
  const env = opts.env ?? process.env;
  if (!freeNewsEnabled(env)) return [];
  const params = new URLSearchParams();
  if (query.q?.trim()) params.set("q", query.q.trim());
  if (query.date !== null) params.set("date", query.date ?? "24h");
  params.set("size", String(query.size ?? 10));
  if (query.country) params.set("country", query.country);
  if (query.lang) params.set("lang", query.lang);
  if (query.sort) params.set("sort", query.sort);
  if (query.fullText) params.set("full_text", "true");
  const url = `${(env.FREENEWSAPI_BASE_URL?.trim() || DEFAULT_BASE).replace(/\/+$/, "")}/v1/search?${params}`;
  const now = opts.now ?? Date.now;
  const hit = cache.get(url);
  if (hit && now() - hit.at < CACHE_MS) return hit.value;

  const key = env.FREENEWSAPI_KEY?.trim();
  const started = now();
  const signal = opts.signal ? AbortSignal.any([opts.signal, AbortSignal.timeout(TIMEOUT_MS)]) : AbortSignal.timeout(TIMEOUT_MS);
  const res = await (opts.fetchImpl ?? fetch)(url, {
    headers: { Accept: "application/json", ...(key ? { Authorization: `Bearer ${key}` } : {}) },
    signal,
  });
  if (!res.ok) throw new Error(`FreeNewsApi の応答が ${res.status} でした`);
  const json = (await res.json()) as unknown;
  const value = parseFreeNews(json);
  // かかった時間・件数を残す（0 件なら返ってきた形も残して、読み取りの誤りを見分けられるように）
  console.info(
    `[friday] free-news ${now() - started}ms ${value.length}件 ${params.toString()}${
      value.length ? "" : ` keys=${json && typeof json === "object" ? Object.keys(json).slice(0, 8).join(",") : typeof json}`
    }`,
  );
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value!);
  if (value.length) cache.set(url, { at: now(), value });
  remember(value);
  return value;
}

/* ---- 最近見せた記事（「これの詳細は？」のとき、どの記事の話かをすぐ見つけるため） ---- */

const shown = new Map<string, NewsArticle>();
const SHOWN_MAX = 300;

function remember(articles: NewsArticle[]) {
  for (const a of articles) {
    shown.delete(a.url);
    shown.set(a.url, a);
    if (shown.size > SHOWN_MAX) shown.delete(shown.keys().next().value!);
  }
}

/** 文字の 2 つ組（日本語の見出しの近さを測る） */
function grams(s: string): Set<string> {
  const t = s.replace(/[\s、。・「」『』（）()【】!！?？:：,，.．"'｜|-]/g, "").toLowerCase();
  const out = new Set<string>();
  for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2));
  return out;
}

/**
 * 直前の返事が、最近見せたどの記事の話か（見出しの言葉がどれだけ返事に出てくるかで選ぶ）。近い順に最大 limit 件。
 * 「これの詳細は？」のとき、AI に聞き直さずにすぐ記事を決めるために使う。
 */
export function articlesMentioned(answer: string, limit = 3): NewsArticle[] {
  if (!answer.trim() || !shown.size) return [];
  const a = grams(answer);
  const scored: { art: NewsArticle; score: number }[] = [];
  for (const art of shown.values()) {
    const g = grams(art.title);
    if (g.size < 3) continue;
    let hit = 0;
    for (const x of g) if (a.has(x)) hit++;
    const score = hit / g.size;
    if (score >= 0.45) scored.push({ art, score });
  }
  return scored.sort((x, y) => y.score - x.score).slice(0, limit).map((x) => x.art);
}

/**
 * 記事の詳細（本文）を持ってくる。見出しで探し直して本文つきで受け取る（同じ URL のものを優先）。
 * 本文が取れなければ、元の記事（見出し・説明）のまま返す
 */
export async function articleDetails(
  articles: NewsArticle[],
  opts: { env?: Env; fetchImpl?: FetchLike; signal?: AbortSignal } = {},
): Promise<NewsArticle[]> {
  return Promise.all(
    articles.map(async (a) => {
      if (a.body) return a;
      const found = await freeNews({ q: a.title.slice(0, 80), date: null, size: 3, sort: "relevance", fullText: true }, opts).catch(() => [] as NewsArticle[]);
      const same = found.find((x) => x.url === a.url) ?? found.find((x) => x.body && grams(x.title).size && [...grams(x.title)].filter((g) => grams(a.title).has(g)).length / grams(a.title).size > 0.6);
      return same?.body ? { ...a, body: same.body } : a;
    }),
  );
}

/**
 * 今日のニュース（朝のまとめ・通知の見出し用）：日本の主なニュースと、興味のある分野ごとの記事。
 * 日本の主なニュースは、検索語なしで断られたら「ニュース」で探し直す。
 */
export async function dailyNews(
  topics: string[],
  opts: { env?: Env; fetchImpl?: FetchLike; signal?: AbortSignal } = {},
): Promise<{ main: NewsArticle[]; byTopic: { topic: string; articles: NewsArticle[] }[] }> {
  const mainTask = freeNews({ country: "jp", lang: "ja", date: "24h", size: 10, sort: "date" }, opts)
    .catch(() => [] as NewsArticle[])
    .then((a) => (a.length ? a : freeNews({ q: "ニュース", country: "jp", lang: "ja", date: "24h", size: 10, sort: "date" }, opts)));
  const topicTasks = topics.slice(0, 6).map((topic) =>
    freeNews({ q: topic, lang: "ja", date: "24h", size: 4, sort: "relevance" }, opts)
      .catch(() => [] as NewsArticle[])
      .then((articles) => ({ topic, articles })),
  );
  const [main, byTopic] = await Promise.all([mainTask.catch(() => [] as NewsArticle[]), Promise.all(topicTasks)]);
  // 同じ記事を二度出さない
  const seen = new Set(main.map((a) => a.url));
  return {
    main,
    byTopic: byTopic.map((t) => ({ topic: t.topic, articles: t.articles.filter((a) => !seen.has(a.url) && (seen.add(a.url), true)) })),
  };
}

/** 記事の一覧（AI に渡す）。番号は 1 から */
export function articleLines(articles: NewsArticle[], timezone = "Asia/Tokyo"): string {
  const fmt = new Intl.DateTimeFormat("ja-JP", { timeZone: timezone, month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
  return articles
    .map(
      (a, i) =>
        `[${i + 1}] ${a.title}（${a.source}${a.publishedAt ? `・${fmt.format(new Date(a.publishedAt))}` : ""}）${a.body ? `\n本文：${a.body.slice(0, 1500)}` : a.description ? `\n${a.description}` : ""}`,
    )
    .join("\n");
}

/**
 * 話題のニュースを探す（「アメリカ」「トヨタ」など）。日本語の記事と全言語の記事を同時に探し、日本語を先に並べる。
 * 24 時間で 1 件も無ければ、期間を絞らずに日本語で探し直す。fullText で本文も受け取る（詳細を聞かれたとき）
 */
export async function findNews(
  q: string,
  opts: { env?: Env; fetchImpl?: FetchLike; signal?: AbortSignal; size?: number; fullText?: boolean } = {},
): Promise<NewsArticle[]> {
  const fullText = opts.fullText;
  const size = opts.size ?? 8;
  const safe = (p: Promise<NewsArticle[]>) => p.catch(() => [] as NewsArticle[]);
  const [ja, any] = await Promise.all([
    safe(freeNews({ q, lang: "ja", date: "24h", size, sort: "relevance", fullText }, opts)),
    safe(freeNews({ q, date: "24h", size, sort: "relevance", fullText }, opts)),
  ]);
  const seen = new Set<string>();
  let out = [...ja, ...any].filter((a) => !seen.has(a.url) && (seen.add(a.url), true));
  // 1 件も無いときだけ、期間を絞らずに探し直す（待ち時間を増やさない）
  if (!out.length) {
    const older = await safe(freeNews({ q, lang: "ja", date: null, size, sort: "relevance", fullText }, opts));
    out = [...out, ...older.filter((a) => !seen.has(a.url) && (seen.add(a.url), true))];
  }
  return out.slice(0, size);
}
