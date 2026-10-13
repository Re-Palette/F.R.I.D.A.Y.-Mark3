/**
 * GET /api/edith/earth/ships?bbox=lamin,lomin,lamax,lomax → { ok, source: "AISStream", fetchedAt, bbox, items: [{ mmsi, name, lat, lon, sog, heading, reportedAt }] }
 * 船の位置（AISStream。要求のたびに数秒つないで集める。キーはサーバーだけ）。合言葉のロック（proxy.ts）の内側。
 * 範囲がおかしい・広すぎるときは 400、キーが未設定なら 503、失敗は 502。
 */
import { getShips } from "@/integrations/earth/ships";
import { bboxArea, parseBBoxQuery } from "@/lib/earth/aircraft";
import { SHIP_MAX_AREA } from "@/lib/earth/transport";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 20;

export async function GET(req: Request): Promise<Response> {
  const headers: Record<string, string> = { "Cache-Control": "private, no-store" };
  const bbox = parseBBoxQuery(new URL(req.url).searchParams.get("bbox"));
  if (!bbox || bboxArea(bbox) > SHIP_MAX_AREA) return Response.json({ ok: false, error: "範囲の指定が正しくないか、広すぎます。" }, { status: 400, headers });
  const { res, retryAfterSec } = await getShips(bbox);
  if (!res.ok && retryAfterSec) headers["Retry-After"] = String(retryAfterSec);
  const unset = !res.ok && /未設定/.test(res.error);
  return Response.json(res, { status: res.ok ? 200 : unset ? 503 : 502, headers });
}
