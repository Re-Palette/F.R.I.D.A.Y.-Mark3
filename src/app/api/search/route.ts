/**
 * GET /api/search?q=… — Web 検索（LangSearch・Brave）。リアルタイム音声会話の web_search から呼ぶ。
 *   → { ok, query, results: [{ title, url, snippet, age }] }（AI が読んで要約して答える）
 * キー（LANGSEARCH_API_KEY・BRAVE_SEARCH_API_KEY）はサーバーの中だけで使い、画面には返さない。合言葉のロックの内側。
 */
import { searchProvider, webSearch } from "@/integrations/web-search";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  const headers = { "Cache-Control": "no-store" };
  const q = new URL(req.url).searchParams.get("q")?.trim().slice(0, 200) ?? "";
  if (!q) return Response.json({ ok: false, error: "検索の言葉が空です。" }, { status: 400, headers });
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
