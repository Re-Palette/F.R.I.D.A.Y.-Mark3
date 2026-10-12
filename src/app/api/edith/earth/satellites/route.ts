/**
 * GET /api/edith/earth/satellites?group=stations|visual|weather|gnss
 *   → { ok, source: "CelesTrak", group, fetchedAt, elements: [{ id, name, intlId, epoch, omm }] }
 * GOD'S EYE VIEW（EARTH）の人工衛星の軌道データ（CelesTrak の公開 GP データ。グループごとに 2 時間ためておく）。
 * 位置はここでは計算しない（画面の satellite.js で計算する）。合言葉のロック（proxy.ts）の内側。
 * 失敗は 502 と { ok: false, error, reason, scope, retryAt, last }（reason 以降は追加の項目。古い画面は無視するだけ）。
 *   Retry-After：次に自動で確認する時刻までの秒数。自動では取りに行かない状態なら 6 時間（画面が状態を確かめに来る間隔。外へは取りに行かない）
 */
import { getSatellites } from "@/integrations/earth/satellites";
import { isSatGroup } from "@/lib/earth/satellites";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  const headers: Record<string, string> = { "Cache-Control": "private, no-store" };
  const group = new URL(req.url).searchParams.get("group") ?? "stations";
  if (!isSatGroup(group)) return Response.json({ ok: false, error: "衛星のグループの指定が正しくありません。" }, { status: 400, headers });
  const { res, retryAfterSec } = await getSatellites(group);
  if (!res.ok && retryAfterSec) headers["Retry-After"] = String(retryAfterSec);
  return Response.json(res, { status: res.ok ? 200 : 502, headers });
}
