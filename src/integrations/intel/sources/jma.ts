/**
 * 気象庁 防災情報XML（PULL 型・Atom フィード。登録不要）。
 *   地震・火山の高頻度フィード … https://www.data.jma.go.jp/developer/xml/feed/eqvol.xml（毎分更新・直近 10 分以上を掲載）
 *   地震・火山の長期フィード   … eqvol_l.xml（毎時更新・数日分）。前回から 10 分以上あいたとき、取りこぼしを補う
 *   随時（台風など）の長期フィード … extra_l.xml（毎時更新）
 *
 * 取り込む電文：
 *   地震 … 「震源・震度に関する情報」（VXSE53）。同じ地震（EventID）は 1 件にまとめ、続報・訂正で中身を新しくする
 *   津波 … 「津波警報・注意報・予報」（VTSE41）
 *   台風 … 「台風解析・予報情報」（VPTW60〜65）。電文コードごとに最新の電文を読み、同じ台風は番号（無ければ EventID）で 1 件にまとめる
 * 電文の Control/Status が「通常」以外（訓練・試験）は取り込まない。InfoType が「取消」なら取消として残す。
 * 出典は気象庁（加工して表示するので、画面では「気象庁の情報をもとに作成」と示す）。
 *
 * 台風は、取り込みとは別に、フィードの観測の記録（FeedObservation）を ctx.observe に渡す（Phase 3。渡すだけで、保存・判定はしない）。
 */
import { getText, SourceError } from "../http";
import { cleanText, isoStrict } from "../normalize";
import { FEED_OBSERVATION_LIMITS, type FeedBulletinOutcome, type FeedObservation, type FeedStreamObservation, type IntelFetchErrorKind, type IntelItem } from "../types";
import { makeItem, reportObservation, type SourceContext } from "./common";

const BASE = "https://www.data.jma.go.jp/developer/xml/feed";
export const JMA_EQVOL_URL = `${BASE}/eqvol.xml`;
export const JMA_EQVOL_LONG_URL = `${BASE}/eqvol_l.xml`;
export const JMA_EXTRA_LONG_URL = `${BASE}/extra_l.xml`;
const HOSTS = ["www.data.jma.go.jp"];
/** 1 回の実行で読む電文の数の上限（気象庁への負担を小さく） */
const MAX_DOCS_PER_RUN = 8;
/** 高頻度フィードが掲載している時間（これ以上あいたら長期フィードで補う） */
const HIGH_FREQ_WINDOW_MS = 10 * 60_000;

export interface AtomEntry {
  title: string;
  id: string;
  updated: string | null;
  author: string;
  link: string | null;
  content: string;
}

/** XML の文字参照を戻す */
export function decodeXml(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(Number.parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/** 最初に見つかったタグの中身（名前空間の接頭辞は問わない） */
export function tag(xml: string, name: string): string | null {
  const m = new RegExp(`<(?:[\\w-]+:)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w-]+:)?${name}>`).exec(xml);
  return m ? decodeXml(m[1]).trim() : null;
}

/** タグの中身をすべて */
function tags(xml: string, name: string): string[] {
  const re = new RegExp(`<(?:[\\w-]+:)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w-]+:)?${name}>`, "g");
  return [...xml.matchAll(re)].map((m) => decodeXml(m[1]).trim());
}

/** 最初に見つかったタグのかたまり（中の要素を続けて探すため） */
function block(xml: string, name: string): string | null {
  const m = new RegExp(`<(?:[\\w-]+:)?${name}(?:\\s[^>]*)?>[\\s\\S]*?</(?:[\\w-]+:)?${name}>`).exec(xml);
  return m ? m[0] : null;
}

/** Atom フィードを読む */
export function parseAtom(xml: string): AtomEntry[] {
  if (!/<feed[\s>]/.test(xml)) throw new Error("気象庁のフィードの形が正しくありません");
  const out: AtomEntry[] = [];
  for (const m of xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
    const e = m[1];
    const href = /<link\b[^>]*href="([^"]+)"/.exec(e)?.[1];
    out.push({
      title: tag(e, "title") ?? "",
      id: tag(e, "id") ?? "",
      updated: tag(e, "updated"),
      author: tag(block(e, "author") ?? "", "name") ?? "",
      link: href ? decodeXml(href) : null,
      content: tag(e, "content") ?? "",
    });
  }
  return out;
}

