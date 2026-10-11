/**
 * E.D.I.T.H. 情報収集の「実データ確認」（GitHub Actions の手動実行専用：.github/workflows/edith-intel-check.yml）。
 *
 * USGS・NOAA NHC・気象庁の公式データを実際に 1 回ずつ取り、本番と同じ解析の関数で読めるかを確かめて、結果だけを表示する。
 *   - 読み込むのは「取得（http）」と「解析（sources/*）」だけ。保存・状態・通知・脳（GitHub）の処理は読み込まない
 *     （tests/intel-check.test.ts で、ここから書き込み・通知の処理にたどり着けないことを確かめている）
 *   - ファイルの保存・GitHub への書き込み・通知はしない。鍵や合言葉は使わない
 *   - 取得は決まった取得先だけ。時間切れ・大きさの上限あり。429・5xx でも再試行しない（1 回だけ）
 *   - 取ったデータの全文は出さない。件数・項目名・時刻と、短い見本（最大 2 件）だけ。位置は小数 1 桁まで
 *   - 取った文字は命令として扱わない（表示はすべて JSON の文字列として出し、GitHub Actions の命令として解釈されないようにする）
 *
 * 手元で動かす：node --experimental-transform-types --no-warnings --import ./tests/register.mjs scripts/intel-check.ts
 */
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { getText, type FetchLike } from "../src/integrations/intel/http";
import { cleanText } from "../src/integrations/intel/normalize";
import { parseUsgs, USGS_URL } from "../src/integrations/intel/sources/usgs";
import { parseNhc, NHC_URL } from "../src/integrations/intel/sources/nhc";
import { JMA_EQVOL_LONG_URL, JMA_EQVOL_URL, JMA_EXTRA_LONG_URL, latestTyphoonDocs, parseAtom, parseQuakeDoc, parseTsunamiDoc, parseTyphoonDoc, tag, type AtomEntry } from "../src/integrations/intel/sources/jma";
import type { IntelItem } from "../src/integrations/intel/types";

const TIMEOUT_MS = 15_000;

export interface HttpRecord {
  url: string;
  status: number | null;
  contentType: string | null;
  lastModified: string | null;
  ms: number;
}

export interface CheckReport {
  source: string;
  ok: boolean;
  fetchedAt: string;
  http: HttpRecord[];
  format: Record<string, unknown>;
  times: Record<string, string | null>;
  raw: number;
  parsed: number;
  mismatches: string[];
  samples: Record<string, unknown>[];
  /** 電文ごとの解析結果と、読めなかった項目の調査（台風だけ） */
  details?: Record<string, unknown>[];
  error?: string;
}

/** 取得のたびに、状態・形式・更新時刻（ヘッダー）・かかった時間を記録する fetch */
export function recordingFetch(base: FetchLike, log: HttpRecord[]): FetchLike {
  return async (url, init) => {
    const started = Date.now();
    const rec: HttpRecord = { url: String(url), status: null, contentType: null, lastModified: null, ms: 0 };
    log.push(rec);
    try {
      const res = await base(url, init);
      rec.status = res.status;
      rec.contentType = res.headers.get("content-type");
      rec.lastModified = res.headers.get("last-modified");
      return res;
    } finally {
      rec.ms = Date.now() - started;
    }
  };
}

const short = (v: unknown, n = 80) => cleanText(v, n);
const round1 = (n: number) => Math.round(n * 10) / 10;
const iso = (v: unknown): string | null => {
  const t = typeof v === "number" ? v : typeof v === "string" ? Date.parse(v) : NaN;
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
};
const pathOf = (u: string | null) => {
  try {
    const x = new URL(u ?? "");
    return `${x.hostname}${x.pathname}`.slice(0, 100);
  } catch {
    return null;
  }
};

