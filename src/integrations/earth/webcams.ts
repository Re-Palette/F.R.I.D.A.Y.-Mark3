/**
 * GOD'S EYE VIEW（EARTH）の世界のライブカメラ（サーバー専用）。Windy Webcams API v3。
 *   取得先：https://api.windy.com/webcams/api/v3/webcams?nearby=<緯度>,<経度>,<半径km>&include=images,location,player,urls,categories
 *   - キーは環境変数 WINDY_WEBCAMS_KEY（ヘッダー x-windy-api-key で送る。画面・ログ・エラー文に出さない）
 *   - 同じ場所（0.05 度刻み）・半径・種類は 5 分ためておく（静止画の URL は 10 分ほどで使えなくなるので、それより短く）
 *   - キーの誤り（401・403）は 30 分、429 は相手の待ち時間か 10 分、そのほかは 60 秒、取りに行かない
 */
import { getText, SourceError, type FetchLike } from "@/integrations/intel/http";
import { parseWindy, webcamQuery, WEBCAM_LIMIT, type WebcamsResponse } from "@/lib/earth/webcams";

const API = "https://api.windy.com/webcams/api/v3/webcams";
const HOSTS = ["api.windy.com"];
export const WEBCAM_CACHE_MS = 5 * 60_000;
const MAX_CACHE_ENTRIES = 60;

type Ok = Extract<WebcamsResponse, { ok: true }>;
const cache = new Map<string, { at: number; res: Ok }>();
let blockedUntil = 0;
let blockedError = "";

/** テスト用 */
export function resetWebcamCache(): void {
  cache.clear();
  blockedUntil = 0;
  blockedError = "";
}

export async function getWebcams(
  q: { lat: number; lon: number; radiusKm?: number; traffic?: boolean },
  opts: { now?: number; fetchImpl?: FetchLike; env?: Record<string, string | undefined> } = {},
): Promise<{ res: WebcamsResponse; retryAfterSec?: number; cached: boolean }> {
  const now = opts.now ?? Date.now();
  const key = (opts.env ?? process.env).WINDY_WEBCAMS_KEY?.trim();
  if (!key) return { res: { ok: false, error: "Windy Webcams のキーが未設定です（WINDY_WEBCAMS_KEY）" }, cached: true };
  const at = webcamQuery(q.lat, q.lon, q.radiusKm);
  if (!at) return { res: { ok: false, error: "場所の指定が正しくありません" }, cached: true };
  const traffic = q.traffic === true;
  const ck = `${at.lat},${at.lon},${at.radiusKm},${traffic ? "t" : "a"}`;
  const hit = cache.get(ck);
  if (hit && now - hit.at < WEBCAM_CACHE_MS) return { res: hit.res, cached: true };
  if (now < blockedUntil) return { res: { ok: false, error: blockedError }, retryAfterSec: Math.ceil((blockedUntil - now) / 1000), cached: true };

  const base: FetchLike = opts.fetchImpl ?? fetch;
  const fetchImpl = ((input: string, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    headers.set("x-windy-api-key", key);
    return base(input, { ...init, headers });
  }) as FetchLike;
  try {
    const params = new URLSearchParams({
      nearby: `${at.lat},${at.lon},${at.radiusKm}`,
      limit: String(WEBCAM_LIMIT),
      include: "images,location,player,urls,categories",
    });
    if (traffic) params.set("categories", "traffic");
    const text = await getText(`${API}?${params.toString()}`, { hosts: HOSTS, fetchImpl, maxBytes: 3_000_000, timeoutMs: 12_000, accept: "application/json" });
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new SourceError("Windy の応答を読めませんでした", undefined, undefined, "other");
    }
    const items = parseWindy(json);
    const res: Ok = { ok: true, source: "Windy", fetchedAt: new Date(now).toISOString(), center: { lat: at.lat, lon: at.lon }, radiusKm: at.radiusKm, traffic, items };
    if (cache.size >= MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value as string);
    cache.set(ck, { at: now, res });
    return { res, cached: false };
  } catch (err) {
    const se = err instanceof SourceError ? err : null;
    let wait = 60_000;
    let error = "Windy のデータを読めませんでした";
    if (se?.status === 401 || se?.status === 403) {
      wait = 30 * 60_000;
      error = "Windy Webcams のキーが使えません（WINDY_WEBCAMS_KEY を確認してください）";
    } else if (se?.status === 429) {
      wait = Math.max(60_000, se.retryAfterMs ?? 10 * 60_000);
      error = "Windy のアクセスの制限中です（しばらく待ってから取り直します）";
    } else if (se?.kind === "timeout") error = "Windy が時間内に応答しませんでした";
    else if (se?.kind === "network") error = "Windy に接続できませんでした";
    else if (se?.status) error = `Windy がエラーを返しました（HTTP ${se.status}）`;
    blockedUntil = now + wait;
    blockedError = error;
    return { res: { ok: false, error }, retryAfterSec: Math.ceil(wait / 1000), cached: false };
  }
}