/** 気象庁の電文のリンクだけ使う */
function jmaDocUrl(v: string | null): string | null {
  if (!v) return null;
  try {
    const u = new URL(v);
    return u.protocol === "https:" && u.hostname === "www.data.jma.go.jp" && u.pathname.startsWith("/developer/xml/data/") ? u.toString() : null;
  } catch {
    return null;
  }
}

const reportName = (url: string) => url.split("/").pop()!.replace(/\.xml$/, "");

/** 「+38.3+142.4-10000/」（度）や「+3818+14224-10000/」（度分）を緯度・経度・深さ(km)に */
export function parseCoordinate(v: string | null): { lat: number; lon: number; depthKm: number | null } | null {
  const m = v ? /^([+-]\d+(?:\.\d+)?)([+-]\d+(?:\.\d+)?)([+-]\d+(?:\.\d+)?)?\/?$/.exec(v.trim()) : null;
  if (!m) return null;
  let lat = Number(m[1]);
  let lon = Number(m[2]);
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    // 度分（ddmm）の書き方
    const dm = (x: number) => Math.sign(x) * (Math.floor(Math.abs(x) / 100) + (Math.abs(x) % 100) / 60);
    lat = dm(lat);
    lon = dm(lon);
  }
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  const depthKm = m[3] !== undefined ? Math.abs(Number(m[3])) / 1000 : null;
  return { lat: Math.round(lat * 100) / 100, lon: Math.round(lon * 100) / 100, depthKm };
}

/** 電文の共通部分（訓練・試験なら null） */
function readHead(xml: string): { status: string; infoType: string; reportAt: string | null; eventId: string | null; headline: string; title: string } | null {
  const control = block(xml, "Control") ?? "";
  const status = tag(control, "Status") ?? "";
  if (status !== "通常") return null;
  const head = block(xml, "Head") ?? "";
  return {
    status,
    infoType: tag(head, "InfoType") ?? "発表",
    reportAt: tag(head, "ReportDateTime"),
    eventId: tag(head, "EventID"),
    headline: tag(block(head, "Headline") ?? "", "Text") ?? "",
    title: tag(head, "Title") ?? tag(control, "Title") ?? "",
  };
}

/** 震度の並び（大きいほど強い） */
const INTENSITY_ORDER = ["1", "2", "3", "4", "5-", "5+", "6-", "6+", "7"];
const intensityJa = (v: string) => v.replace("-", "弱").replace("+", "強");

/** 地震の電文（震源・震度に関する情報）を読む */
export function parseQuakeDoc(xml: string, docUrl: string, now: number): IntelItem | null {
  const h = readHead(xml);
  if (!h || !h.eventId) return null;
  const body = block(xml, "Body") ?? "";
  const quake = block(body, "Earthquake") ?? "";
  const origin = tag(quake, "OriginTime");
  const area = tag(block(quake, "Area") ?? "", "Name") ?? "震源不明";
  const coord = parseCoordinate(tag(quake, "Coordinate"));
  const magText = tag(quake, "Magnitude");
  const mag = magText !== null && Number.isFinite(Number(magText)) ? Number(magText) : null;
  const maxInt = tag(block(body, "Observation") ?? "", "MaxInt");
  const comment = tag(block(body, "ForecastComment") ?? "", "Text") ?? "";
  const cancelled = h.infoType === "取消";
  return makeItem(
    {
      id: `jma:eq:${h.eventId}`,
      source: "jma",
      kind: "official",
      category: "disaster",
      title: `${cancelled ? "（取消）" : ""}${maxInt ? `最大震度${intensityJa(maxInt)}` : "地震"}（${area}${mag !== null ? `・M${mag.toFixed(1)}` : ""}）`,
      summary: [h.headline, comment].filter(Boolean).join(" ").slice(0, 380),
      url: docUrl,
      publishedAt: origin ?? h.reportAt,
      updatedAt: h.reportAt,
      place: coord ? { name: area, lat: coord.lat, lon: coord.lon } : null,
      facts: {
        report: reportName(docUrl),
        infoType: h.infoType,
        mag,
        maxInt: maxInt && INTENSITY_ORDER.includes(maxInt) ? maxInt : null,
        depthKm: coord?.depthKm ?? null,
        cancelled,
        noTsunami: /津波の心配はありません/.test(comment),
      },
    },
    now,
  );
}

