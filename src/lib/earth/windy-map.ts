/**
 * E.D.I.T.H. の WEATHER（Windy の天気の地図。Windy Map Forecast API）。
 *   - 風の流れ・雨・気温・雲・気圧・波などを、動く地図で見せる（Windy のライブラリをブラウザが直接読み込む）
 *   - キーはブラウザに渡す必要がある（Google の 3D の街と同じ）。Windy のキーの設定で、このサイトのドメインだけで使えるように制限しておくこと
 *   - 地図の右下などに Windy のロゴ・出典が出る（消さない）
 *   ※ ライブラリの使い方は公式の説明（windyInit・store.set("overlay", ...)）に合わせたが、本物のキーでの確認はできていない
 */

export type WindyOverlay = "wind" | "gust" | "rain" | "temp" | "clouds" | "pressure" | "rh" | "waves";

export const WINDY_OVERLAYS: { key: WindyOverlay; label: string; short: string }[] = [
  { key: "wind", label: "風の流れ", short: "WIND" },
  { key: "gust", label: "突風", short: "GUST" },
  { key: "rain", label: "雨・雷（予報）", short: "RAIN" },
  { key: "temp", label: "気温", short: "TEMP" },
  { key: "clouds", label: "雲（予報）", short: "CLOUDS" },
  { key: "pressure", label: "気圧", short: "PRESSURE" },
  { key: "rh", label: "湿度", short: "HUMIDITY" },
  { key: "waves", label: "波", short: "WAVES" },
];

export const WINDY_OVERLAY_LABEL = Object.fromEntries(WINDY_OVERLAYS.map((o) => [o.key, o.label])) as Record<WindyOverlay, string>;

export interface WeatherSettings {
  overlay: WindyOverlay;
}
export const WEATHER_SETTINGS_KEY = "friday.edith-weather.v1";
export const DEFAULT_WEATHER: WeatherSettings = { overlay: "wind" };

export const isWindyOverlay = (v: unknown): v is WindyOverlay => WINDY_OVERLAYS.some((o) => o.key === v);

export function parseWeatherSettings(raw: unknown): WeatherSettings {
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  return { overlay: isWindyOverlay(o.overlay) ? o.overlay : DEFAULT_WEATHER.overlay };
}

/** Windy のキーとして受け取ってよい形か（画面に渡すので、形の違うものは使わない） */
export const validWindyMapKey = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9_-]{16,80}$/.test(v);

/** 見る高さ（m）→ 地図の拡大の段階（Leaflet の zoom。3〜11） */
export function zoomForHeight(heightM: number | null | undefined): number {
  if (!heightM || !Number.isFinite(heightM) || heightM <= 0) return 5;
  // 高さ 40km（街）→ 9 前後、1,500km（国）→ 5 前後、それ以上は引く
  const z = Math.round(Math.log2(40_000_000 / heightM) - 1);
  return Math.min(11, Math.max(3, z));
}

/** Windy のライブラリ（公式。Leaflet は 1.4.0 を指定されている） */
export const WINDY_LIB = {
  leafletJs: "https://unpkg.com/leaflet@1.4.0/dist/leaflet.js",
  leafletCss: "https://unpkg.com/leaflet@1.4.0/dist/leaflet.css",
  boot: "https://api.windy.com/assets/map-forecast/libBoot.js",
};
