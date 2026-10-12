/**
 * GOD'S EYE VIEW（EARTH）の地震レイヤー：画面とサーバーで共通の形・表示の決まり。
 * データは USGS の公開 GeoJSON（サーバーの /api/edith/earth/quakes が取得する）。
 *   time      … 地震が発生した時刻（USGS の発表値）
 *   fetchedAt … このシステムが USGS から取得した時刻（発生時刻とは別に出す）
 */

export interface QuakePoint {
  /** USGS のイベント ID */
  id: string;
  lat: number;
  lon: number;
  /** 深さ（km。不明なら null） */
  depthKm: number | null;
  mag: number;
  /** 発生時刻（ISO） */
  time: string;
  /** USGS が最後に更新した時刻（ISO・不明なら null） */
  updated: string | null;
  /** 発生地域（USGS の place。英語） */
  place: string;
  /** USGS のイベントページ */
  url: string | null;
  /** reviewed：確定値 ／ automatic：自動決定（後で変わることがある） */
  status: string | null;
}

export type QuakesResponse =
  | {
      ok: true;
      source: "USGS";
      /** どのフィードか（画面に出す） */
      feed: string;
      /** USGS から取得した時刻（ISO。発生時刻ではない） */
      fetchedAt: string;
      items: QuakePoint[];
    }
  | { ok: false; error: string };

/** 地震のフィード（USGS：M4.5 以上・過去 1 日。既存の情報収集と同じフィード） */
export const QUAKE_FEED_LABEL = "USGS M4.5+ · 過去 24 時間";
/** 画面から取りに行く間隔（サーバー側は 60 秒ためておくので、USGS への取得は 1 分に 1 回まで） */
export const QUAKE_POLL_MS = 2 * 60_000;
/** これより古ければ STALE（取得の間隔の 3 回分） */
export const QUAKE_STALE_MS = 3 * QUAKE_POLL_MS;

/** マグニチュードの区分（凡例と同じ）。色は E.D.I.T.H. の紫から、強いほど白・赤みに */
export const MAG_BANDS = [
  { min: 7, label: "M7.0+", color: "#ff4f8b", size: 22 },
  { min: 6, label: "M6.0–6.9", color: "#ff8fd0", size: 17 },
  { min: 5, label: "M5.0–5.9", color: "#e2b8ff", size: 13 },
  { min: -10, label: "M5.0 未満", color: "#b56cff", size: 9 },
] as const;

export function magBand(mag: number): (typeof MAG_BANDS)[number] {
  return MAG_BANDS.find((b) => mag >= b.min) ?? MAG_BANDS[MAG_BANDS.length - 1];
}

/** 深さの説明（浅い・やや深い・深い。USGS の一般的な区分：70km・300km） */
export function depthText(depthKm: number | null): string {
  if (depthKm === null) return "不明";
  const d = Math.round(depthKm * 10) / 10;
  return `${d} km（${depthKm < 70 ? "浅い" : depthKm < 300 ? "やや深い" : "深い"}）`;
}

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isStr = (v: unknown): v is string => typeof v === "string";

/** 画面で受け取った応答を確かめる（形が違うものは捨てる。全体が違えば null） */
export function parseQuakesResponse(raw: unknown): QuakesResponse | null {
  const r = raw as Record<string, unknown> | null;
  if (!r || typeof r !== "object") return null;
  if (r.ok === false) return { ok: false, error: isStr(r.error) ? r.error.slice(0, 200) : "取得に失敗しました" };
  if (r.ok !== true || !Array.isArray(r.items) || !isStr(r.fetchedAt) || !Number.isFinite(Date.parse(r.fetchedAt))) return null;
  const items: QuakePoint[] = [];
  for (const x of r.items as Record<string, unknown>[]) {
    if (!x || !isStr(x.id) || !isNum(x.lat) || !isNum(x.lon) || !isNum(x.mag) || !isStr(x.time) || !Number.isFinite(Date.parse(x.time))) continue;
    if (Math.abs(x.lat) > 90 || Math.abs(x.lon) > 180) continue;
    items.push({
      id: x.id,
      lat: x.lat,
      lon: x.lon,
      mag: x.mag,
      depthKm: isNum(x.depthKm) ? x.depthKm : null,
      time: x.time,
      updated: isStr(x.updated) && Number.isFinite(Date.parse(x.updated)) ? x.updated : null,
      place: isStr(x.place) ? x.place.slice(0, 200) : "場所不明",
      url: isStr(x.url) && /^https:\/\/earthquake\.usgs\.gov\//.test(x.url) ? x.url : null,
      status: isStr(x.status) ? x.status : null,
    });
  }
  return { ok: true, source: "USGS", feed: isStr(r.feed) ? r.feed : QUAKE_FEED_LABEL, fetchedAt: r.fetchedAt, items };
}