const TSUNAMI_ORDER = ["津波予報（若干の海面変動）", "津波注意報", "津波警報", "大津波警報"];

/** 津波の電文（津波警報・注意報・予報）を読む */
export function parseTsunamiDoc(xml: string, docUrl: string, now: number): IntelItem | null {
  const h = readHead(xml);
  if (!h) return null;
  const body = block(xml, "Body") ?? "";
  const kinds = [...new Set(tags(block(body, "Forecast") ?? body, "Name").filter((n) => /津波/.test(n)))];
  const top = [...TSUNAMI_ORDER].reverse().find((k) => kinds.includes(k)) ?? null;
  const lifted = kinds.some((k) => /解除/.test(k));
  const cancelled = h.infoType === "取消";
  return makeItem(
    {
      id: `jma:tsunami:${h.eventId ?? reportName(docUrl)}`,
      source: "jma",
      kind: "official",
      category: "disaster",
      title: `${cancelled ? "（取消）" : ""}${top ?? (lifted ? "津波警報・注意報の解除" : "津波の情報")}`,
      summary: h.headline.slice(0, 380),
      url: docUrl,
      publishedAt: h.reportAt,
      updatedAt: h.reportAt,
      facts: { report: reportName(docUrl), infoType: h.infoType, level: top, lifted, cancelled },
    },
    now,
  );
}

/** 台風の電文コード（VPTW60〜65。末尾の番号は台風ごとに割り当てられ、消滅するまで変わらない） */
export function typhoonCode(url: string | null): string | null {
  return url ? (/_(VPTW6[0-5])_/.exec(url)?.[1] ?? null) : null;
}

/** フィードの項目が台風の電文（台風解析・予報情報、VPTW60〜65、気象庁のリンク）なら、その電文コードとリンク */
function typhoonEntry(e: AtomEntry): { code: string; url: string } | null {
  const url = jmaDocUrl(e.link);
  const code = typhoonCode(url);
  return url && code && /台風解析・予報情報/.test(e.title) ? { code, url } : null;
}

/** フィードから、電文コードごとに最新の台風の電文を選ぶ（同じ台風の古い発表は読まない） */
export function latestTyphoonDocs(entries: AtomEntry[]): { code: string; url: string; updated: string }[] {
  const latest = new Map<string, { code: string; url: string; updated: string }>();
  for (const e of entries) {
    const entry = typhoonEntry(e);
    if (!entry) continue;
    const { url, code } = entry;
    const updated = e.updated ?? "";
    const prev = latest.get(code);
    // 時刻は文字ではなく時刻として比べる（「Z」と「+09:00」の書き方が混ざっても新旧を取り違えない）
    const t = Date.parse(updated);
    const pt = prev ? Date.parse(prev.updated) : NaN;
    if (!prev || (Number.isFinite(t) && (!Number.isFinite(pt) || t > pt))) latest.set(code, { code, url, updated });
  }
  return [...latest.values()].sort((a, b) => a.code.localeCompare(b.code));
}

/** 属性が条件に合う最初のタグの中身（例：type="最大風速" かつ unit="m/s" の WindSpeed） */
function tagWhere(xml: string, name: string, attrs: RegExp[]): string | null {
  const re = new RegExp(`<(?:[\\w-]+:)?${name}(\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w-]+:)?${name}>`, "g");
  for (const m of xml.matchAll(re)) {
    const a = m[1] ?? "";
    if (attrs.every((r) => r.test(a))) return decodeXml(m[2]).trim();
  }
  return null;
}

const toHalfDigits = (s: string) => s.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
const numOrNull = (v: string | null): number | null => (v !== null && v !== "" && Number.isFinite(Number(v)) ? Number(v) : null);

/**
 * 台風の電文（台風解析・予報情報 5 日進路・強度予報、VPTW60〜65）を読む。
 * 実況（いまの解析）の部分から、番号・名前・階級・中心位置・中心気圧・最大風速を取る。
 * 同じ台風は 1 件にまとめる：台風番号（年＋番号）があればそれ、無ければ（台風になる前の熱帯低気圧）EventID で区別する。
 * どちらも無いときは、別の台風と取り違えないよう取り込まない（null）。
 */
