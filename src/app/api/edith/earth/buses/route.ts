/**
 * GET /api/edith/earth/buses → { ok, source: "ODPT", fetchedAt, items: [{ id, number, route, lat, lon, azimuth, reportedAt }] }
 * 都営バスの位置（公共交通オープンデータ。キーはサーバーだけ）。合言葉のロック（proxy.ts）の内側。
 * キーが未設定なら 503、失敗は 502 と ok:false（作ったデータは返さない）。
 */
import { getBuses } from "@/integrations/earth/buses";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const headers: Record<string, string> = { "Cache-Control": "private, no-store" };
  const { res, retryAfterSec } = await getBuses();
  if (!res.ok && retryAfterSec) headers["Retry-After"] = String(retryAfterSec);
  const unset = !res.ok && /未設定/.test(res.error);
  return Response.json(res, { status: res.ok ? 200 : unset ? 503 : 502, headers });
}
