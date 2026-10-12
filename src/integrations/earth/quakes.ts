/**
 * GOD'S EYE VIEW（EARTH）の地震（サーバー専用）。
 * 取得と読み取りは、E.D.I.T.H. の情報収集と同じもの（intel/sources/usgs.ts の USGS_URL・parseUsgs、intel/http.ts の getJson：
 * 決まった取得先だけ・時間切れ・大きさの上限・429 と Retry-After）を使い、新しい取得の仕組みは作らない。
 *   - USGS のフィードは約 1 分ごとに更新される（既存の usgs.ts の説明と同じ）。ここでは 60 秒ためておき、それより頻繁には取りに行かない
 *   - 失敗したら、その後 60 秒（相手が待ち時間を言えばその時間）は取りに行かずに失敗を返す
 *   - 実際に取れたデータだけを返す。失敗したときに古いデータや作ったデータを「新しい」として返さない
 */
import { getJson, SourceError, type FetchLike } from "@/integrations/intel/http";
import { parseUsgs, USGS_URL } from "@/integrations/intel/sources/usgs";
import { QUAKE_FEED_LABEL, type QuakePoint, type QuakesResponse } from "@/lib/earth/quakes";

const HOSTS = ["earthquake.usgs.gov"];
export const QUAKE_CACHE_MS = 60_000;
const FAIL_WAIT_MS = 60_000;

type Cache = { at: number; res: Extract<QuakesResponse, { ok: true }> } | null;
let cache: Cache = null;
let failedUntil = 0;
let lastFailure: { error: string; retryAfterMs: number } | null = null;

/** テスト用：ためておいた結果を消す */
export function resetQuakeCache(): void {
  cache = null;
  failedUntil = 0;
  lastFailure = null;
}

export interface QuakeResult {
  res: QuakesResponse;
  /** 失敗のとき、次に取りに来てよいまでの秒数 */
  retryAfterSec?: number;
  /** ためておいた結果を返したか */
  cached: boolean;
}

export async function getQuakes(opts: { now?: number; fetchImpl?: FetchLike } = {}): Promise<QuakeResult> {
  const now = opts.now ?? Date.now();
  if (cache && now - cache.at < QUAKE_CACHE_MS) return { res: cache.res, cached: true };
  if (now < failedUntil && lastFailure) return { res: { ok: false, error: lastFailure.error }, retryAfterSec: Math.ceil((failedUntil - now) / 1000), cached: true };
  try {
    const json = await getJson<unknown>(USGS_URL, { hosts: HOSTS, fetchImpl: opts.fetchImpl, maxBytes: 3_000_000, timeoutMs: 10_000 });
    const items: QuakePoint[] = parseUsgs(json, now).flatMap((i) => {
      const mag = typeof i.facts.mag === "number" ? i.facts.mag : null;
      if (!i.place || mag === null || !i.publishedAt) return [];
      if (!(Math.abs(i.place.lat) <= 90 && Math.abs(i.place.lon) <= 180)) return [];
      return [
        {
          id: i.id.replace(/^usgs:/, ""),
          lat: i.place.lat,
          lon: i.place.lon,
          depthKm: typeof i.facts.depthKm === "number" ? i.facts.depthKm : null,
          mag,
          time: i.publishedAt,
          updated: i.updatedAt,
          place: i.place.name,
          url: i.url,
          status: typeof i.facts.status === "string" ? i.facts.status : null,
        },
      ];
    });
    const res = { ok: true as const, source: "USGS" as const, feed: QUAKE_FEED_LABEL, fetchedAt: new Date(now).toISOString(), items };
    cache = { at: now, res };
    failedUntil = 0;
    lastFailure = null;
    return { res, cached: false };
  } catch (err) {
    const retry = err instanceof SourceError && err.retryAfterMs ? Math.min(err.retryAfterMs, 60 * 60_000) : 0;
    const wait = Math.max(FAIL_WAIT_MS, retry);
    const error = safeError(err, "USGS");
    failedUntil = now + wait;
    lastFailure = { error, retryAfterMs: wait };
    return { res: { ok: false, error }, retryAfterSec: Math.ceil(wait / 1000), cached: false };
  }
}

/** 画面に返してよい短い理由（中の情報・URL の細部は出さない） */
export function safeError(err: unknown, source: string): string {
  if (err instanceof SourceError) {
    if (err.status === 429) return `${source} のアクセス制限中です（しばらく待ってから取り直します）`;
    if (err.kind === "timeout") return `${source} が時間内に応答しませんでした`;
    if (err.kind === "network") return `${source} に接続できませんでした`;
    if (err.kind === "too-large") return `${source} のデータが大きすぎます`;
    if (err.kind === "http") return `${source} がエラーを返しました（HTTP ${err.status ?? "?"}）`;
  }
  return `${source} のデータを読めませんでした`;
}
