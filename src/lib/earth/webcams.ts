/**
 * GOD'S EYE VIEW（EARTH）の世界のライブカメラ（Windy Webcams API v3）。
 *   - 運営者が公開している道路・街・観光地などのカメラだけ（Windy に登録されたもの）。私有のカメラをのぞくようなものは扱わない
 *   - 映像は「数分ごとの静止画」と、Windy の再生画面（タイムラプス。カメラによってはライブ）。静止画の URL は時間がたつと使えなくなるので取り直す
 *   - 出典の表示（Windy.com へのリンク）が必要
 *   ※ 応答の形は公式の説明に合わせて読むが、最終確認はできていない。読めない項目は捨て、作ったデータは出さない
 */

export interface Webcam {
  id: string;
  title: string;
  city: string | null;
  country: string | null;
  lat: number;
  lon: number;
  /** 道路・交通のカメラか */
  traffic: boolean;
  /** 静止画（大きめ・小さめ）。時間がたつと使えなくなる */
  preview: string | null;
  thumbnail: string | null;
  /** Windy の再生画面（埋め込み） */
  player: string | null;
  /** Windy のカメラのページ */
  detail: string | null;
  /** 最後に画像が更新された時刻（ISO） */
  updatedAt: string | null;
}

export type WebcamsResponse =
  | { ok: true; source: "Windy"; fetchedAt: string; center: { lat: number; lon: number }; radiusKm: number; traffic: boolean; items: Webcam[] }
  | { ok: false; error: string };

/** 一度に探す半径の上限（km。Windy の上限は 250） */
export const WEBCAM_RADIUS_MAX = 50;
export const WEBCAM_RADIUS_DEFAULT = 15;
export const WEBCAM_LIMIT = 50;
/** 静止画の URL が使えなくなる前に取り直す間隔 */
export const WEBCAM_POLL_MS = 8 * 60_000;
/** これより古い一覧は「古い」と表示する */
export const WEBCAM_STALE_MS = 15 * 60_000;
/** 地球儀を引いているときは探さない（見ている高さがこれ以下のときだけ） */
export const WEBCAM_MAX_VIEW_HEIGHT_M = 400_000;

const str = (v: unknown, max = 120): string | null => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : null);

/** https で、Windy のサイトの URL だけ通す（ほかの場所は読み込まない） */
export function windyUrl(v: unknown): string | null {
  const s = str(v, 500);
  if (!s) return null;
  try {
    const u = new URL(s);
    if (u.protocol !== "https:") return null;
    const h = u.hostname.toLowerCase();
    return h === "windy.com" || h.endsWith(".windy.com") ? u.toString() : null;
  } catch {
    return null;
  }
}

/** 探す場所（緯度・経度は 0.05 度刻み、半径は 1〜上限 km） */
export function webcamQuery(lat: number, lon: number, radiusKm: number = WEBCAM_RADIUS_DEFAULT): { lat: number; lon: number; radiusKm: number } | null {
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180 || !Number.isFinite(radiusKm)) return null;
  const r = (x: number) => Math.round(x * 20) / 20;
  return { lat: r(lat), lon: r(lon), radiusKm: Math.round(Math.min(WEBCAM_RADIUS_MAX, Math.max(1, radiusKm))) };
}

/** Windy の応答（{ webcams: [...] }）を読む。形が違えば例外 */
export function parseWindy(raw: unknown, max = WEBCAM_LIMIT): Webcam[] {
  const list = (raw as { webcams?: unknown } | null)?.webcams;
  if (!Array.isArray(list)) throw new Error("Windy の応答の形が想定と違います");
  const out: Webcam[] = [];
  for (const w of list as Record<string, unknown>[]) {
    if (out.length >= max) break;
    if (!w || typeof w !== "object") continue;
    if (w.status !== undefined && w.status !== "active") continue;
    const id = num(w.webcamId) ?? num(w.id);
    const loc = (w.location ?? {}) as Record<string, unknown>;
    const lat = num(loc.latitude);
    const lon = num(loc.longitude);
    if (id === null || lat === null || lon === null || Math.abs(lat) > 90 || Math.abs(lon) > 180) continue;
    const images = (w.images ?? {}) as Record<string, Record<string, unknown> | undefined>;
    const cur = images.current ?? {};
    const player = (w.player ?? {}) as Record<string, unknown>;
    const urls = (w.urls ?? {}) as Record<string, unknown>;
    const cats = Array.isArray(w.categories) ? (w.categories as Record<string, unknown>[]) : [];
    const t = typeof w.lastUpdatedOn === "string" ? Date.parse(w.lastUpdatedOn) : NaN;
    out.push({
      id: String(Math.trunc(id)),
      title: str(w.title) ?? "Webcam",
      city: str(loc.city, 60),
      country: str(loc.country, 60),
      lat,
      lon,
      traffic: cats.some((c) => c && (c.id === "traffic" || c.id === "road")),
      preview: windyUrl(cur.preview),
      thumbnail: windyUrl(cur.thumbnail) ?? windyUrl(cur.preview),
      player: windyUrl(player.live) ?? windyUrl(player.day) ?? windyUrl(player.lifetime),
      detail: windyUrl(urls.detail),
      updatedAt: Number.isFinite(t) ? new Date(t).toISOString() : null,
    });
  }
  return out;
}

/** 画面での確認（サーバーの応答） */
export function parseWebcamsResponse(raw: unknown): WebcamsResponse | null {
  const r = raw as Record<string, unknown> | null;
  if (!r || typeof r !== "object") return null;
  if (r.ok === false) return { ok: false, error: typeof r.error === "string" ? r.error.slice(0, 200) : "取得に失敗しました" };
  const c = r.center as { lat?: unknown; lon?: unknown } | undefined;
  if (r.ok !== true || typeof r.fetchedAt !== "string" || !Array.isArray(r.items) || !c || num(c.lat) === null || num(c.lon) === null) return null;
  const items: Webcam[] = [];
  for (const w of r.items as Record<string, unknown>[]) {
    const lat = num(w?.lat);
    const lon = num(w?.lon);
    if (!w || typeof w.id !== "string" || !/^\d{1,20}$/.test(w.id) || lat === null || lon === null || Math.abs(lat) > 90 || Math.abs(lon) > 180) continue;
    items.push({
      id: w.id,
      title: str(w.title) ?? "Webcam",
      city: str(w.city, 60),
      country: str(w.country, 60),
      lat,
      lon,
      traffic: w.traffic === true,
      preview: windyUrl(w.preview),
      thumbnail: windyUrl(w.thumbnail),
      player: windyUrl(w.player),
      detail: windyUrl(w.detail),
      updatedAt: typeof w.updatedAt === "string" ? w.updatedAt : null,
    });
    if (items.length >= WEBCAM_LIMIT) break;
  }
  return { ok: true, source: "Windy", fetchedAt: r.fetchedAt, center: { lat: num(c.lat)!, lon: num(c.lon)! }, radiusKm: num(r.radiusKm) ?? WEBCAM_RADIUS_DEFAULT, traffic: r.traffic === true, items };
}

/** 2 点間のおおよその距離（km） */
export function distanceKm(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const rad = Math.PI / 180;
  const dLat = (bLat - aLat) * rad;
  const dLon = (bLon - aLon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * rad) * Math.cos(bLat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
}