/** 見本（最大 2 件。位置は小数 1 桁、リンクはホストとパスだけ） */
function sample(items: IntelItem[], max = 2): Record<string, unknown>[] {
  return items.slice(0, max).map((i) => ({
    id: short(i.id, 60),
    kind: i.kind,
    title: short(i.title),
    publishedAt: i.publishedAt,
    updatedAt: i.updatedAt,
    confidence: i.confidence,
    place: i.place ? { name: short(i.place.name, 40), lat: round1(i.place.lat), lon: round1(i.place.lon) } : null,
    url: pathOf(i.url),
    facts: Object.fromEntries(Object.entries(i.facts).map(([k, v]) => [k, typeof v === "string" ? short(v, 40) : v])),
  }));
}

function missing(obj: unknown, keys: string[]): string[] {
  const o = obj && typeof obj === "object" ? (obj as Record<string, unknown>) : {};
  return keys.filter((k) => !(k in o)).map((k) => `項目「${k}」がありません`);
}

const base = (source: string): CheckReport => ({ source, ok: false, fetchedAt: new Date().toISOString(), http: [], format: {}, times: {}, raw: 0, parsed: 0, mismatches: [], samples: [] });
const errText = (err: unknown) => short(err instanceof Error ? err.message : String(err), 120);

/* ---------- USGS ---------- */

export async function checkUsgs(fetchImpl: FetchLike): Promise<CheckReport> {
  const r = base("USGS 地震");
  const f = recordingFetch(fetchImpl, r.http);
  try {
    const text = await getText(USGS_URL, { hosts: ["earthquake.usgs.gov"], fetchImpl: f, timeoutMs: TIMEOUT_MS, maxBytes: 3_000_000 });
    const json = JSON.parse(text) as { type?: unknown; metadata?: Record<string, unknown>; features?: { properties?: Record<string, unknown> }[] };
    const features = Array.isArray(json.features) ? json.features : [];
    r.raw = features.length;
    r.format = { type: json.type, metadataKeys: Object.keys(json.metadata ?? {}).slice(0, 10), propertyKeys: Object.keys(features[0]?.properties ?? {}).slice(0, 30) };
    if (features[0]) r.mismatches.push(...missing(features[0].properties, ["mag", "place", "time", "updated", "url", "tsunami", "alert", "status", "sig", "title"]));
    const items = parseUsgs(json, Date.now());
    r.parsed = items.length;
    r.times = {
      generated: iso(json.metadata?.generated),
      newestEvent: iso(Math.max(...features.map((x) => Number(x.properties?.time) || 0), 0) || null),
      newestUpdate: iso(Math.max(...features.map((x) => Number(x.properties?.updated) || 0), 0) || null),
    };
    if (r.parsed < r.raw) r.mismatches.push(`${r.raw - r.parsed} 件を解析できませんでした（規模・時刻・座標の欠け）`);
    r.samples = sample(items);
    r.ok = true;
  } catch (err) {
    r.error = errText(err);
  }
  return r;
}

/* ---------- NOAA NHC ---------- */

export async function checkNhc(fetchImpl: FetchLike): Promise<CheckReport> {
  const r = base("NOAA NHC 熱帯低気圧");
  const f = recordingFetch(fetchImpl, r.http);
  try {
    const text = await getText(NHC_URL, { hosts: ["www.nhc.noaa.gov"], fetchImpl: f, timeoutMs: TIMEOUT_MS, maxBytes: 512_000 });
    const json = JSON.parse(text) as { activeStorms?: Record<string, unknown>[] };
    const storms = Array.isArray(json.activeStorms) ? json.activeStorms : [];
    r.raw = storms.length;
    r.format = { rootKeys: Object.keys(json ?? {}).slice(0, 10), stormKeys: Object.keys(storms[0] ?? {}).slice(0, 30), advisoryKeys: Object.keys((storms[0]?.forecastAdvisory as object) ?? {}).slice(0, 10) };
    if (!Array.isArray(json.activeStorms)) r.mismatches.push("activeStorms がありません");
    if (storms[0]) r.mismatches.push(...missing(storms[0], ["id", "name", "classification", "intensity", "pressure", "latitudeNumeric", "longitudeNumeric", "lastUpdate", "forecastAdvisory"]));
    const items = parseNhc(json, Date.now());
    r.parsed = items.length;
    r.times = { newestUpdate: iso(storms.map((s) => String(s.lastUpdate ?? "")).sort().pop()), newestIssuance: items.map((i) => i.publishedAt ?? "").sort().pop() || null };
    if (r.parsed < r.raw) r.mismatches.push(`${r.raw - r.parsed} 件を解析できませんでした`);
    if (r.raw === 0) r.mismatches.push("（参考）いま発表中の熱帯低気圧はありません。0 件は正常です");
    r.samples = sample(items);
    r.ok = true;
  } catch (err) {
    r.error = errText(err);
  }
  return r;
}

