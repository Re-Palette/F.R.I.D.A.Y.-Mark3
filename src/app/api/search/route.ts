/**
 * GET /api/search?q=… — ニュースの記事を探す（FreeNewsApi）。リアルタイム音声会話の news_search から呼ぶ。
 *   → { ok, query, results: [{ title, url, snippet, age, source }] }（AI が読んで要約して答える）
 *   さっき伝えたニュースの詳細（検索の言葉が最近見せた記事の見出しに近い）なら、その記事の本文を返す。
 * Google 検索は使わない。合言葉のロックの内側。
 */
import { articleDetails, articlesMentioned, findNews, freeNewsEnabled, type NewsArticle } from "@/integrations/free-news";
import { asksForNewsDetail, newsTopic } from "@/integrations/news";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  const headers = { "Cache-Control": "no-store" };
  const q = new URL(req.url).searchParams.get("q")?.trim().slice(0, 200) ?? "";
  if (!q) return Response.json({ ok: false, error: "検索の言葉が空です。" }, { status: 400, headers });
  if (!freeNewsEnabled()) return Response.json({ ok: false, error: "ニュースの記事の取得はオフになっています。" }, { status: 503, headers });
  const signal = AbortSignal.any([req.signal, AbortSignal.timeout(5000)]);
  const answer = (topic: string, articles: NewsArticle[]) => {
    const results = articles.map((a) => ({ title: a.title, url: a.url, snippet: a.body ?? a.description, age: a.publishedAt, source: a.source }));
    return Response.json({ ok: true, query: topic, kind: "news", count: results.length, results }, { headers });
  };
  // さっき伝えたニュースの詳細：その記事の本文を返す
  const mentioned = articlesMentioned(q, 2);
  if (mentioned.length) return answer(mentioned[0].title, await articleDetails(mentioned, { signal }));
  const detail = asksForNewsDetail(q);
  const topic = newsTopic(q) ?? (q.replace(/(最新|最近|今日)の?|ニュース|報道|速報|詳細|詳しく|[？?。]/g, " ").trim() || "ニュース");
  const articles = await findNews(topic, { signal, size: detail ? 3 : 5, fullText: detail }).catch(() => []);
  if (!articles.length) return Response.json({ ok: false, kind: "news", error: "ニュースの記事を取得できませんでした。" }, { headers });
  return answer(topic, articles);
}
