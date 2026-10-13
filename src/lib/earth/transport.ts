/**
 * GOD'S EYE VIEW（EARTH）の道路の渋滞・バス・船。
 *   - 渋滞：TomTom の渋滞の画像（道路ごとの混み具合の色）。キーはサーバーだけが持ち、画像はこのサイトを通して配る
 *   - バス：公共交通オープンデータ（ODPT）の都営バスの位置（odpt:Bus。CC BY 4.0）。車両ごとの番号つき
 *   - 船：AISStream の AIS の位置の報告（PositionReport）
 *   ※ 各サービスの応答の形・利用条件は公式の原文を最終確認できていない。読めない項目は捨て、作ったデータは出さない
 */
import { validBBox, type BBox } from "./aircraft";

/* ---------- 渋滞（TomTom） ---------- */

/** 渋滞の画像を取りに行く段階（これより引いたときは取りに行かない。細かすぎる段階も取りに行かない） */
export const TRAFFIC_MIN_LEVEL = 8;
export const TRAFFIC_MAX_LEVEL = 16;
export const TRAFFIC_TILE_URL = "/api/edith/earth/traffic/{z}/{x}/{y}";
/** 渋滞を出すのは、見ている範囲がこれ以下のときだけ（緯度の幅 × 経度の幅）。その範囲の画像だけ取りに行く */
export const TRAFFIC_MAX_VIEW_AREA = 9;
export const validTrafficTile = (z: number, x: number, y: number) =>
  Number.isInteger(z) && Number.isInteger(x) && Number.isInteger(y) && z >= TRAFFIC_MIN_LEVEL && z <= TRAFFIC_MAX_LEVEL && x >= 0 && y >= 0 && x < 2 ** z && y < 2 ** z;

/* ---------- バス（ODPT・都営バス） ---------- */

/** 都営バスを取りに行く地域（東京のあたり。見ている範囲がここに重なり、寄っているときだけ） */
export const TOEI_AREA: BBox = { lamin: 35.5, lomin: 139.2, lamax: 35.9, lomax: 140.0 };
export const BUS_POLL_MS = 30_000;
export const BUS_STALE_MS = 3 * 60_000;
/** 見ている範囲がこれより広いときは取りに行かない（引いた画面では点が重なるだけ） */
export const BUS_MAX_VIEW_AREA = 9;

export interface Bus {
  id: string;
  /** 車両の番号 */
  number: string | null;
  /** 系統（例 都01） */
  route: string | null;
  lat: number;
  lon: number;
  /** 向き（度） */
  azimuth: number | null;
  /** 位置の時刻（ISO） */
  reportedAt: string;
}
export type BusesResponse = { ok: true; source: "ODPT"; fetchedAt: string; items: Bus[] } | { ok: false; error: string };

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : null);
const str = (v: unknown, max = 60): string | null => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);
const lastPart = (v: string | null) => (v ? (v.split(/[.:]/).filter(Boolean).pop() ?? null) : null);

/** ODPT の odpt:Bus の配列を読む（位置のあるものだけ。形が違えば例外） */
export function parseOdptBuses(raw: unknown, max = 1500): Bus[] {
  if (!Array.isArray(raw)) throw new Error("ODPT の応答の形が想定と違います");
  const out: Bus[] = [];
  for (const b of raw as Record<string, unknown>[]) {
    if (out.length >= max) break;
    if (!b || typeof b !== "object") continue;
    const lat = num(b["geo:lat"]);
    const lon = num(b["geo:long"]);
    const date = str(b["dc:date"]);
    const id = str(b["owl:sameAs"], 120) ?? str(b["@id"], 120);
    if (lat === null || lon === null || !id || Math.abs(lat) > 90 || Math.abs(lon) > 180) continue;
    const t = date ? Date.parse(date) : NaN;
    out.push({
      id,
      number: str(b["odpt:busNumber"], 20),
      route: lastPart(str(b["odpt:busroute"], 120)) ?? lastPart(str(b["odpt:busroutePattern"], 120)),
      lat,
      lon,
      azimuth: num(b["odpt:azimuth"]),
      reportedAt: Number.isFinite(t) ? new Date(t).toISOString() : new Date(0).toISOString(),
    });
  }
  return out;
}

/* ---------- 船（AISStream） ---------- */

export const SHIP_POLL_MS = 60_000;
export const SHIP_STALE_MS = 5 * 60_000;
/** 見ている範囲がこれより広いときは取りに行かない */
export const SHIP_MAX_AREA = 25;

