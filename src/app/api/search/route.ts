/**
 * GET /api/search?q=… — Web 検索（LangSearch・Brave）。リアルタイム音声会話の web_search から呼ぶ。
 *   → { ok, query, results: [{ title, url, snippet, age }] }（AI が読んで要約して答える）
 * キー（LANGSEARCH_API_KEY・BRAVE_SEARCH_API_KEY）はサーバーの中だけで使い、画面には返さない。合言葉のロックの内側。
 */
import { searchProvider, webSearch } from "@/integrations/web-search";
import { articleDetails, articlesMentioned, findNews, freeNewsEnabled, type NewsArticle } from "@/integrations/free-news";
import { asksForNews, asksForNewsDetail, newsTopic } from "@/integrations/news";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  const headers = { "Cache-Control": "no-store" };
  const q = new URL(req.url).searchParams.get("q")?.trim().slice(0, 200) ?? "";
  if (!q) return Response.json({ ok: false, error: "検索の言葉が空です。" }, { status: 400, headers });
  const signal = AbortSignal.any([req.signal, AbortSignal.timeout(5000)]);
  const answer = (topic: string, articles: NewsArticle[]) => {
    const results = articles.map((a) => ({ title: a.title, url: a.url, snippet: a.body ?? a.description, age: a.publishedAt, source: a.source }));
    return Response.json({ ok: true, query: topic, kind: "news", count: results.length, results }, { headers });
  };
  // さっき伝えたニュースの詳細（検索の言葉が、最近見せた記事の見出しに近い）：その記事の本文を返す
  const mentioned = freeNewsEnabled() ? articlesMentioned(q, 2) : [];
  if (mentioned.length) return answer(mentioned[0].title, await articleDetails(mentioned, { signal }));
  // ニュースの検索は FreeNewsApi の記事だけから（検索 API・Google 検索は使わない）
  if (freeNewsEnabled() && asksForNews(q)) {
    const detail = asksForNewsDetail(q);
    const topic = newsTopic(q) ?? (q.replace(/(最新|最近|今日)の?|ニュース|報道|速報|詳細|詳しく|[？?。]/g, " ").trim() || "ニュース");
    const articles = await findNews(topic, { signal, size: detail ? 3 : 5, fullText: detail }).catch(() => []);
    if (!articles.length) return Response.json({ ok: false, kind: "news", error: "ニュースの記事を取得できませんでした。" }, { headers });
    return answer(topic, articles);
  }
  if (!searchProvider()) return Response.json({ ok: false, error: "検索 API のキー（LANGSEARCH_API_KEY）が設定されていません。" }, { status: 503, headers });
  try {
    // 声の会話（Live）から呼ぶので、少なめ・短めにして返事を速くする。待つのは 3 秒まで
    const found = await webSearch(q, { signal: AbortSignal.any([req.signal, AbortSignal.timeout(3000)]), count: 4, chars: 400 });
    const results = (found?.results ?? []).map((r) => ({ title: r.title, url: r.url, snippet: r.snippet, age: r.age }));
    return Response.json({ ok: true, query: found?.query ?? q, count: results.length, results }, { headers });
  } catch (err) {
    console.warn("[friday] web search failed:", err instanceof Error ? err.message : err);
    return Response.json({ ok: false, error: "検索できませんでした。少し待ってからもう一度試してください。" }, { status: 502, headers });
  }
}
