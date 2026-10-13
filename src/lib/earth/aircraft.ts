/**
 * GOD'S EYE VIEW（EARTH）の飛行機レイヤー：OpenSky Network の ADS-B などの報告（/api/states/all）の読み取りと、
 * 見ている範囲（緯度経度の四角）の扱い、報告の後の推定位置。
 *   - 位置は「機体が報告した位置」。報告の後は速度と向きから推定して動かす（最大 AIRCRAFT_EXTRAPOLATE_MAX_MS まで）。
 *     画面には報告の時刻と、推定であることを分けて出す
 *   - 広すぎる範囲は取りに行かない（取得の回数の枠を使いすぎないため。寄ると表示する）
 *   ※ OpenSky の利用条件は非商用。公式の原文の最終確認が必要
 */

/** 取りに行く範囲の上限（緯度の幅 × 経度の幅。OpenSky は広いほど 1 回の消費が多い） */
export const AIRCRAFT_MAX_AREA = 100;
/** 画面から取りに行く間隔（サーバーはさらにためておく） */
export const AIRCRAFT_POLL_MS = 60_000;
/** これより古い取得なら STALE */
export const AIRCRAFT_STALE_MS = 4 * 60_000;
/** 報告の後、推定で動かす最大の時間（それ以上は止めて置く） */
export const AIRCRAFT_EXTRAPOLATE_MAX_MS = 90_000;
/** 一度に描く飛行機の上限 */
export const AIRCRAFT_DRAW_MAX = 400;

export interface BBox {
  lamin: number;
  lomin: number;
  lamax: number;
  lomax: number;
}

export interface Aircraft {
  /** ICAO 24 ビットのアドレス（16 進） */
  icao24: string;
  callsign: string | null;
  country: string | null;
  lat: number;
  lon: number;
  /** 高度（m。気圧高度、無ければ幾何高度） */
  altM: number | null;
  /** 対地速度（m/s） */
  speedMs: number | null;
  /** 進む向き（度。北から時計回り） */
  heading: number | null;
  /** 上昇・降下（m/s） */
  verticalMs: number | null;
  /** 位置を報告した時刻（ISO） */
  reportedAt: string;
}

export type AircraftResponse = { ok: true; source: "OpenSky"; fetchedAt: string; bbox: BBox; items: Aircraft[] } | { ok: false; error: string };

export const bboxArea = (b: BBox) => Math.max(0, b.lamax - b.lamin) * Math.max(0, b.lomax - b.lomin);

/** 正しい範囲か（緯度 -90〜90・経度 -180〜180・小さい方が先） */
export function validBBox(b: Partial<BBox> | null | undefined): b is BBox {
  if (!b) return false;
  const { lamin, lomin, lamax, lomax } = b;
  if (![lamin, lomin, lamax, lomax].every((v) => typeof v === "number" && Number.isFinite(v))) return false;
  return lamin! >= -90 && lamax! <= 90 && lomin! >= -180 && lomax! <= 180 && lamin! < lamax! && lomin! < lomax!;
}

/** 0.5 度刻みに広げる（同じような範囲の要求を同じ結果にまとめ、取得の回数を減らす） */
export function roundBBox(b: BBox): BBox {
  const down = (v: number) => Math.floor(v * 2) / 2;
  const up = (v: number) => Math.ceil(v * 2) / 2;
  return { lamin: Math.max(-90, down(b.lamin)), lomin: Math.max(-180, down(b.lomin)), lamax: Math.min(90, up(b.lamax)), lomax: Math.min(180, up(b.lomax)) };
}

export const bboxKey = (b: BBox) => `${b.lamin},${b.lomin},${b.lamax},${b.lomax}`;

export function parseBBoxQuery(q: string | null): BBox | null {
  if (!q) return null;
  const parts = q.split(",").map((s) => Number(s));
  if (parts.length !== 4) return null;
  const b = { lamin: parts[0], lomin: parts[1], lamax: parts[2], lomax: parts[3] };
  return validBBox(b) ? b : null;
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown, max = 40): string | null => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);

