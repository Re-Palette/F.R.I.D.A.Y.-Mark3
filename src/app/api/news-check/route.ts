/**
 * GET /api/news-check — FreeNewsApi につながるかを、このサーバー（Vercel）から確かめる（調べる用）。
 * いくつかの頼み方で実際に問い合わせ、状態・かかった時間・返事の頭・読み取れた記事の数を返す。合言葉のロックの内側。
 */
import { parseFreeNews } from "@/integrations/free-news";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BASE = (process.env.FREENEWSAPI_BASE_URL?.trim() || "https://freenewsapi.ai").replace(/\/+$/, "");

const VARIANTS: Record<string, string> = {
  "A 検索語だけ": "q=%E3%83%8B%E3%83%A5%E3%83%BC%E3%82%B9&size=3",
  "B 検索語＋24時間": "q=%E3%83%8B%E3%83%A5%E3%83%BC%E3%82%B9&date=24h&size=3",
  "C 日本の主なニュース（今の頼み方）": "country=jp&lang=ja&date=24h&size=3&sort=date",
  "D 話題＋日本語（今の頼み方）": "q=%E3%83%88%E3%83%A8%E3%82%BF&lang=ja&date=24h&size=3&sort=relevance",
  "E 英語の検索語": "q=Japan&size=3",
};

export async function GET(): Promise<Response> {
  const key = process.env.FREENEWSAPI_KEY?.trim();
  const out = await Promise.all(
    Object.entries(VARIANTS).map(async ([name, qs]) => {
      const url = `${BASE}/v1/search?${qs}`;
      const t0 = Date.now();
      try {
        const res = await fetch(url, {
          headers: { Accept: "application/json", "User-Agent": "FRIDAY-Mark3/1.0", ...(key ? { Authorization: `Bearer ${key}` } : {}) },
          signal: AbortSignal.timeout(8000),
          cache: "no-store",
        });
        const text = await res.text();
        let parsed = -1;
        let keys: string[] = [];
        try {
          const json = JSON.parse(text) as unknown;
          parsed = parseFreeNews(json).length;
          keys = json && typeof json === "object" ? Object.keys(json).slice(0, 10) : [];
        } catch {
          /* JSON でない */
        }
        return { name, url, status: res.status, ms: Date.now() - t0, contentType: res.headers.get("content-type"), keys, parsed, head: text.slice(0, 500) };
      } catch (err) {
        return { name, url, error: err instanceof Error ? `${err.name}: ${err.message}` : String(err), ms: Date.now() - t0 };
      }
    }),
  );
  return new Response(JSON.stringify({ base: BASE, keySet: Boolean(key), freenewsapi: process.env.FREENEWSAPI ?? "(未設定=使う)", checks: out }, null, 2), {
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}
