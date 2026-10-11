/**
 * USGS（アメリカ地質調査所）の地震情報。
 *   取得先：https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/4.5_day.geojson
 *   （M4.5 以上・過去 1 日。USGS は自動処理にはこのフィードの利用を勧めている。約 1 分ごとに更新）
 * status が "automatic"（自動決定）のものは後で値が変わることがあるので、確度は「中」にする。
 * USGS の「tsunami」は「海域の大きな地震」という印で、津波警報ではない（警報は気象庁などの公式発表を見る）。
 */
import { getJson } from "../http";
import { cleanText } from "../normalize";
import type { IntelItem } from "../types";
import { makeItem, type SourceContext } from "./common";

export const USGS_URL = "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/4.5_day.geojson";
const HOSTS = ["earthquake.usgs.gov"];
const MAX_EVENTS = 100;

interface UsgsFeature {
  id?: unknown;
  geometry?: { coordinates?: unknown };
  properties?: {
    mag?: unknown;
    place?: unknown;
    time?: unknown;
    updated?: unknown;
    url?: unknown;
    tsunami?: unknown;
    alert?: unknown;
    status?: unknown;
    sig?: unknown;
    title?: unknown;
  };
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" && cleanText(v, 200) ? cleanText(v, 200) : null);

/** GeoJSON を読み取る（形がおかしいものは捨てる。全体の形が違えば例外） */
export function parseUsgs(json: unknown, now: number): IntelItem[] {
  const features = (json as { type?: unknown; features?: unknown })?.features;
  if ((json as { type?: unknown })?.type !== "FeatureCollection" || !Array.isArray(features)) throw new Error("USGS のデータの形が正しくありません");
  const out: IntelItem[] = [];
  for (const f of features as UsgsFeature[]) {
    const id = str(f?.id);
    const p = f?.properties ?? {};
    const mag = num(p.mag);
    const time = num(p.time);
    const c = Array.isArray(f?.geometry?.coordinates) ? (f.geometry!.coordinates as unknown[]) : [];
    const lon = num(c[0]);
    const lat = num(c[1]);
    const depth = num(c[2]);
    if (!id || mag === null || time === null || lat === null || lon === null) continue;
    const place = str(p.place) ?? "場所不明";
    const status = str(p.status);
    const alert = str(p.alert);
    const item = makeItem(
      {
        id: `usgs:${id}`,
        source: "usgs",
        kind: "official",
        category: "disaster",
        title: `M${mag.toFixed(1)} の地震（${place}）`,
        summary: `USGS 発表。規模 M${mag.toFixed(1)}${depth !== null ? `・深さ約 ${Math.round(depth)}km` : ""}${status === "reviewed" ? "（確定値）" : "（自動決定・変わる可能性あり）"}。`,
        url: str(p.url),
        publishedAt: new Date(time).toISOString(),
        updatedAt: num(p.updated) !== null ? new Date(num(p.updated)!).toISOString() : null,
        place: { name: place, lat, lon },
        confidence: status === "reviewed" ? "high" : "medium",
        facts: {
          mag,
          depthKm: depth,
          status,
          alert, // PAGER（被害の見込み）の色：green / yellow / orange / red
          tsunamiFlag: num(p.tsunami) === 1,
          sig: num(p.sig),
        },
      },
      now,
    );
    if (item) out.push(item);
  }
  return out.sort((a, b) => Number(b.facts.mag) - Number(a.facts.mag)).slice(0, MAX_EVENTS);
}

export async function fetchUsgs(ctx: SourceContext): Promise<IntelItem[]> {
  return parseUsgs(await getJson<unknown>(USGS_URL, { hosts: HOSTS, fetchImpl: ctx.fetchImpl, maxBytes: 3_000_000 }), ctx.now);
}
