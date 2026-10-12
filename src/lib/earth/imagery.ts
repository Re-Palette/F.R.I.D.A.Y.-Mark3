/**
 * GOD'S EYE VIEW（EARTH）の地球の画像・リアルタイムの重ね合わせ・ライブ映像の定義（API キー不要・無料のものだけ）。
 *   - 詳細な衛星写真：Sentinel-2 cloudless（EOX）。10m 程度まで。非商用で利用できる（CC BY-NC-SA 4.0）。
 *     表示するときは、リンク付きのクレジットを見える場所に出す
 *   - 今日の地球（雲）：NASA GIBS の MODIS（Terra）の真色画像。毎日更新（前日分を使う。当日分は欠けていることがある）
 *   - 雨雲レーダー：RainViewer の公開 API（個人・教育目的は無料。リンク付きのクレジットを出す）。約 10 分ごと
 *   - 宇宙ステーションのライブ映像：NASA 公式の YouTube ライブ（押したときだけ読み込む。youtube-nocookie）
 *   ※ 各サービスの利用条件は公式ページの説明・検索で確認した範囲。原文の最終確認と、本番での表示の確認が必要
 * 画像・映像はブラウザが各サービスから直接読み込む（このサーバーは中継しない。秘密の値は使わない）
 */

/** 読み込んでよい外部のホスト（これ以外は使わない） */
export const IMAGERY_HOSTS = ["tiles.maps.eox.at", "gibs.earthdata.nasa.gov", "api.rainviewer.com", "tilecache.rainviewer.com", "www.youtube-nocookie.com"] as const;

export interface CreditLink {
  label: string;
  href: string;
}
export interface ImageryCredit {
  text: string;
  links: CreditLink[];
}

/* ---------- 詳細な衛星写真（Sentinel-2 cloudless） ---------- */

export const S2_YEAR = 2023;
export const S2_URL = `https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-${S2_YEAR}_3857/default/GoogleMapsCompatible/{z}/{y}/{x}.jpg`;
/** これより細かい段階は取りに行かない（それ以上は拡大して表示） */
export const S2_MAX_LEVEL = 15;
export const S2_CREDIT: ImageryCredit = {
  text: `Sentinel-2 cloudless by EOX IT Services GmbH (Contains modified Copernicus Sentinel data ${S2_YEAR})`,
  links: [
    { label: "s2maps.eu", href: "https://s2maps.eu" },
    { label: "CC BY-NC-SA 4.0", href: "https://creativecommons.org/licenses/by-nc-sa/4.0/" },
  ],
};

/* ---------- 今日の地球（NASA GIBS） ---------- */

export const GIBS_MAX_LEVEL = 9;
/** 使う日（UTC の前日。当日分はまだ撮れていない地域が多い） */
export function gibsDate(now: number): string {
  return new Date(now - 24 * 60 * 60_000).toISOString().slice(0, 10);
}
export function gibsUrl(date: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("bad date");
  return `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/MODIS_Terra_CorrectedReflectance_TrueColor/default/${date}/GoogleMapsCompatible_Level${GIBS_MAX_LEVEL}/{z}/{y}/{x}.jpg`;
}
export const GIBS_CREDIT: ImageryCredit = {
  text: "Imagery: NASA EOSDIS GIBS (MODIS Terra Corrected Reflectance)",
  links: [{ label: "NASA GIBS", href: "https://nasa-gibs.github.io/gibs-api-docs/" }],
};

/* ---------- 雨雲レーダー（RainViewer） ---------- */

export const RAINVIEWER_MAPS_URL = "https://api.rainviewer.com/public/weather-maps.json";
const RAINVIEWER_TILE_HOST = "https://tilecache.rainviewer.com";
/** 取りに行く間隔（データは約 10 分ごと） */
export const RADAR_POLL_MS = 10 * 60_000;
/** これより古い画像なら STALE */
export const RADAR_STALE_MS = 30 * 60_000;
/** これより細かい段階は取りに行かない（無料の API は細かい段階に制限があるため控えめに） */
export const RADAR_MAX_LEVEL = 7;
export const RADAR_CREDIT: ImageryCredit = {
  text: "Weather data by RainViewer",
  links: [{ label: "rainviewer.com", href: "https://www.rainviewer.com" }],
};

export interface RadarFrame {
  /** 観測の時刻（ISO） */
  time: string;
  /** タイルの URL の型（{z}/{x}/{y}） */
  url: string;
}

/** RainViewer の weather-maps.json から、いちばん新しい観測（過去）の画像を取り出す。形がおかしければ null */
export function parseRainViewer(raw: unknown): RadarFrame | null {
  const r = raw as { host?: unknown; radar?: { past?: unknown } } | null;
  if (!r || typeof r !== "object" || r.host !== RAINVIEWER_TILE_HOST) return null;
  const past = r.radar && Array.isArray(r.radar.past) ? (r.radar.past as { time?: unknown; path?: unknown }[]) : [];
  let best: { time: number; path: string } | null = null;
  for (const f of past) {
    if (typeof f?.time !== "number" || !Number.isFinite(f.time) || typeof f.path !== "string" || !/^\/v2\/radar\/[A-Za-z0-9_-]{1,64}$/.test(f.path)) continue;
    if (!best || f.time > best.time) best = { time: f.time, path: f.path };
  }
  if (!best) return null;
  return { time: new Date(best.time * 1000).toISOString(), url: `${RAINVIEWER_TILE_HOST}${best.path}/256/{z}/{x}/{y}/2/1_1.png` };
}

/** 画面の取得の仕組みで使う形（1 件の配列にして、件数の判定にそろえる） */
export type RadarResponse = { ok: true; fetchedAt: string; items: RadarFrame[] } | { ok: false; error: string };
export function parseRadarResponse(raw: unknown): RadarResponse | null {
  // JSON でない（HTTP のエラーなど）→ null（呼ぶ側が HTTP の番号で理由を出す）
  if (!raw || typeof raw !== "object") return null;
  const f = parseRainViewer(raw);
  return f ? { ok: true, fetchedAt: new Date().toISOString(), items: [f] } : { ok: false, error: "雨雲レーダーのデータの形が想定と違います" };
}

/* ---------- 宇宙ステーションのライブ映像（NASA 公式 YouTube） ---------- */

/** NASA の YouTube チャンネルのライブ（時間帯によって ISS 以外の中継や、通信の切り替えで青い画面になることがある） */
export const ISS_LIVE_EMBED = "https://www.youtube-nocookie.com/embed/live_stream?channel=UCLA_DiR1FfKNvjuUpBHmylQ&autoplay=1&mute=1&playsinline=1";
export const ISS_LIVE_PAGE = "https://www.youtube.com/@NASA/live";
/** 衛星の名前が国際宇宙ステーションか */
export const isIssName = (name: string) => /^ISS\b/i.test(name.trim());
