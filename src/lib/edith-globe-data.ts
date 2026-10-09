/**
 * E.D.I.T.H. の世界地図の形（Natural Earth の陸地データ。world-atlas の land-110m を使う。パブリックドメイン）。
 *   - 陸地の輪郭（経度・緯度の輪）
 *   - 陸地を埋める点（ホログラムの粒）
 *   - 緯度・経度 → 球の上の位置
 */
import { feature } from "topojson-client";
import type { Topology, GeometryCollection } from "topojson-specification";

export type LonLat = [number, number];

/** 陸地の輪郭（外周の輪だけ。110m では穴はほぼ無いので扱わない） */
export function landRings(topo: unknown): LonLat[][] {
  const t = topo as Topology<{ land: GeometryCollection }>;
  const fc = feature(t, t.objects.land) as unknown as {
    features: { geometry: { type: string; coordinates: number[][][] | number[][][][] } }[];
  };
  const rings: LonLat[][] = [];
  for (const f of fc.features) {
    const g = f.geometry;
    const polys = g.type === "Polygon" ? [g.coordinates as number[][][]] : (g.coordinates as number[][][][]);
    for (const poly of polys) if (poly[0]?.length) rings.push(poly[0].map(([lon, lat]) => [lon, lat] as LonLat));
  }
  return rings;
}

interface Ring {
  pts: LonLat[];
  minLon: number;
  maxLon: number;
  minLat: number;
  maxLat: number;
}

function inRing(lon: number, lat: number, pts: LonLat[]): boolean {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i];
    const [xj, yj] = pts[j];
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * 陸地を埋める点（緯度 step 度ごと。経度は緯度に合わせて間隔を広げ、極で詰まりすぎないようにする）。
 * 南極は面積が大きすぎて目立つので、南緯 60 度より南は間引く。
 */
export function landDots(rings: LonLat[][], step = 1.4): LonLat[] {
  const boxes: Ring[] = rings.map((pts) => {
    let minLon = 180, maxLon = -180, minLat = 90, maxLat = -90;
    for (const [lon, lat] of pts) {
      if (lon < minLon) minLon = lon;
      if (lon > maxLon) maxLon = lon;
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
    }
    return { pts, minLon, maxLon, minLat, maxLat };
  });
  const out: LonLat[] = [];
  for (let lat = -85; lat <= 85; lat += step) {
    const cos = Math.max(0.15, Math.cos((lat * Math.PI) / 180));
    const lonStep = (lat < -60 ? step * 2.2 : step) / cos;
    for (let lon = -180; lon < 180; lon += lonStep) {
      for (const b of boxes) {
        if (lon < b.minLon || lon > b.maxLon || lat < b.minLat || lat > b.maxLat) continue;
        if (inRing(lon, lat, b.pts)) {
          out.push([lon, lat]);
          break;
        }
      }
    }
  }
  return out;
}

/** 緯度・経度 → 球の上の位置（y が北。経度 0 が +z 方向） */
export function toXYZ(lat: number, lon: number, r = 1): [number, number, number] {
  const phi = (lat * Math.PI) / 180;
  const lam = (lon * Math.PI) / 180;
  return [r * Math.cos(phi) * Math.sin(lam), r * Math.sin(phi), r * Math.cos(phi) * Math.cos(lam)];
}

/** 球の上の位置 → 緯度・経度 */
export function toLatLon(x: number, y: number, z: number): { lat: number; lon: number } {
  const r = Math.hypot(x, y, z) || 1;
  return { lat: (Math.asin(y / r) * 180) / Math.PI, lon: (Math.atan2(x, z) * 180) / Math.PI };
}
