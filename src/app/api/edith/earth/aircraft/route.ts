/**
 * GET /api/edith/earth/aircraft?bbox=lamin,lomin,lamax,lomax
 *   → { ok, source: "OpenSky", fetchedAt, bbox, items: [{ icao24, callsign, country, lat, lon, altM, speedMs, heading, verticalMs, reportedAt }] }
 * GOD'S EYE VIEW（EARTH）の飛行機。OpenSky Network の報告を、見ている範囲だけサーバーで取得・確認して返す。
 * 合言葉のロック（proxy.ts）の内側。範囲がおかしい・広すぎるときは 400。失敗は 502 と ok:false（作ったデータは返さない）。
 */
import { getAircraft } from "@/integrations/earth/aircraft";
import { AIRCRAFT_MAX_AREA, bboxArea, parseBBoxQuery } from "@/lib/earth/aircraft";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  const headers: Record<string, string> = { "Cache-Control": "private, no-store" };
  const bbox = parseBBoxQuery(new URL(req.url).searchParams.get("bbox"));
  if (!bbox) return Response.json({ ok: false, error: "範囲の指定が正しくありません。" }, { status: 400, headers });
  if (bboxArea(bbox) > AIRCRAFT_MAX_AREA) return Response.json({ ok: false, error: "範囲が広すぎます（もっと寄ると表示します）。" }, { status: 400, headers });
  const { res, retryAfterSec } = await getAircraft(bbox);
  if (!res.ok && retryAfterSec) headers["Retry-After"] = String(retryAfterSec);
  return Response.json(res, { status: res.ok ? 200 : 502, headers });
}
