/**
 * GET /api/cams-check — 公開カメラ（Windy Webcams・YouTube のライブ配信）につながるかを、このサーバー（Vercel）から確かめる（調べる用）。
 * 東京駅のあたりで実際に 1 回ずつ問い合わせ、キーの有無・状態・かかった時間・返事の頭・読み取れた数を返す。
 * キーの値は返さない（返事の中に出てきても伏せる）。YouTube は 1 回で 101 ユニット使う。合言葉のロックの内側。
 */
import { parseWindy } from "@/lib/earth/webcams";
import { parseYouTubeSearchIds } from "@/lib/earth/livestreams";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const LAT = 35.68;
const LON = 139.77;

function hide(text: string, keys: (string | undefined)[]): string {
  let t = text;
  for (const k of keys) if (k) t = t.split(k).join("<key>");
  return t;
}

async function probe(url: string, init: RequestInit, keys: (string | undefined)[], count: (json: unknown) => number) {
  const t0 = Date.now();
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(10_000), cache: "no-store" });
    const text = await res.text();
    let parsed: number | string = "-";
    try {
      parsed = count(JSON.parse(text));
    } catch (err) {
      parsed = `読めない（${err instanceof Error ? err.message : String(err)}）`;
    }
    return { status: res.status, ms: Date.now() - t0, contentType: res.headers.get("content-type"), parsed, head: hide(text.slice(0, 600), keys) };
  } catch (err) {
    return { status: 0, ms: Date.now() - t0, error: hide(err instanceof Error ? `${err.name}: ${err.message}` : String(err), keys) };
  }
}

export async function GET(): Promise<Response> {
  const windyKey = process.env.WINDY_WEBCAMS_KEY?.trim();
  const ytKey = process.env.YOUTUBE_API_KEY?.trim();
  const keys = [windyKey, ytKey];
  const [windy, youtube] = await Promise.all([
    windyKey
      ? probe(
          `https://api.windy.com/webcams/api/v3/webcams?nearby=${LAT},${LON},15&limit=5&include=images,location,player,urls,categories`,
          { headers: { "x-windy-api-key": windyKey, Accept: "application/json" } },
          keys,
          (j) => parseWindy(j).length,
        )
      : { skipped: "WINDY_WEBCAMS_KEY が未設定" },
    ytKey
      ? probe(
          `https://www.googleapis.com/youtube/v3/search?${new URLSearchParams({ part: "snippet", type: "video", eventType: "live", videoEmbeddable: "true", maxResults: "5", q: "東京 ライブカメラ", key: ytKey })}`,
          { headers: { Accept: "application/json" } },
          keys,
          (j) => parseYouTubeSearchIds(j).length,
        )
      : { skipped: "YOUTUBE_API_KEY が未設定" },
  ]);
  const body = { keys: { windy: Boolean(windyKey), youtube: Boolean(ytKey) }, windy, youtube };
  return new Response(JSON.stringify(body, null, 2), { headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } });
}
