/**
 * GOD'S EYE VIEW（EARTH）のレイヤーごとの状態。実際に取得できたかどうかだけから決める（推測で LIVE にしない）。
 *   LOADING … 最初の取得の途中（まだ一度も取れていない）
 *   LIVE    … 決めた時間内に取得できた（地震：一定間隔で更新される公開データ。衛星：軌道データが取れていて、位置は計算した推定）
 *   STALE   … 前に取れたデータはあるが、最後の取得に失敗した・決めた時間より古い（表示は前のデータのまま、古いと示す）
 *   NO DATA … 取得はできたが 0 件
 *   ERROR   … 一度も取れていない（失敗）
 *   OFFLINE … この端末がオフライン
 */
export type LayerStatus = "LOADING" | "LIVE" | "STALE" | "NO DATA" | "ERROR" | "OFFLINE";

/** 取得の記録（時刻はミリ秒） */
export interface LayerFetchState {
  /** 取得の途中か */
  loading: boolean;
  /** 最後に取得できた時刻（一度も無ければ null） */
  lastOkAt: number | null;
  /** 最後に取得できた件数 */
  lastCount: number;
  /** 最後の失敗の理由（画面に出せる短い文） */
  lastError: string | null;
  /** 最後の失敗の時刻 */
  lastErrorAt: number | null;
}

export const EMPTY_FETCH: LayerFetchState = { loading: false, lastOkAt: null, lastCount: 0, lastError: null, lastErrorAt: null };

export function layerStatus(s: LayerFetchState, o: { now: number; online: boolean; staleAfterMs: number }): LayerStatus {
  if (!o.online) return "OFFLINE";
  if (s.lastOkAt === null) {
    if (s.loading) return "LOADING";
    return s.lastError ? "ERROR" : "LOADING";
  }
  // 前に取れたが、その後の取得に失敗した・古くなった
  if (s.lastErrorAt !== null && s.lastErrorAt > s.lastOkAt) return "STALE";
  if (o.now - s.lastOkAt > o.staleAfterMs) return "STALE";
  if (s.lastCount === 0) return "NO DATA";
  return "LIVE";
}

/** 「〇分前」（未来・不正な時刻は「—」） */
export function agoText(at: number | null, now: number): string {
  if (at === null || !Number.isFinite(at)) return "—";
  const s = Math.round((now - at) / 1000);
  if (s < -60) return "—";
  if (s < 60) return `${Math.max(0, s)} 秒前`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} 分前`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} 時間前`;
  return `${Math.round(h / 24)} 日前`;
}

/** 日時を「2026-10-12 05:12:03 UTC」の形に（不正なら「—」） */
export function utcText(at: number | string | null): string {
  if (at === null) return "—";
  const t = typeof at === "number" ? at : Date.parse(at);
  if (!Number.isFinite(t)) return "—";
  return new Date(t).toISOString().slice(0, 19).replace("T", " ") + " UTC";
}
