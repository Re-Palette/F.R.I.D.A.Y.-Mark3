/**
 * GET /api/edith/earth/quakes → { ok, source: "USGS", feed, fetchedAt, items: [{ id, lat, lon, depthKm, mag, time, updated, place, url, status }] }
 * GOD'S EYE VIEW（EARTH）の地震。USGS の公開データをサーバーで取得・確認して返す（60 秒ためておく）。
 * 合言葉のロック（proxy.ts）の内側。秘密の値は使わない。失敗は ok:false（作ったデータは返さない）。
 */
import { getQuakes } from "@/integrations/earth/quakes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const { res, retryAfterSec } = await getQuakes();
  const headers: Record<string, string> = { "Cache-Control": "private, no-store" };
  if (!res.ok && retryAfterSec) headers["Retry-After"] = String(retryAfterSec);
  return Response.json(res, { status: res.ok ? 200 : 502, headers });
}
