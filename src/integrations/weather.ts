/**
 * 天気（Open-Meteo・登録/API キー不要・無料）。サーバー専用、15 分キャッシュ。
 * 場所は WEATHER_LATITUDE / WEATHER_LONGITUDE / WEATHER_CITY（既定は東京）。
 */
import { getTimezone } from "@/lib/config";
import { swr } from "@/lib/swr";

export type WeatherKind = "clear" | "partly" | "cloudy" | "fog" | "rain" | "snow" | "storm";

export interface WeatherDay {
  date: string;
  /** "月" など */
  weekday: string;
  label: string;
  kind: WeatherKind;
  hi: number;
  lo: number;
  /** 降水確率（%） */
  rain: number;
}

export interface WeatherReport {
  city: string;
  now: number;
  feelsLike: number;
  label: string;
  kind: WeatherKind;
  days: WeatherDay[];
}

function config() {
  const num = (v: string | undefined, d: number) => (v && Number.isFinite(Number(v)) ? Number(v) : d);
  return {
    lat: num(process.env.WEATHER_LATITUDE, 35.6895),
    lon: num(process.env.WEATHER_LONGITUDE, 139.6917),
    city: process.env.WEATHER_CITY?.trim() || "TOKYO",
    base: (process.env.WEATHER_API_BASE?.trim() || "https://api.open-meteo.com/v1").replace(/\/+$/, ""),
  };
}

/** WMO 天気コード → 日本語・種類 */
export function describeCode(code: number): { label: string; kind: WeatherKind } {
  if (code === 0) return { label: "快晴", kind: "clear" };
  if (code === 1) return { label: "晴れ", kind: "clear" };
  if (code === 2) return { label: "晴れ時々曇り", kind: "partly" };
  if (code === 3) return { label: "曇り", kind: "cloudy" };
  if (code === 45 || code === 48) return { label: "霧", kind: "fog" };
  if (code >= 51 && code <= 57) return { label: "霧雨", kind: "rain" };
  if (code === 61 || code === 80) return { label: "小雨", kind: "rain" };
  if (code === 63 || code === 81) return { label: "雨", kind: "rain" };
  if (code === 65 || code === 82) return { label: "大雨", kind: "rain" };
  if (code === 66 || code === 67) return { label: "冷たい雨", kind: "rain" };
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return { label: "雪", kind: "snow" };
  if (code >= 95) return { label: "雷雨", kind: "storm" };
  return { label: "不明", kind: "cloudy" };
}

/** 天気（15 分以内は前回の結果、3 時間以内なら前回の結果を返しつつ裏で取り直す） */
export function getWeather(): Promise<WeatherReport> {
  const c = config();
  const tz = getTimezone();
  return swr(`weather:${c.lat},${c.lon},${tz}`, 15 * 60_000, 3 * 60 * 60_000, () => fetchWeather(c, tz));
}

async function fetchWeather(c: ReturnType<typeof config>, tz: string): Promise<WeatherReport> {
  const params = new URLSearchParams({
    latitude: String(c.lat),
    longitude: String(c.lon),
    current: "temperature_2m,apparent_temperature,weather_code",
    daily: "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max",
    timezone: tz,
    forecast_days: "5",
  });
  const res = await fetch(`${c.base}/forecast?${params}`, { signal: AbortSignal.timeout(6000), cache: "no-store" });
  if (!res.ok) throw new Error(`weather ${res.status}`);
  const json = (await res.json()) as {
    current?: { temperature_2m?: number; apparent_temperature?: number; weather_code?: number };
    daily?: {
      time?: string[];
      weather_code?: number[];
      temperature_2m_max?: number[];
      temperature_2m_min?: number[];
      precipitation_probability_max?: (number | null)[];
    };
  };
  const d = json.daily ?? {};
  const now = describeCode(json.current?.weather_code ?? -1);
  const report: WeatherReport = {
    city: c.city,
    now: Math.round(json.current?.temperature_2m ?? NaN),
    feelsLike: Math.round(json.current?.apparent_temperature ?? NaN),
    ...now,
    days: (d.time ?? []).map((date, i) => ({
      date,
      weekday: new Intl.DateTimeFormat("ja-JP", { timeZone: "UTC", weekday: "short" }).format(new Date(`${date}T12:00:00Z`)),
      ...describeCode(d.weather_code?.[i] ?? -1),
      hi: Math.round(d.temperature_2m_max?.[i] ?? NaN),
      lo: Math.round(d.temperature_2m_min?.[i] ?? NaN),
      rain: Math.round(d.precipitation_probability_max?.[i] ?? 0),
    })),
  };
  if (!Number.isFinite(report.now) || !report.days.length) throw new Error("weather: incomplete data");
  return report;
}

/** 会話に渡す短い要約 */
export function weatherSummary(w: WeatherReport): string {
  const [today, tomorrow] = w.days;
  const line = (label: string, x: WeatherDay) => `${label}: ${x.label}、最高${x.hi}℃ / 最低${x.lo}℃、降水確率${x.rain}%`;
  return [
    `現在（${w.city}）: ${w.label} ${w.now}℃（体感${w.feelsLike}℃）`,
    today && line("今日", today),
    tomorrow && line("明日", tomorrow),
    ...w.days.slice(2).map((x) => line(`${x.date.slice(5).replace("-", "/")}(${x.weekday})`, x)),
  ]
    .filter(Boolean)
    .join("\n");
}