export function parseTyphoonDoc(xml: string, docUrl: string, now: number): IntelItem | null {
  const h = readHead(xml);
  if (!h) return null;
  const body = block(xml, "Body") ?? "";
  const infos = [...body.matchAll(/<(?:[\w-]+:)?MeteorologicalInfo[\s>][\s\S]*?<\/(?:[\w-]+:)?MeteorologicalInfo>/g)].map((m) => m[0]);
  // 実況（いまの解析）だけを使う。無ければ予報の位置を「いまの位置」と取り違えないよう取り込まない
  const info = infos.find((i) => /<(?:[\w-]+:)?DateTime\b[^>]*type="[^"]*実況/.test(i));
  if (!info) return null;
  const at = tagWhere(info, "DateTime", [/type="[^"]*実況/]);

  const namePart = block(info, "TyphoonNamePart") ?? "";
  const name = tag(namePart, "Name");
  const kana = tag(namePart, "NameKana");
  const numberRaw = toHalfDigits(tag(namePart, "Number") ?? "").replace(/\D/g, "");
  const reportYear = (h.reportAt ?? "").slice(2, 4);
  // 番号は「年 2 桁＋番号 2 桁」（例 2619）でも、番号だけでも受け付ける。年をまたいで別の台風と混ざらないよう年を付けて持つ
  const key = numberRaw.length === 4 ? numberRaw : numberRaw.length > 0 && numberRaw.length <= 2 && reportYear ? `${reportYear}${numberRaw.padStart(2, "0")}` : null;
  const number = key ? Number(key.slice(2)) : null;

  const typhoonClass = tag(info, "TyphoonClass");
  const areaClass = tag(info, "AreaClass");
  const intensity = tag(info, "IntensityClass");
  const center = block(info, "CenterPart") ?? info;
  const coord = parseCoordinate(tagWhere(center, "Coordinate", [/type="[^"]*中心位置（度）/]) ?? tag(center, "Coordinate"));
  const pressure = numOrNull(tagWhere(center, "Pressure", [/type="[^"]*中心気圧/]) ?? tag(center, "Pressure"));
  const location = tag(center, "Location");
  const windMs = numOrNull(tagWhere(info, "WindSpeed", [/type="[^"]*最大風速/, /unit="m\/s"/]));
  const windKt = numOrNull(tagWhere(info, "WindSpeed", [/type="[^"]*最大風速/, /unit="ノット"/]));

  const id = key ? `jma:typhoon:${key}` : h.eventId ? `jma:typhoon:ev:${h.eventId}` : null;
  if (!id) return null;
  const cancelled = h.infoType === "取消";
  const label = number !== null ? `台風第${number}号${kana || name ? `（${kana || name}）` : ""}` : "熱帯低気圧（台風になる見込み）";
  const strength = [areaClass && !/^\s*$/.test(areaClass) ? areaClass : null, intensity && !/^\s*$/.test(intensity) ? intensity : null].filter(Boolean).join("・");
  return makeItem(
    {
      id,
      source: "jmatyphoon",
      kind: "official",
      category: "weather",
      title: `${cancelled ? "（取消）" : ""}${label}${strength ? `［${strength}］` : ""}`,
      summary: [
        h.headline,
        [location ? `中心は${location}` : null, pressure !== null ? `中心気圧 ${pressure}hPa` : null, windMs !== null ? `最大風速 ${windMs}m/s` : null].filter(Boolean).join("・"),
      ]
        .filter(Boolean)
        .join(" ")
        .slice(0, 380),
      url: docUrl,
      publishedAt: at ?? h.reportAt,
      updatedAt: h.reportAt,
      place: coord ? { name: location ?? label, lat: coord.lat, lon: coord.lon } : null,
      facts: {
        report: reportName(docUrl),
        code: typhoonCode(docUrl),
        typhoon: number,
        typhoonKey: key,
        name: name ?? null,
        typhoonClass: typhoonClass ?? null,
        areaClass: areaClass || null,
        intensity: intensity || null,
        pressureHpa: pressure,
        windMs,
        windKt,
        infoType: h.infoType,
        cancelled,
      },
    },
    now,
  );
}

async function feed(url: string, ctx: SourceContext, maxBytes: number): Promise<AtomEntry[]> {
  return parseAtom(await getText(url, { hosts: HOSTS, fetchImpl: ctx.fetchImpl, accept: "application/atom+xml, application/xml", maxBytes }));
}