/* ---------- 気象庁 ---------- */

const JMA_HOSTS = ["www.data.jma.go.jp"];

function titleCounts(entries: AtomEntry[]): Record<string, number> {
  const m = new Map<string, number>();
  for (const e of entries) m.set(short(e.title, 40), (m.get(short(e.title, 40)) ?? 0) + 1);
  return Object.fromEntries([...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10));
}

const newest = (entries: AtomEntry[]) => entries.map((e) => e.updated ?? "").sort().pop() || null;

export async function checkJmaQuake(fetchImpl: FetchLike): Promise<CheckReport> {
  const r = base("気象庁 地震・津波");
  const f = recordingFetch(fetchImpl, r.http);
  try {
    // 高頻度フィード（直近 10 分ほど。地震が無ければ 0 件でも正常）
    const hf = parseAtom(await getText(JMA_EQVOL_URL, { hosts: JMA_HOSTS, fetchImpl: f, timeoutMs: TIMEOUT_MS, maxBytes: 2_000_000 }));
    // 長期フィード（数日分）から、電文の見本を読む
    const long = parseAtom(await getText(JMA_EQVOL_LONG_URL, { hosts: JMA_HOSTS, fetchImpl: f, timeoutMs: TIMEOUT_MS, maxBytes: 6_000_000 }));
    r.times = { highFreqNewestEntry: newest(hf), longNewestEntry: newest(long) };
    r.format = { highFreqEntries: hf.length, longEntries: long.length, titles: titleCounts(long) };
    const quakes = long.filter((e) => /震源・震度に関する情報/.test(e.title)).sort((a, b) => (b.updated ?? "").localeCompare(a.updated ?? "")).slice(0, 2);
    const tsunamis = long.filter((e) => /^津波警報・注意報・予報/.test(e.title)).sort((a, b) => (b.updated ?? "").localeCompare(a.updated ?? "")).slice(0, 1);
    const items: IntelItem[] = [];
    for (const [e, kind] of [...quakes.map((e) => [e, "quake"] as const), ...tsunamis.map((e) => [e, "tsunami"] as const)]) {
      r.raw++;
      if (!e.link) {
        r.mismatches.push("電文へのリンクがありません");
        continue;
      }
      try {
        const xml = await getText(e.link, { hosts: JMA_HOSTS, fetchImpl: f, timeoutMs: TIMEOUT_MS, maxBytes: 1_000_000 });
        const item = kind === "quake" ? parseQuakeDoc(xml, e.link, Date.now()) : parseTsunamiDoc(xml, e.link, Date.now());
        const status = tag(xml, "Status");
        if (item) items.push(item);
        else r.mismatches.push(`${kind === "quake" ? "地震" : "津波"}の電文を解析できませんでした（Status=${short(status, 10)}、EventID ${tag(xml, "EventID") ? "あり" : "なし"}）`);
        if (kind === "quake" && item && item.place === null) r.mismatches.push("地震の電文から震源の座標を読めませんでした");
      } catch (err) {
        r.mismatches.push(`電文の取得に失敗：${errText(err)}`);
      }
    }
    if (quakes.length === 0) r.mismatches.push("（参考）長期フィードに「震源・震度に関する情報」がありません");
    r.parsed = items.length;
    r.samples = sample(items);
    r.ok = true;
  } catch (err) {
    r.error = errText(err);
  }
  return r;
}