/**
 * OpenSky の states/all の応答を読む。空を飛んでいて位置のあるものだけ。形が違えば例外。
 * 並び：0 icao24, 1 callsign, 2 origin_country, 3 time_position, 4 last_contact, 5 lon, 6 lat, 7 baro_altitude,
 *       8 on_ground, 9 velocity, 10 true_track, 11 vertical_rate, 12 sensors, 13 geo_altitude, …
 */
export function parseOpenSky(raw: unknown, max = AIRCRAFT_DRAW_MAX): Aircraft[] {
  const r = raw as { time?: unknown; states?: unknown } | null;
  if (!r || typeof r !== "object" || num(r.time) === null) throw new Error("OpenSky の応答の形が想定と違います");
  if (r.states === null) return [];
  if (!Array.isArray(r.states)) throw new Error("OpenSky の応答の形が想定と違います");
  const out: Aircraft[] = [];
  for (const s of r.states as unknown[]) {
    if (out.length >= max) break;
    if (!Array.isArray(s)) continue;
    const icao = str(s[0], 6);
    const lon = num(s[5]);
    const lat = num(s[6]);
    const t = num(s[3]);
    if (!icao || !/^[0-9a-f]{6}$/i.test(icao) || lat === null || lon === null || t === null || Math.abs(lat) > 90 || Math.abs(lon) > 180) continue;
    if (s[8] === true) continue; // 地上にいるものは出さない
    out.push({
      icao24: icao.toLowerCase(),
      callsign: str(s[1], 8),
      country: str(s[2]),
      lat,
      lon,
      altM: num(s[7]) ?? num(s[13]),
      speedMs: num(s[9]),
      heading: num(s[10]),
      verticalMs: num(s[11]),
      reportedAt: new Date(t * 1000).toISOString(),
    });
  }
  return out;
}

/** 画面で受け取った応答を確かめる */
export function parseAircraftResponse(raw: unknown): AircraftResponse | null {
  const r = raw as Record<string, unknown> | null;
  if (!r || typeof r !== "object") return null;
  if (r.ok === false) return { ok: false, error: typeof r.error === "string" ? r.error.slice(0, 200) : "取得に失敗しました" };
  if (r.ok !== true || typeof r.fetchedAt !== "string" || !validBBox(r.bbox as BBox) || !Array.isArray(r.items)) return null;
  const items: Aircraft[] = [];
  for (const x of r.items as Record<string, unknown>[]) {
    if (!x || typeof x.icao24 !== "string" || !/^[0-9a-f]{6}$/.test(x.icao24) || typeof x.reportedAt !== "string") continue;
    const lat = num(x.lat);
    const lon = num(x.lon);
    if (lat === null || lon === null || Math.abs(lat) > 90 || Math.abs(lon) > 180) continue;
    items.push({ icao24: x.icao24, callsign: str(x.callsign, 8), country: str(x.country), lat, lon, altM: num(x.altM), speedMs: num(x.speedMs), heading: num(x.heading), verticalMs: num(x.verticalMs), reportedAt: x.reportedAt });
    if (items.length >= AIRCRAFT_DRAW_MAX) break;
  }
  return { ok: true, source: "OpenSky", fetchedAt: r.fetchedAt, bbox: r.bbox as BBox, items };
}

/** 報告の後の推定位置（速度と向きから。報告から max ms を過ぎたら、そこで止める） */
export function aircraftPositionAt(a: Aircraft, at: number, max = AIRCRAFT_EXTRAPOLATE_MAX_MS): { lat: number; lon: number; estimated: boolean } {
  const dt = Math.min(max, Math.max(0, at - Date.parse(a.reportedAt))) / 1000;
  if (!dt || a.speedMs === null || a.heading === null) return { lat: a.lat, lon: a.lon, estimated: false };
  const R = 6_371_000;
  const d = (a.speedMs * dt) / R;
  const th = (a.heading * Math.PI) / 180;
  const p1 = (a.lat * Math.PI) / 180;
  const l1 = (a.lon * Math.PI) / 180;
  const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(th));
  const l2 = l1 + Math.atan2(Math.sin(th) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2));
  const lon = ((((l2 * 180) / Math.PI + 540) % 360) - 180);
  return { lat: (p2 * 180) / Math.PI, lon, estimated: true };
}
