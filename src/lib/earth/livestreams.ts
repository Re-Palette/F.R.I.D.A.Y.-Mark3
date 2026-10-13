/**
 * E.D.I.T.H. の LIVE：ピックアップした場所のライブ配信のカメラ映像（YouTube で、いま配信中のもの）。
 *   - 配信者が公開していて、ほかのサイトへの埋め込みが許可されているものだけ（YouTube Data API で確かめる）
 *   - 静止画ではなく動画。いま配信中のものだけなので「LIVE」と出してよい
 *   - 再生は YouTube の公式の埋め込み（youtube-nocookie）。自動再生のため音は消して始める
 */

export interface LiveStream {
  /** YouTube の動画の ID */
  id: string;
  title: string;
  channel: string | null;
  thumbnail: string | null;
  /** 配信が始まった時刻（ISO） */
  startedAt: string | null;
  /** いま見ている人の数（出していない配信は null） */
  viewers: number | null;
}

export type LiveStreamsResponse = { ok: true; source: "YouTube"; fetchedAt: string; query: string; items: LiveStream[] } | { ok: false; error: string };

export const LIVESTREAM_MAX = 12;
/** 同じ場所の検索は、しばらくためておく（YouTube の 1 日の枠を使い切らないように） */
export const LIVESTREAM_POLL_MS = 20 * 60_000;
export const LIVESTREAM_STALE_MS = 45 * 60_000;

const YT_ID = /^[A-Za-z0-9_-]{11}$/;
const str = (v: unknown, max = 160): string | null => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);

/** 日本のあたりか（検索の言葉を日本語にする） */
export const inJapan = (lat: number, lon: number) => lat >= 20 && lat <= 46.5 && lon >= 122 && lon <= 154;

/** 場所の名前 → 検索の言葉（道路カメラなら「道路」も入れる） */
export function liveStreamQuery(place: string, opts: { japan: boolean; traffic?: boolean }): string {
  const name = place.replace(/["'|]/g, "").trim().slice(0, 40);
  if (opts.japan) return opts.traffic ? `${name} 道路 ライブカメラ` : `${name} ライブカメラ`;
  return opts.traffic ? `${name} traffic live camera` : `${name} live cam`;
}

/** 場所の名前として受け取ってよいか（API に渡す） */
export const validPlaceName = (v: unknown): v is string => typeof v === "string" && v.trim().length >= 1 && v.trim().length <= 40 && !/[<>{}\\]/.test(v);

/** YouTube の埋め込みの URL（自動再生・音なしで始める） */
export const liveEmbedUrl = (id: string) => `https://www.youtube-nocookie.com/embed/${encodeURIComponent(id)}?autoplay=1&mute=1&playsinline=1&rel=0`;
export const liveWatchUrl = (id: string) => `https://www.youtube.com/watch?v=${encodeURIComponent(id)}`;

/** https の YouTube の画像だけ通す */
function ytImage(v: unknown): string | null {
  const s = str(v, 400);
  if (!s) return null;
  try {
    const u = new URL(s);
    return u.protocol === "https:" && /(^|\.)ytimg\.com$/.test(u.hostname) ? u.toString() : null;
  } catch {
    return null;
  }
}

/** search.list（type=video, eventType=live）の結果 → 動画の ID の一覧 */
export function parseYouTubeSearchIds(raw: unknown): string[] {
  const items = (raw as { items?: unknown } | null)?.items;
  if (!Array.isArray(items)) throw new Error("YouTube の応答の形が想定と違います");
  const out: string[] = [];
  for (const it of items as Record<string, unknown>[]) {
    const id = (it?.id as { videoId?: unknown } | undefined)?.videoId;
    if (typeof id === "string" && YT_ID.test(id) && !out.includes(id)) out.push(id);
  }
  return out;
}

/** videos.list（part=snippet,liveStreamingDetails,status）→ いま配信中で、埋め込みが許可されているものだけ */
export function parseYouTubeVideos(raw: unknown, max = LIVESTREAM_MAX): LiveStream[] {
  const items = (raw as { items?: unknown } | null)?.items;
  if (!Array.isArray(items)) throw new Error("YouTube の応答の形が想定と違います");
  const out: LiveStream[] = [];
  for (const v of items as Record<string, unknown>[]) {
    if (out.length >= max) break;
    const id = v?.id;
    const sn = (v?.snippet ?? {}) as Record<string, unknown>;
    const st = (v?.status ?? {}) as Record<string, unknown>;
    const lv = (v?.liveStreamingDetails ?? {}) as Record<string, unknown>;
    if (typeof id !== "string" || !YT_ID.test(id)) continue;
    if (sn.liveBroadcastContent !== "live") continue;
    if (st.embeddable === false || (st.privacyStatus !== undefined && st.privacyStatus !== "public")) continue;
    const thumbs = (sn.thumbnails ?? {}) as Record<string, { url?: unknown } | undefined>;
    const started = typeof lv.actualStartTime === "string" ? Date.parse(lv.actualStartTime) : NaN;
    const viewers = typeof lv.concurrentViewers === "string" && /^\d+$/.test(lv.concurrentViewers) ? Number(lv.concurrentViewers) : null;
    out.push({
      id,
      title: str(sn.title) ?? "Live",
      channel: str(sn.channelTitle, 80),
      thumbnail: ytImage(thumbs.medium?.url) ?? ytImage(thumbs.high?.url) ?? ytImage(thumbs.default?.url),
      startedAt: Number.isFinite(started) ? new Date(started).toISOString() : null,
      viewers,
    });
  }
  return out;
}

/** 画面での確認（サーバーの応答） */
export function parseLiveStreamsResponse(raw: unknown): LiveStreamsResponse | null {
  const r = raw as Record<string, unknown> | null;
  if (!r || typeof r !== "object") return null;
  if (r.ok === false) return { ok: false, error: typeof r.error === "string" ? r.error.slice(0, 200) : "取得に失敗しました" };
  if (r.ok !== true || typeof r.fetchedAt !== "string" || !Array.isArray(r.items)) return null;
  const items: LiveStream[] = [];
  for (const s of r.items as Record<string, unknown>[]) {
    if (!s || typeof s.id !== "string" || !YT_ID.test(s.id)) continue;
    items.push({
      id: s.id,
      title: str(s.title) ?? "Live",
      channel: str(s.channel, 80),
      thumbnail: ytImage(s.thumbnail),
      startedAt: typeof s.startedAt === "string" ? s.startedAt : null,
      viewers: typeof s.viewers === "number" && Number.isFinite(s.viewers) ? s.viewers : null,
    });
    if (items.length >= LIVESTREAM_MAX) break;
  }
  return { ok: true, source: "YouTube", fetchedAt: r.fetchedAt, query: typeof r.query === "string" ? r.query.slice(0, 80) : "", items };
}