/** 台風の見本の上限（電文コードは VPTW60〜65 の最大 6 つ） */
const TYPHOON_SAMPLES = 6;
/** 調査で見せる要素の数・長さの上限（電文の全文は出さない） */
const MAX_DIAG_ELEMENTS = 10;
const MAX_ATTR_VALUE = 40;
const MAX_ELEMENT_VALUE = 20;

/** 電文の中の「実況」の部分（本番の解析と同じく、DateTime の type に「実況」を含む MeteorologicalInfo） */
function observedBlock(xml: string): { infos: number; observed: string | null } {
  const body = /<(?:[\w-]+:)?Body[\s>][\s\S]*<\/(?:[\w-]+:)?Body>/.exec(xml)?.[0] ?? "";
  const infos = [...body.matchAll(/<(?:[\w-]+:)?MeteorologicalInfo[\s>][\s\S]*?<\/(?:[\w-]+:)?MeteorologicalInfo>/g)].map((m) => m[0]);
  return { infos: infos.length, observed: infos.find((i) => /<(?:[\w-]+:)?DateTime\b[^>]*type="[^"]*実況/.test(i)) ?? null };
}

/** 要素の属性（実際にあるものだけ。値は短く切る） */
function attrsOf(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of raw.matchAll(/([\w:-]+)="([^"]*)"/g)) {
    if (Object.keys(out).length >= 8) break;
    out[short(m[1], 30)] = short(m[2], MAX_ATTR_VALUE);
  }
  return out;
}

/**
 * 最大風速が読めなかった電文の調査：実況の部分にある「風」に関係する要素（WindSpeed など）の名前・属性・値と、
 * 実況の部分にある項目の種類（Kind/Property/Type。例：呼称・階級・中心・風）だけを出す。電文の全文は出さない。
 */
export function windDiagnostics(xml: string): Record<string, unknown> {
  const { infos, observed } = observedBlock(xml);
  if (!observed) return { meteorologicalInfos: infos, observed: false };
  const types = [...new Set([...observed.matchAll(/<(?:[\w-]+:)?Type>([^<]*)<\/(?:[\w-]+:)?Type>/g)].map((m) => short(m[1], 20)))].slice(0, MAX_DIAG_ELEMENTS);
  const windElements = [...observed.matchAll(/<((?:[\w-]+:)?\w*Wind\w*)(\s[^>]*)?>([^<]*)<\/\1>/g)].slice(0, MAX_DIAG_ELEMENTS).map((m) => ({
    element: short(m[1], 40),
    attrs: attrsOf(m[2] ?? ""),
    value: short(m[3], MAX_ELEMENT_VALUE),
  }));
  // 風の部分（WindPart）があるか・中に何もないか（空の要素 <WindSpeed .../> も数える）
  const windPart = /<(?:[\w-]+:)?WindPart[\s>/]/.test(observed);
  const emptyWindElements = [...observed.matchAll(/<((?:[\w-]+:)?\w*Wind\w*)(\s[^>]*)?\/>/g)].slice(0, MAX_DIAG_ELEMENTS).map((m) => ({ element: short(m[1], 40), attrs: attrsOf(m[2] ?? ""), value: null }));
  return { meteorologicalInfos: infos, observed: true, propertyTypes: types, windPart, windElements: [...windElements, ...emptyWindElements].slice(0, MAX_DIAG_ELEMENTS) };
}

/** 電文ごとの解析結果（番号・名前・位置・気圧・風速） */
function typhoonDetail(code: string, item: IntelItem): Record<string, unknown> {
  return {
    code,
    report: item.facts.report ?? null,
    id: short(item.id, 60),
    typhoon: item.facts.typhoon ?? null,
    name: item.facts.name ?? null,
    typhoonClass: item.facts.typhoonClass ?? null,
    place: item.place ? { name: short(item.place.name, 40), lat: round1(item.place.lat), lon: round1(item.place.lon) } : null,
    pressureHpa: item.facts.pressureHpa ?? null,
    windMs: item.facts.windMs ?? null,
    windKt: item.facts.windKt ?? null,
    updatedAt: item.updatedAt,
  };
}

