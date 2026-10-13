/**
 * E.D.I.T.H. の LIVE：ライブ配信のカメラ映像を YouTube Data API v3 で探す（サーバー専用）。
 *   1. search.list（type=video・eventType=live・videoEmbeddable=true）で「<場所> ライブカメラ」を探す（1 回 100 ユニット）
 *   2. videos.list で、いま配信中・公開・埋め込み可かを確かめ、見ている人数・開始時刻を取る（1 ユニット）
 *   - キーは環境変数 YOUTUBE_API_KEY（サーバーだけ。画面・ログ・エラー文に出さない）
 *   - 1 日の枠（無料は 10,000 ユニット）を使い切らないよう、同じ検索は 20 分ためておく
 *   - 枠を使い切った（403 quotaExceeded）ときは 1 時間、キーの誤りは 30 分、そのほかは 2 分、取りに行かない
 */
import { getText, SourceError, type FetchLike } from "@/integrations/intel/http";
import { LIVESTREAM_MAX, parseYouTubeSearchIds, parseYouTubeVideos, type LiveStreamsResponse } from "@/lib/earth/livestreams";

const API = "https://www.googleapis.com/youtube/v3";
const HOSTS = ["www.googleapis.com"];
export const LIVESTREAM_CACHE_MS = 20 * 60_000;
const MAX_CACHE_ENTRIES = 80;

type Ok = Extract<LiveStreamsResponse, { ok: true }>;
const cache = new Map<string, { at: number; res: Ok }>();
let blockedUntil = 0;
let blockedError = "";

/** テスト用 */
export function resetLiveStreamCache(): void {
  cache.clear();
  blockedUntil = 0;
  blockedError = "";
}

async function getJson(url: string, fetchImpl?: FetchLike): Promise<unknown> {
  const text = await getText(url, { hosts: HOSTS, fetchImpl, maxBytes: 2_000_000, timeoutMs: 12_000, accept: "application/json" });
  try {
    return JSON.parse(text);
  } catch {
    throw new SourceError("YouTube の応答を読めませんでした", undefined, undefined, "other");
  }
}

export async function getLiveStreams(
  query: string,
  opts: { now?: number; fetchImpl?: FetchLike; env?: Record<string, string | undefined>; japan?: boolean } = {},
): Promise<{ res: LiveStreamsResponse; retryAfterSec?: number; cached: boolean }> {
  const now = opts.now ?? Date.now();
  const key = (opts.env ?? process.env).YOUTUBE_API_KEY?.trim();
  if (!key) return { res: { ok: false, error: "YouTube のキーが未設定です（YOUTUBE_API_KEY）" }, cached: true };
  const q = query.trim().slice(0, 80);
  if (!q) return { res: { ok: false, error: "探す言葉がありません" }, cached: true };
  const hit = cache.get(q);
  if (hit && now - hit.at < LIVESTREAM_CACHE_MS) return { res: hit.res, cached: true };
  if (now < blockedUntil) return { res: { ok: false, error: blockedError }, retryAfterSec: Math.ceil((blockedUntil - now) / 1000), cached: true };
  try {
    const sp = new URLSearchParams({
      part: "snippet",
      type: "video",
      eventType: "live",
      videoEmbeddable: "true",
      safeSearch: "strict",
      maxResults: String(Math.min(25, LIVESTREAM_MAX * 2)),
      q,
      key,
    });
    if (opts.japan) {
      sp.set("regionCode", "JP");
      sp.set("relevanceLanguage", "ja");
    }
    const ids = parseYouTubeSearchIds(await getJson(`${API}/search?${sp.toString()}`, opts.fetchImpl));
    let items: Ok["items"] = [];
    if (ids.length) {
      const vp = new URLSearchParams({ part: "snippet,liveStreamingDetails,status", id: ids.join(","), key });
      items = parseYouTubeVideos(await getJson(`${API}/videos?${vp.toString()}`, opts.fetchImpl));
    }
    const res: Ok = { ok: true, source: "YouTube", fetchedAt: new Date(now).toISOString(), query: q, items };
    if (cache.size >= MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value as string);
    cache.set(q, { at: now, res });
    return { res, cached: false };
  } catch (err) {
    const se = err instanceof SourceError ? err : null;
    let wait = 2 * 60_000;
    let error = "YouTube のデータを読めませんでした";
    if (se?.status === 403) {
      // 枠の使い切り・キーの制限のどちらも 403。どちらでもしばらく待つ
      wait = 60 * 60_000;
      error = "YouTube の 1 日の枠を使い切ったか、キーが使えません（YOUTUBE_API_KEY と YouTube Data API v3 の有効化を確認してください）";
    } else if (se?.status === 400 || se?.status === 401) {
      wait = 30 * 60_000;
      error = "YouTube のキーが使えません（YOUTUBE_API_KEY を確認してください）";
    } else if (se?.status === 429) {
      wait = Math.max(60_000, se.retryAfterMs ?? 10 * 60_000);
      error = "YouTube のアクセスの制限中です（しばらく待ってから取り直します）";
    } else if (se?.kind === "timeout") error = "YouTube が時間内に応答しませんでした";
    else if (se?.kind === "network") error = "YouTube に接続できませんでした";
    else if (se?.status) error = `YouTube がエラーを返しました（HTTP ${se.status}）`;
    blockedUntil = now + wait;
    blockedError = error;
    return { res: { ok: false, error }, retryAfterSec: Math.ceil(wait / 1000), cached: false };
  }
}
