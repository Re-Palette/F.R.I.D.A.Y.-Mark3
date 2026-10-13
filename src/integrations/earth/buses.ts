/**
 * GOD'S EYE VIEW（EARTH）の都営バスの位置（サーバー専用）。公共交通オープンデータ（ODPT）の odpt:Bus。
 *   取得先：https://api.odpt.org/api/v4/odpt:Bus?odpt:operator=odpt.Operator:Toei&acl:consumerKey=<キー>
 *   - キーは環境変数 ODPT_CONSUMER_KEY（サーバーだけ。画面・ログ・エラー文に出さない）
 *   - 25 秒ためておき、それより頻繁には取りに行かない（バスの位置は数十秒ごとに更新）
 *   - キーの誤り（401・403）は 30 分、429 は相手の待ち時間か 10 分、そのほかは 60 秒、取りに行かない
 *   - 出典：公共交通オープンデータセンター・東京都交通局（CC BY 4.0）
 */
import { getText, SourceError, type FetchLike } from "@/integrations/intel/http";
import { parseOdptBuses, type BusesResponse } from "@/lib/earth/transport";

const HOSTS = ["api.odpt.org"];
export const BUS_CACHE_MS = 25_000;

type Ok = Extract<BusesResponse, { ok: true }>;
let cache: { at: number; res: Ok } | null = null;
let blockedUntil = 0;
let blockedError = "";

/** テスト用 */
export function resetBusCache(): void {
  cache = null;
  blockedUntil = 0;
  blockedError = "";
}

export async function getBuses(opts: { now?: number; fetchImpl?: FetchLike; env?: Record<string, string | undefined> } = {}): Promise<{ res: BusesResponse; retryAfterSec?: number; cached: boolean }> {
  const now = opts.now ?? Date.now();
  const key = (opts.env ?? process.env).ODPT_CONSUMER_KEY?.trim();
  if (!key) return { res: { ok: false, error: "ODPT のキーが未設定です（ODPT_CONSUMER_KEY）" }, cached: true };
  if (cache && now - cache.at < BUS_CACHE_MS) return { res: cache.res, cached: true };
  if (now < blockedUntil) return { res: { ok: false, error: blockedError }, retryAfterSec: Math.ceil((blockedUntil - now) / 1000), cached: true };
  try {
    const url = `https://api.odpt.org/api/v4/odpt:Bus?odpt:operator=odpt.Operator:Toei&acl:consumerKey=${encodeURIComponent(key)}`;
    const text = await getText(url, { hosts: HOSTS, fetchImpl: opts.fetchImpl, maxBytes: 8_000_000, timeoutMs: 15_000, accept: "application/json" });
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new SourceError("ODPT の応答を読めませんでした", undefined, undefined, "other");
    }
    const items = parseOdptBuses(json);
    const res: Ok = { ok: true, source: "ODPT", fetchedAt: new Date(now).toISOString(), items };
    cache = { at: now, res };
    return { res, cached: false };
  } catch (err) {
    const se = err instanceof SourceError ? err : null;
    let wait = 60_000;
    let error = "ODPT のデータを読めませんでした";
    if (se?.status === 401 || se?.status === 403) {
      wait = 30 * 60_000;
      error = "ODPT のキーが使えません（ODPT_CONSUMER_KEY を確認してください）";
    } else if (se?.status === 429) {
      wait = Math.max(60_000, se.retryAfterMs ?? 10 * 60_000);
      error = "ODPT のアクセスの制限中です（しばらく待ってから取り直します）";
    } else if (se?.kind === "timeout") error = "ODPT が時間内に応答しませんでした";
    else if (se?.kind === "network") error = "ODPT に接続できませんでした";
    else if (se?.status) error = `ODPT がエラーを返しました（HTTP ${se.status}）`;
    blockedUntil = now + wait;
    blockedError = error;
    return { res: { ok: false, error }, retryAfterSec: Math.ceil(wait / 1000), cached: false };
  }
}