export async function checkJmaTyphoon(fetchImpl: FetchLike): Promise<CheckReport> {
  const r = base("気象庁 台風");
  const f = recordingFetch(fetchImpl, r.http);
  try {
    const entries = parseAtom(await getText(JMA_EXTRA_LONG_URL, { hosts: JMA_HOSTS, fetchImpl: f, timeoutMs: TIMEOUT_MS, maxBytes: 8_000_000 }));
    const typhoon = entries.filter((e) => /台風解析・予報情報/.test(e.title));
    // 本番と同じく、電文コード（VPTW60〜65）ごとに最新の電文だけを読む
    const latest = latestTyphoonDocs(entries);
    r.times = { newestEntry: newest(entries), newestTyphoonEntry: newest(typhoon) };
    r.format = { entries: entries.length, typhoonEntries: typhoon.length, codes: latest.map((d) => d.code), titles: titleCounts(entries) };
    const items: IntelItem[] = [];
    for (const d of latest) {
      r.raw++;
      try {
        const xml = await getText(d.url, { hosts: JMA_HOSTS, fetchImpl: f, timeoutMs: TIMEOUT_MS, maxBytes: 1_000_000 });
        const item = parseTyphoonDoc(xml, d.url, Date.now());
        if (!item) {
          r.mismatches.push(`${d.code}：解析できませんでした（Status=${short(tag(xml, "Status"), 10)}、番号 ${tag(xml, "Number") ? "あり" : "なし"}、EventID ${tag(xml, "EventID") ? "あり" : "なし"}）`);
          continue;
        }
        items.push(item);
        const missingFacts: string[] = ["typhoon", "pressureHpa", "windMs"].filter((k) => item.facts[k] === null || item.facts[k] === undefined);
        if (item.place === null) missingFacts.push("place");
        if (missingFacts.length) r.mismatches.push(`${d.code}：読めなかった項目 ${missingFacts.join("・")}`);
        const detail = typhoonDetail(d.code, item);
        // 最大風速が読めなかったときは、値が無いのか・あるが読めていないのかを見分けるための材料を付ける
        if (item.facts.windMs === null || item.facts.windMs === undefined) detail.windDiagnostics = windDiagnostics(xml);
        (r.details ??= []).push(detail);
      } catch (err) {
        r.mismatches.push(`${d.code}：電文の取得に失敗：${errText(err)}`);
      }
    }
    r.parsed = items.length;
    if (typhoon.length === 0) r.mismatches.push("（参考）随時の長期フィードに台風の情報がありません（台風が無ければ正常）");
    r.samples = sample(items, TYPHOON_SAMPLES);
    r.ok = true;
  } catch (err) {
    r.error = errText(err);
  }
  return r;
}

/** 4 つを順に確かめる（同時には取りに行かない） */
export async function runChecks(fetchImpl: FetchLike): Promise<CheckReport[]> {
  const out: CheckReport[] = [];
  for (const check of [checkUsgs, checkNhc, checkJmaQuake, checkJmaTyphoon]) out.push(await check(fetchImpl));
  return out;
}

/** 表示（GitHub Actions の命令として解釈されないよう、命令の受け付けを止め、すべて JSON の文字列で出す） */
export function render(reports: CheckReport[], token: string = randomUUID()): string[] {
  const lines = [`::stop-commands::${token}`, "E.D.I.T.H. 実データ確認（取得と解析だけ。保存・通知はしない）"];
  for (const r of reports) {
    lines.push("", `== ${r.source}: ${r.ok ? "取得・解析できました" : "失敗"} ==`);
    lines.push(`  ${JSON.stringify({ ...r, http: r.http.map((h) => ({ ...h, url: pathOf(h.url) })) }, null, 1).replace(/\n/g, "\n  ")}`);
  }
  lines.push("", `::${token}::`);
  return lines;
}

async function main(): Promise<void> {
  const reports = await runChecks(fetch);
  for (const line of render(reports)) console.log(line);
  process.exitCode = reports.every((r) => r.ok) ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main();
