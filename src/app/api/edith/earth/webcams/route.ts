/**
 * GET /api/edith/earth/webcams?lat=35.66&lon=139.70&r=15&cat=traffic
 *   → { ok, source: "Windy", fetchedAt, center, radiusKm, traffic, items: [{ id, title, city, country, lat, lon, traffic, preview, thumbnail, player, detail, updatedAt }] }
 * 指定した場所の近くの公開ライブカメラ（Windy Webcams。キーはサーバーだけ）。合言葉のロック（proxy.ts）の内側。
 * キーが未設定なら 503、場所の指定が正しくなければ 400、失敗は 502 と ok:false（作ったデータは返さない）。
 */
import { getWebcams } from "@/integrations/earth/webcams";
import { webcamQuery } from "@/lib/earth/webcams";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  const headers: Record<string, string> = { "Cache-Control": "private, no-store" };
  const sp = new URL(req.url).searchParams;
  const num = (k: string) => (sp.get(k) === null || sp.get(k) === "" ? NaN : Number(sp.get(k)));
  const r = sp.get("r") === null ? undefined : num("r");
  const q = webcamQuery(num("lat"), num("lon"), r);
  if (!q) return Response.json({ ok: false, error: "場所の指定が正しくありません" }, { status: 400, headers });
  const { res, retryAfterSec } = await getWebcams({ ...q, traffic: sp.get("cat") === "traffic" });
  if (!res.ok && retryAfterSec) headers["Retry-After"] = String(retryAfterSec);
  const unset = !res.ok && /未設定/.test(res.error);
  return Response.json(res, { status: res.ok ? 200 : unset ? 503 : 502, headers });
}