/** 地震・津波 */
export async function fetchJmaQuake(ctx: SourceContext): Promise<IntelItem[]> {
  const entries = await feed(JMA_EQVOL_URL, ctx, 2_000_000);
  // 前回から高頻度フィードの掲載時間以上あいたら、長期フィードで取りこぼしを補う
  if (ctx.lastSuccessAt === null || ctx.now - ctx.lastSuccessAt > HIGH_FREQ_WINDOW_MS) {
    const long = await feed(JMA_EQVOL_LONG_URL, ctx, 6_000_000).catch(() => []);
    entries.push(...long);
  }
  const wanted = new Map<string, { url: string; kind: "quake" | "tsunami"; updated: string }>();
  for (const e of entries) {
    const url = jmaDocUrl(e.link);
    if (!url) continue;
    const kind = /震源・震度に関する情報/.test(e.title) ? "quake" : /^津波警報・注意報・予報/.test(e.title) ? "tsunami" : null;
    if (!kind || ctx.knownReports.has(reportName(url))) continue;
    wanted.set(url, { url, kind, updated: e.updated ?? "" });
  }
  // 新しい電文から順に、上限まで読む（古い電文が新しい内容を上書きしないよう、取り込みは古い順に並べ直す）
  const picked = [...wanted.values()].sort((a, b) => b.updated.localeCompare(a.updated)).slice(0, MAX_DOCS_PER_RUN);
  const docs = await Promise.all(
    picked.map(async (p) => {
      try {
        const xml = await getText(p.url, { hosts: HOSTS, fetchImpl: ctx.fetchImpl, accept: "application/xml", maxBytes: 1_000_000 });
        return p.kind === "quake" ? parseQuakeDoc(xml, p.url, ctx.now) : parseTsunamiDoc(xml, p.url, ctx.now);
      } catch {
        return null; // 1 通読めなくても、ほかは取り込む（次の実行でもう一度読む）
      }
    }),
  );
  const items = docs.filter((d): d is IntelItem => d !== null);
  return items.sort((a, b) => (a.updatedAt ?? "").localeCompare(b.updatedAt ?? ""));
}

/* ---------- 台風のフィードの観測の記録（Phase 3：記録して渡すだけ。保存・判定はしない） ---------- */

const STREAM_RE = /^VPTW6[0-5]$/;
const REPORT_RE = /^[A-Za-z0-9_.-]{1,80}$/;

/** 電文 1 通の扱い（電文コードごと） */
interface StreamOutcome {
  bulletin: FeedBulletinOutcome;
  itemId: string | null;
  reportAt: string | null;
  docError: FeedStreamObservation["docError"];
}
const outcome = (bulletin: FeedBulletinOutcome, rest: Partial<StreamOutcome> = {}): StreamOutcome => ({ bulletin, itemId: null, reportAt: null, docError: null, ...rest });

/** 失敗の内容（種類・状態の番号・メッセージ） */
function errorInfo(err: unknown): { kind: IntelFetchErrorKind; httpStatus: number | null; message: string } {
  const message = cleanText(err instanceof Error ? err.message : "失敗しました", FEED_OBSERVATION_LIMITS.message);
  return err instanceof SourceError ? { kind: err.kind, httpStatus: err.status ?? null, message } : { kind: "other", httpStatus: null, message };
}

/** フィード全体の取得・解析に失敗した回の記録（件数は null・系列は空＝分からない。0 件・系列なしではない） */
function failedObservation(fetchedAt: string, status: "fetch-failed" | "unparseable", err: unknown): FeedObservation {
  return { source: "jmatyphoon", fetchedAt, status, failure: errorInfo(err), feedLastModified: null, feedNewestEntryAt: null, entryCount: null, typhoonEntryCount: null, streams: [] };
}

/**
 * 読めたフィードの記録。すでに読んだ電文で絞り込む前の、フィード全体から作る（新しい電文が無い回でも系列ごとの最新時刻が分かる）。
 * 時刻はフィードの項目の時刻（updated）で、電文の発表時刻（reportAt）とは別。読めない時刻は使わない（推測しない）。
 */
