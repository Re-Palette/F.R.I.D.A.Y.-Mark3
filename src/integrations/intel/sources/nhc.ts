/**
 * NOAA NHC（アメリカ国立ハリケーンセンター）の熱帯低気圧の情報（大西洋・東太平洋・中部太平洋）。
 *   取得先：https://www.nhc.noaa.gov/CurrentStorms.json（activeStorms の配列。12 時間発表が無ければ空）
 * 日本付近（北西太平洋）の台風は対象外（気象庁の台風情報で扱う）。
 * 同じ嵐は 1 件にまとめ、発表のたびに中身を新しくする（ID は嵐の ID）。
 */
import { getJson } from "../http";
import { cleanText } from "../normalize";
import type { IntelItem } from "../types";
import { makeItem, type SourceContext } from "./common";

export const NHC_URL = "https://www.nhc.noaa.gov/CurrentStorms.json";
const HOSTS = ["www.nhc.noaa.gov"];
const MAX_STORMS = 32;

/** NHC の分類（略号）を日本語に */
const CLASS_JA: Record<string, string> = {
  TD: "熱帯低気圧",
  STD: "亜熱帯低気圧",
  TS: "熱帯暴風雨",
  STS: "亜熱帯暴風雨",
  HU: "ハリケーン",
  PTC: "熱帯低気圧になる可能性のある擾乱",
  PC: "温帯低気圧化",
};

const BASIN_JA: Record<string, string> = { al: "大西洋", ep: "東太平洋", cp: "中部太平洋" };

interface NhcStorm {
  id?: unknown;
  name?: unknown;
  classification?: unknown;
  intensity?: unknown;
  pressure?: unknown;
  latitudeNumeric?: unknown;
  longitudeNumeric?: unknown;
  lastUpdate?: unknown;
  forecastAdvisory?: { advNum?: unknown; issuance?: unknown; url?: unknown };
}

const toNum = (v: unknown): number | null => {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
};
const toStr = (v: unknown): string | null => (typeof v === "string" && cleanText(v, 120) ? cleanText(v, 120) : null);

/** NHC の公式ページのリンクだけ使う */
function nhcLink(v: unknown): string | null {
  try {
    const u = new URL(String(v ?? ""));
    return u.protocol === "https:" && u.hostname === "www.nhc.noaa.gov" ? u.toString() : null;
  } catch {
    return null;
  }
}

export function parseNhc(json: unknown, now: number): IntelItem[] {
  const storms = (json as { activeStorms?: unknown })?.activeStorms;
  if (!Array.isArray(storms)) throw new Error("NHC のデータの形が正しくありません");
  const out: IntelItem[] = [];
  for (const s of (storms as NhcStorm[]).slice(0, MAX_STORMS)) {
    const id = toStr(s?.id);
    if (!id || !/^(al|ep|cp)\d{6}$/.test(id)) continue;
    const lat = toNum(s.latitudeNumeric);
    const lon = toNum(s.longitudeNumeric);
    const cls = toStr(s.classification)?.toUpperCase() ?? "";
    const clsJa = CLASS_JA[cls] ?? (cls || "熱帯低気圧");
    const name = toStr(s.name) ?? id.toUpperCase();
    const windKt = toNum(s.intensity);
    const pressure = toNum(s.pressure);
    const adv = s.forecastAdvisory ?? {};
    const basin = BASIN_JA[id.slice(0, 2)] ?? "";
    const item = makeItem(
      {
        id: `nhc:${id}`,
        source: "nhc",
        kind: "official",
        category: "weather",
        title: `${clsJa}「${name}」（${basin}）`,
        summary: `NOAA NHC 発表${toStr(adv.advNum) ? `（第 ${toStr(adv.advNum)} 報）` : ""}。${windKt !== null ? `最大風速 約 ${Math.round(windKt * 0.514)}m/s（${windKt}ノット）` : ""}${pressure !== null ? `・中心気圧 ${pressure}hPa` : ""}。`,
        url: nhcLink(adv.url) ?? "https://www.nhc.noaa.gov/",
        publishedAt: toStr(adv.issuance),
        updatedAt: toStr(s.lastUpdate),
        place: lat !== null && lon !== null ? { name: `${name}（${basin}）`, lat, lon } : null,
        facts: { stormId: id, classification: cls || null, windKt, pressureHpa: pressure, advisory: toStr(adv.advNum) },
      },
      now,
    );
    if (item) out.push(item);
  }
  return out;
}

export async function fetchNhc(ctx: SourceContext): Promise<IntelItem[]> {
  return parseNhc(await getJson<unknown>(NHC_URL, { hosts: HOSTS, fetchImpl: ctx.fetchImpl, maxBytes: 512_000 }), ctx.now);
}
