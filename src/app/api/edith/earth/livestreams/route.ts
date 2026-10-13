/**
 * GET /api/edith/earth/livestreams?place=渋谷&lat=35.66&lon=139.70&cat=traffic
 *   → { ok, source: "YouTube", fetchedAt, query, items: [{ id, title, channel, thumbnail, startedAt, viewers }] }
 * ピックアップした場所の、いま配信中のライブカメラ（YouTube。埋め込み可・公開のものだけ）。合言葉のロック（proxy.ts）の内側。
 * 検索の言葉はサーバーで作る（場所の名前だけ受け取る）。キーが未設定なら 503、指定が正しくなければ 400、失敗は 502。
 */
import { getLiveStreams } from "@/integrations/earth/livestreams";
import { inJapan, liveStreamQuery, validPlaceName } from "@/lib/earth/livestreams";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  const headers: Record<string, string> = { "Cache-Control": "private, no-store" };
  const sp = new URL(req.url).searchParams;
  const place = sp.get("place");
  const lat = Number(sp.get("lat"));
  const lon = Number(sp.get("lon"));
  if (!validPlaceName(place) || !Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    return Response.json({ ok: false, error: "場所の指定が正しくありません" }, { status: 400, headers });
  }
  const japan = inJapan(lat, lon);
  const q = liveStreamQuery(place, { japan, traffic: sp.get("cat") === "traffic" });
  const { res, retryAfterSec } = await getLiveStreams(q, { japan });
  if (!res.ok && retryAfterSec) headers["Retry-After"] = String(retryAfterSec);
  const unset = !res.ok && /未設定/.test(res.error);
  return Response.json(res, { status: res.ok ? 200 : unset ? 503 : 502, headers });
}