export function observeTyphoonFeed(entries: AtomEntry[], fetchedAt: string, outcomes: ReadonlyMap<string, StreamOutcome>): FeedObservation {
  let newest: string | null = null;
  let typhoonEntryCount = 0;
  const times = new Map<string, Set<string>>();
  for (const e of entries) {
    const at = isoStrict(e.updated);
    if (at && (!newest || Date.parse(at) > Date.parse(newest))) newest = at;
    const t = typhoonEntry(e);
    if (!t) continue;
    typhoonEntryCount++;
    if (at) (times.get(t.code) ?? times.set(t.code, new Set()).get(t.code)!).add(at);
  }
  const streams: FeedStreamObservation[] = [];
  for (const d of latestTyphoonDocs(entries)) {
    if (!STREAM_RE.test(d.code)) continue;
    const report = reportName(d.url);
    const o = outcomes.get(d.code) ?? outcome("doc-unparseable");
    streams.push({
      stream: d.code,
      latestAt: isoStrict(d.updated),
      latestReport: REPORT_RE.test(report) ? report : null,
      recentAt: [...(times.get(d.code) ?? [])].sort((a, b) => Date.parse(b) - Date.parse(a)).slice(0, FEED_OBSERVATION_LIMITS.recentAt),
      ...o,
    });
    if (streams.length >= FEED_OBSERVATION_LIMITS.streams) break;
  }
  return {
    source: "jmatyphoon",
    fetchedAt,
    status: "ok",
    failure: null,
    feedLastModified: null, // いまは取得しない（推測で埋めない）
    feedNewestEntryAt: newest,
    entryCount: entries.length,
    typhoonEntryCount,
    streams,
  };
}

/** 取得できたが台風の項目にならなかった電文の理由（訓練・試験の電文か、読めない電文か） */
function unreadableReason(xml: string): FeedBulletinOutcome {
  const status = tag(block(xml, "Control") ?? "", "Status");
  return status && status !== "通常" ? "doc-not-normal" : "doc-unparseable";
}

/**
 * 台風（電文コードごとに最新の電文だけを読む。1 通読めなくても、ほかの台風は取り込む）。
 * あわせて、フィードの観測の記録を ctx.observe に渡す（取り込む項目・重複の除き方・例外はこれまでと同じ）。
 */
export async function fetchJmaTyphoon(ctx: SourceContext): Promise<IntelItem[]> {
  const fetchedAt = new Date(ctx.now).toISOString();
  let text: string;
  try {
    text = await getText(JMA_EXTRA_LONG_URL, { hosts: HOSTS, fetchImpl: ctx.fetchImpl, accept: "application/atom+xml, application/xml", maxBytes: 8_000_000 });
  } catch (err) {
    reportObservation(ctx, failedObservation(fetchedAt, "fetch-failed", err));
    throw err; // これまでどおり、情報源の失敗として扱う
  }
  let entries: AtomEntry[];
  try {
    entries = parseAtom(text);
  } catch (err) {
    reportObservation(ctx, failedObservation(fetchedAt, "unparseable", err));
    throw err;
  }
  const latest = latestTyphoonDocs(entries);
  const outcomes = new Map<string, StreamOutcome>();
  for (const d of latest) if (ctx.knownReports.has(reportName(d.url))) outcomes.set(d.code, outcome("already-known"));
  const picked = latest.filter((d) => !ctx.knownReports.has(reportName(d.url)));
  const docs = await Promise.all(
    picked.map(async (d) => {
      let xml: string;
      try {
        xml = await getText(d.url, { hosts: HOSTS, fetchImpl: ctx.fetchImpl, accept: "application/xml", maxBytes: 1_000_000 });
      } catch (err) {
        const e = errorInfo(err);
        outcomes.set(d.code, outcome("doc-fetch-failed", { docError: { kind: e.kind, httpStatus: e.httpStatus } }));
        return null;
      }
      try {
        const item = parseTyphoonDoc(xml, d.url, ctx.now);
        outcomes.set(d.code, item ? outcome("new-read", { itemId: item.id, reportAt: isoStrict(item.updatedAt) }) : outcome(unreadableReason(xml)));
        return item;
      } catch {
        outcomes.set(d.code, outcome("doc-unparseable"));
        return null;
      }
    }),
  );
  reportObservation(ctx, observeTyphoonFeed(entries, fetchedAt, outcomes));
  return docs.filter((d): d is IntelItem => d !== null).sort((a, b) => (a.updatedAt ?? "").localeCompare(b.updatedAt ?? ""));
}
