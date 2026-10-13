/**
 * GOD'S EYE VIEW（EARTH）の場所の検索（都市・主な地点）。見つかれば、その街が見える高さまで寄る。
 * 見つからなければ、ニュース用の国の一覧（edith-geo.ts）で探す（国の中心へ。高めの視点）。
 */
export interface CityPlace {
  name: string;
  lat: number;
  lon: number;
  /** 寄る高さ（m） */
  height: number;
}

// [名前, 緯度, 経度, 寄る高さ(m), 呼び名（正規表現）]
const CITIES: [string, number, number, number, string][] = [
  ["東京駅", 35.6812, 139.7671, 6_000, "東京駅|tokyo station"],
  ["渋谷", 35.658, 139.7016, 5_000, "渋谷|shibuya"],
  ["新宿", 35.6896, 139.7006, 5_000, "新宿|shinjuku"],
  ["品川", 35.6285, 139.7387, 6_000, "品川|shinagawa"],
  ["羽田空港", 35.5494, 139.7798, 12_000, "羽田|haneda"],
  ["成田空港", 35.772, 140.3929, 15_000, "成田|narita"],
  ["東京", 35.6812, 139.7671, 40_000, "東京|tokyo"],
  ["横浜", 35.4437, 139.638, 25_000, "横浜|yokohama"],
  ["大阪", 34.7025, 135.4959, 30_000, "大阪|osaka"],
  ["京都", 35.0116, 135.7681, 25_000, "京都|kyoto"],
  ["名古屋", 35.1709, 136.8815, 30_000, "名古屋|nagoya"],
  ["札幌", 43.0687, 141.3508, 30_000, "札幌|sapporo"],
  ["福岡", 33.5902, 130.4017, 30_000, "福岡|博多|fukuoka|hakata"],
  ["那覇", 26.2124, 127.6809, 30_000, "那覇|沖縄|naha|okinawa"],
  ["仙台", 38.2682, 140.8694, 30_000, "仙台|sendai"],
  ["広島", 34.3853, 132.4553, 30_000, "広島|hiroshima"],
  ["ロンドン", 51.5072, -0.1276, 40_000, "ロンドン|london"],
  ["パリ", 48.8566, 2.3522, 35_000, "パリ|paris"],
  ["ニューヨーク", 40.7128, -74.006, 40_000, "ニューヨーク|new york|nyc|manhattan|マンハッタン"],
  ["ロサンゼルス", 34.0522, -118.2437, 60_000, "ロサンゼルス|ロス|los angeles|\\bla\\b"],
  ["サンフランシスコ", 37.7749, -122.4194, 35_000, "サンフランシスコ|san francisco"],
  ["ソウル", 37.5665, 126.978, 40_000, "ソウル|seoul"],
  ["北京", 39.9042, 116.4074, 50_000, "北京|beijing"],
  ["上海", 31.2304, 121.4737, 50_000, "上海|shanghai"],
  ["香港", 22.3193, 114.1694, 35_000, "香港|hong kong"],
  ["台北", 25.033, 121.5654, 35_000, "台北|taipei"],
  ["シンガポール", 1.3521, 103.8198, 45_000, "シンガポール|singapore"],
  ["バンコク", 13.7563, 100.5018, 50_000, "バンコク|bangkok"],
  ["ドバイ", 25.2048, 55.2708, 50_000, "ドバイ|dubai"],
  ["シドニー", -33.8688, 151.2093, 45_000, "シドニー|sydney"],
  ["ベルリン", 52.52, 13.405, 40_000, "ベルリン|berlin"],
  ["ローマ", 41.9028, 12.4964, 40_000, "ローマ|rome"],
  ["モスクワ", 55.7558, 37.6173, 50_000, "モスクワ|moscow"],
];
const COMPILED = CITIES.map(([name, lat, lon, height, re]) => ({ name, lat, lon, height, re: new RegExp(re, "i") }));

/** 都市・地点を探す（一覧の上ほど優先。「東京駅」は「東京」より先） */
export function findCity(text: string): CityPlace | null {
  const t = text.trim();
  if (!t) return null;
  const hit = COMPILED.find((c) => c.re.test(t));
  return hit ? { name: hit.name, lat: hit.lat, lon: hit.lon, height: hit.height } : null;
}

/** いちばん近い都市・地点（maxKm より遠ければ null）。場所の名前が無いとき（「この辺り」）にライブ配信を探す言葉にする */
export function nearestCity(lat: number, lon: number, maxKm = 80): CityPlace | null {
  const rad = Math.PI / 180;
  let best: { c: (typeof COMPILED)[number]; d: number } | null = null;
  for (const c of COMPILED) {
    const dLat = (c.lat - lat) * rad;
    const dLon = (c.lon - lon) * rad;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat * rad) * Math.cos(c.lat * rad) * Math.sin(dLon / 2) ** 2;
    const d = 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
    // 同じくらいの近さなら、一覧の上（細かい地点）を優先する
    if (d <= maxKm && (!best || d < best.d - 0.5)) best = { c, d };
  }
  return best ? { name: best.c.name, lat: best.c.lat, lon: best.c.lon, height: best.c.height } : null;
}