export interface Ship {
  /** MMSI（9 桁） */
  mmsi: string;
  name: string | null;
  lat: number;
  lon: number;
  /** 対地速度（ノット） */
  sog: number | null;
  /** 向き（度。船首方位、無ければ進路） */
  heading: number | null;
  reportedAt: string;
}
export type ShipsResponse = { ok: true; source: "AISStream"; fetchedAt: string; bbox: BBox; items: Ship[] } | { ok: false; error: string };

/** AISStream の 1 通（PositionReport）を読む。違う種類・位置の無いものは null */
export function parseAisMessage(raw: unknown, now: number): Ship | null {
  const m = raw as { MessageType?: unknown; MetaData?: Record<string, unknown>; Message?: Record<string, unknown> } | null;
  if (!m || typeof m !== "object" || m.MessageType !== "PositionReport") return null;
  const meta = m.MetaData ?? {};
  const pr = (m.Message?.PositionReport ?? {}) as Record<string, unknown>;
  const mmsi = String(meta.MMSI ?? pr.UserID ?? "");
  if (!/^\d{9}$/.test(mmsi)) return null;
  const lat = num(pr.Latitude) ?? num(meta.latitude);
  const lon = num(pr.Longitude) ?? num(meta.longitude);
  if (lat === null || lon === null || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  const th = num(pr.TrueHeading);
  const cog = num(pr.Cog);
  const sog = num(pr.Sog);
  // 例 "2026-10-12 06:00:00.123456789 +0000 UTC" → ISO（小数は 3 桁まで）
  const tm = typeof meta.time_utc === "string" ? /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(\.\d+)?/.exec(meta.time_utc) : null;
  const t = tm ? Date.parse(`${tm[1]}T${tm[2]}${tm[3] ? tm[3].slice(0, 4) : ""}Z`) : NaN;
  return {
    mmsi,
    name: str(typeof meta.ShipName === "string" ? meta.ShipName.replace(/@+$/, "") : null, 30),
    lat,
    lon,
    sog: sog !== null && sog < 102.3 ? sog : null,
    heading: th !== null && th >= 0 && th < 360 ? th : cog !== null && cog >= 0 && cog < 360 ? cog : null,
    reportedAt: new Date(Number.isFinite(t) ? t : now).toISOString(),
  };
}

/* ---------- 画面での確認 ---------- */

export function parseBusesResponse(raw: unknown): BusesResponse | null {
  const r = raw as Record<string, unknown> | null;
  if (!r || typeof r !== "object") return null;
  if (r.ok === false) return { ok: false, error: typeof r.error === "string" ? r.error.slice(0, 200) : "取得に失敗しました" };
  if (r.ok !== true || typeof r.fetchedAt !== "string" || !Array.isArray(r.items)) return null;
  const items: Bus[] = [];
  for (const b of r.items as Record<string, unknown>[]) {
    const lat = num(b?.lat);
    const lon = num(b?.lon);
    if (!b || typeof b.id !== "string" || lat === null || lon === null || Math.abs(lat) > 90 || Math.abs(lon) > 180 || typeof b.reportedAt !== "string") continue;
    items.push({ id: b.id.slice(0, 120), number: str(b.number, 20), route: str(b.route, 20), lat, lon, azimuth: num(b.azimuth), reportedAt: b.reportedAt });
    if (items.length >= 1500) break;
  }
  return { ok: true, source: "ODPT", fetchedAt: r.fetchedAt, items };
}

export function parseShipsResponse(raw: unknown): ShipsResponse | null {
  const r = raw as Record<string, unknown> | null;
  if (!r || typeof r !== "object") return null;
  if (r.ok === false) return { ok: false, error: typeof r.error === "string" ? r.error.slice(0, 200) : "取得に失敗しました" };
  if (r.ok !== true || typeof r.fetchedAt !== "string" || !validBBox(r.bbox as BBox) || !Array.isArray(r.items)) return null;
  const items: Ship[] = [];
  for (const s of r.items as Record<string, unknown>[]) {
    const lat = num(s?.lat);
    const lon = num(s?.lon);
    if (!s || typeof s.mmsi !== "string" || !/^\d{9}$/.test(s.mmsi) || lat === null || lon === null || typeof s.reportedAt !== "string") continue;
    items.push({ mmsi: s.mmsi, name: str(s.name, 30), lat, lon, sog: num(s.sog), heading: num(s.heading), reportedAt: s.reportedAt });
    if (items.length >= 1000) break;
  }
  return { ok: true, source: "AISStream", fetchedAt: r.fetchedAt, bbox: r.bbox as BBox, items };
}

/** 2 つの範囲が重なるか */
export const bboxOverlaps = (a: BBox, b: BBox) => a.lamin < b.lamax && a.lamax > b.lamin && a.lomin < b.lomax && a.lomax > b.lomin;
