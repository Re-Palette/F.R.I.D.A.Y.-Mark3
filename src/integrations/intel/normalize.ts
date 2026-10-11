/**
 * 情報源から来た 1 件を、安全な形に直す（文字の消毒・リンクの確認・座標の範囲・決まった値だけ通す）。
 * ここは保存・通知・脳（GitHub）への読み書きを一切読み込まない（確認用スクリプトからも安全に使えるように）。
 */
import { isSourceId } from "./sources";
import type {
  IntelBulletinHistoryEntry,
  IntelCategory,
  IntelConfidence,
  IntelFreshnessLevel,
  IntelItem,
  IntelKind,
  IntelLevel,
  IntelMatch,
  IntelPhenomenonCode,
  IntelPlace,
  IntelSourceActivity,
  IntelSourceRef,
  IntelTrackedEvent,
  IntelTracking,
  IntelTrackingStatus,
} from "./types";

const KINDS: IntelKind[] = ["official", "report", "ai-search", "research"];
const CATEGORIES: IntelCategory[] = ["disaster", "weather", "world", "tech", "business", "science", "space", "government"];
const LEVELS: IntelLevel[] = ["urgent", "high", "normal", "low"];
const CONFIDENCES: IntelConfidence[] = ["high", "medium", "low"];

/** 外から来た文字をきれいにする（制御文字・余分な空白を除き、長さを切る） */
export function cleanText(v: unknown, max: number): string {
  return String(v ?? "")
    .replace(/[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

/** http(s) のリンクだけ通す */
export function safeUrl(v: unknown): string | null {
  try {
    const u = new URL(String(v ?? ""));
    return u.protocol === "https:" || u.protocol === "http:" ? u.toString().slice(0, 500) : null;
  } catch {
    return null;
  }
}

function isoOrNull(v: unknown): string | null {
  if (typeof v !== "string" && typeof v !== "number") return null;
  const t = typeof v === "number" ? v : Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

function place(v: unknown): IntelPlace | null {
  const p = v as Partial<IntelPlace> | null;
  if (!p || typeof p !== "object") return null;
  const lat = Number(p.lat);
  const lon = Number(p.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { name: cleanText(p.name, 60), lat, lon };
}

function refs(v: unknown): IntelSourceRef[] {
  if (!Array.isArray(v)) return [];
  const out: IntelSourceRef[] = [];
  const seen = new Set<string>();
  for (const r of v as Partial<IntelSourceRef>[]) {
    const url = safeUrl(r?.url);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    out.push({ url, name: cleanText(r?.name, 60) });
    if (out.length >= 10) break; // 上限まで集まったら、残りは読まない
  }
  return out;
}

/** 文の一覧（これまでどおり、空でないものを先頭から上限まで。上限まで集まったら残りは読まない） */
function lines(v: unknown, max: number, len: number): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const x of v) {
    const t = cleanText(x, len);
    if (t) out.push(t);
    if (out.length >= max) break;
  }
  return out;
}

function facts(v: unknown): IntelItem["facts"] {
  const out: IntelItem["facts"] = {};
  if (!v || typeof v !== "object") return out;
  for (const [k, x] of Object.entries(v as Record<string, unknown>).slice(0, 20)) {
    if (typeof x === "number" && Number.isFinite(x)) out[cleanText(k, 30)] = x;
    else if (typeof x === "boolean" || x === null) out[cleanText(k, 30)] = x;
    else if (typeof x === "string") out[cleanText(k, 30)] = cleanText(x, 120);
  }
  return out;
}

const pick = <T extends string>(v: unknown, list: T[], fallback: T): T => (list.includes(v as T) ? (v as T) : fallback);

/** 1 件を安全な形に直す（必須の項目が無ければ null） */
export function normalizeItem(raw: unknown, fetchedAtFallback = new Date().toISOString()): IntelItem | null {
  const r = raw as Partial<IntelItem> | null;
  if (!r || typeof r !== "object") return null;
  const id = cleanText(r.id, 160);
  const source = String(r.source ?? "");
  const title = cleanText(r.title, 200);
  if (!id || !title || !isSourceId(source)) return null;
  const fetchedAt = isoOrNull(r.fetchedAt) ?? fetchedAtFallback;
  return {
    id,
    source,
    kind: pick(r.kind, KINDS, "report"),
    category: pick(r.category, CATEGORIES, "world"),
    title,
    summary: cleanText(r.summary, 400),
    url: safeUrl(r.url),
    publishedAt: isoOrNull(r.publishedAt),
    updatedAt: isoOrNull(r.updatedAt),
    fetchedAt,
    firstSeenAt: isoOrNull(r.firstSeenAt) ?? fetchedAt,
    place: place(r.place),
    level: pick(r.level, LEVELS, "normal"),
    confidence: pick(r.confidence, CONFIDENCES, "low"),
    reasons: lines(r.reasons, 6, 120),
    corroboration: refs(r.corroboration),
    clusterId: r.clusterId ? cleanText(r.clusterId, 160) : null,
    conflicts: lines(r.conflicts, 6, 160),
    facts: facts(r.facts),
    // 照合の結果は、あるときだけ持つ（無い項目・読めない値は、従来どおり項目に含めない）
    ...(() => {
      const m = match(r.match, id);
      return m ? { match: m } : {};
    })(),
  };
}


/* ---------- 一覧の読み込みの共通部品 ----------
 * 上限まで集まったら、残りは読まない（大きな入力でも、上限に比例した手間で終える）。
 * 読めない値・重複が続く入力も、見る数に上限（上限 × SCAN_FACTOR）を設けて打ち切る。
 */
const SCAN_FACTOR = 10;

/** 配列の先頭から、見る数の上限まで順に渡す（配列でなければ何もしない） */
function* scan(v: unknown, budget: number): Generator<unknown> {
  if (!Array.isArray(v)) return;
  const n = Math.min(v.length, budget);
  for (let i = 0; i < n; i++) yield v[i];
}

/** オブジェクトの値を、見る数の上限まで順に渡す */
function* scanValues(v: unknown, budget: number): Generator<[string, unknown]> {
  const o = obj(v);
  if (!o) return;
  let seen = 0;
  for (const k in o) {
    if (!Object.prototype.hasOwnProperty.call(o, k)) continue;
    if (seen++ >= budget) return;
    yield [k, o[k]];
  }
}

/**
 * 文字の一覧（文字列だけ・消毒・空を除く・重複を除く・件数の上限）。
 * 上限まで集まったら打ち切る。clean が null を返す値は捨てる。
 */
function texts(v: unknown, max: number, clean: (s: string) => string | null): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const x of scan(v, max * SCAN_FACTOR)) {
    if (typeof x !== "string") continue;
    const t = clean(x);
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
    if (out.length >= max) break;
  }
  return out;
}

/** 説明の文（消毒して長さを切る） */
const sentence = (len: number) => (s: string) => cleanText(s, len) || null;

/** オブジェクトのキーに使うと危ない名前（使うと中身が消えたり、オブジェクトの性質が変わったりする） */
const RESERVED_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/**
 * ID（出来事の ID・照合の相手・系列の最後の出来事など）。
 * 文字列だけ・前後の空白なし・制御文字なし・長さの上限以内。長すぎる ID は切り詰めない（別の ID と重なるのを防ぐ）。
 */
function idText(v: unknown, max: number): string | null {
  if (typeof v !== "string" || v.length === 0 || v.length > max) return null;
  if (v.trim() !== v || /[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩]/.test(v)) return null;
  return RESERVED_KEYS.has(v) ? null : v;
}

/** 照合の結果（状態が決まった値で、相手の ID が条件どおりのときだけ） */
function match(v: unknown, selfId: string): IntelMatch | null {
  const m = obj(v);
  if (!m || (m.status !== "confirmed" && m.status !== "pending")) return null;
  if (!Array.isArray(m.with)) return null;
  const basis = texts(m.basis, 6, sentence(160));
  if (m.status === "confirmed") {
    // 確定：相手は 1 件だけ（重複は 1 件とみなす）。読めない値・自分自身が混ざっていれば確定とは認めない
    const ids = new Set<string>();
    for (const x of scan(m.with, 10)) {
      const id = idText(x, 160);
      if (!id || id === selfId) return null;
      ids.add(id);
      if (ids.size > 1) return null;
    }
    return ids.size === 1 && m.with.length <= 10 ? { status: "confirmed", with: [...ids], basis } : null;
  }
  // 保留：候補は複数でよい（読めない値・自分自身・重複は除く。上限 10 件）
  const withIds = texts(m.with, 10, (s) => {
    const id = idText(s, 160);
    return id && id !== selfId ? id : null;
  });
  return withIds.length ? { status: "pending", with: withIds, basis } : null;
}

/* ---------- Phase 3：追跡の記録（state.json の tracking）の読み込み ----------
 * 方針：読めない記録は、その 1 件だけ捨てる（ほかの記録・状態ファイルの残りは消さない）。
 * 決まった値以外の状態は、推測して埋めずに「分からない」側（unknown・unverified・null）にする。
 * 追跡の状態そのもの（tracking.status）が読めない記録は、状態をでっちあげないよう捨てる。
 * 終わり（ended）は終了の根拠があるときだけ。根拠の無い ended は読み込まない。
 * 時刻は ISO 形式の文字列だけ（数値・数字だけの文字列・日付だけ・時差の無いものは時刻とみなさない）。
 */

/** 追跡する出来事の数・履歴などの上限（state.json を大きくしすぎない） */
export const TRACKING_LIMITS = { events: 30, streams: 30, history: 12, recentAt: 8, eventIds: 10, peers: 8, basis: 6 } as const;
/** 今の形の追跡の記録の版 */
export const TRACKING_VERSION = 1;
/** 発表の間隔として受け付ける上限（これより長い値は壊れているとみなす） */
const MAX_INTERVAL_MS = 48 * 60 * 60_000;
const MAX_MISSED_SLOTS = 1000;

const PHENOMENA: IntelPhenomenonCode[] = ["TY", "STS", "TS", "TD", "LOW", "unknown"];
const FRESHNESS: IntelFreshnessLevel[] = ["fresh", "due", "overdue", "unknown"];
const ACTIVITY: IntelSourceActivity[] = ["active", "event-stalled", "source-stalled", "unverified"];
const TRACKING_STATUS: IntelTrackingStatus[] = ["tracking", "paused", "dormant", "ended"];

const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const strOrNull = (v: unknown, max: number): string | null => (typeof v === "string" && cleanText(v, max) ? cleanText(v, max) : null);
const boolOrNull = (v: unknown): boolean | null => (typeof v === "boolean" ? v : null);
const numOrNull = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** 電文の系列の名前（例 VPTW62）。英数字と一部の記号だけ。オブジェクトのキーに使うので、危ない名前は受け付けない */
function streamName(v: unknown): string | null {
  return typeof v === "string" && /^[A-Za-z0-9_.:-]{1,40}$/.test(v) && !RESERVED_KEYS.has(v) ? v : null;
}

/** 電文の名前（例 20261011064059_0_VPTW62_010000） */
function reportName(v: unknown): string | null {
  return typeof v === "string" && /^[A-Za-z0-9_.-]{1,80}$/.test(v) && !RESERVED_KEYS.has(v) ? v : null;
}

/** ISO 形式の日時（日付＋時刻＋時差。例 2026-10-11T06:40:59Z）。ありえない日付（2 月 30 日など）も受け付けない */
const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(?:Z|[+-](\d{2}):(\d{2}))$/;
export function isoStrict(v: unknown): string | null {
  if (typeof v !== "string" || v.length > 40) return null;
  const m = ISO_RE.exec(v);
  if (!m) return null;
  const [y, mo, d, h, mi, s, oh, om] = [m[1], m[2], m[3], m[4], m[5], m[6] ?? "0", m[7] ?? "0", m[8] ?? "0"].map(Number);
  if (mo < 1 || mo > 12 || d < 1 || h > 23 || mi > 59 || s > 59 || oh > 23 || om > 59) return null;
  if (new Date(Date.UTC(y, mo - 1, d)).getUTCDate() !== d) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/** 時刻の一覧（ISO にそろえ、新しい順・重複なし・上限まで） */
function isoList(v: unknown, max: number): string[] {
  return texts(v, max, isoStrict).sort((a, b) => Date.parse(b) - Date.parse(a));
}

function historyEntry(v: unknown): IntelBulletinHistoryEntry | null {
  const h = obj(v);
  const report = reportName(h?.report);
  if (!h || !report) return null;
  return {
    report,
    serial: strOrNull(h.serial, 20),
    reportAt: isoStrict(h.reportAt),
    phenomenon: pick(h.phenomenon, PHENOMENA, "unknown"),
    pressureHpa: numOrNull(h.pressureHpa),
  };
}

/**
 * 鮮度。発表を逃した回数が読めなければ null（0 にしない）。
 * 段階と回数が食い違う記録（例：overdue なのに 0 回）は、どちらも信じず「判定できない」にする。
 *   fresh … 0 回 ／ due・overdue … 1 回以上 ／ unknown … 回数は持たない
 */
function freshness(v: unknown): IntelTrackedEvent["freshness"] {
  const fr = obj(v) ?? {};
  const raw = numOrNull(fr.missedSlots);
  let missed = raw !== null && Number.isInteger(raw) && raw >= 0 && raw <= MAX_MISSED_SLOTS ? raw : null;
  let level = pick(fr.level, FRESHNESS, "unknown");
  const consistent = level === "unknown" ? true : missed === null ? true : level === "fresh" ? missed === 0 : missed >= 1;
  if (!consistent) level = "unknown";
  if (level === "unknown") missed = null;
  return {
    level,
    missedSlots: missed,
    referenceAt: isoStrict(fr.referenceAt),
    basis: texts(fr.basis, TRACKING_LIMITS.basis, sentence(160)),
  };
}

/** 追跡の記録 1 件（読めなければ null） */
export function normalizeTrackedEvent(raw: unknown): IntelTrackedEvent | null {
  const e = obj(raw);
  if (!e) return null;
  const id = idText(e.id, 160);
  const source = typeof e.source === "string" ? e.source : "";
  const firstSeenAt = isoStrict(e.firstSeenAt);
  const lastEvaluatedAt = isoStrict(e.lastEvaluatedAt);
  const tr = obj(e.tracking);
  const status = tr?.status;
  const since = isoStrict(tr?.since);
  // 出来事の ID・情報源・時刻・追跡の状態が読めないものは、状態をでっちあげないよう捨てる
  if (!id || !isSourceId(source) || !firstSeenAt || !lastEvaluatedAt || !tr || !TRACKING_STATUS.includes(status as IntelTrackingStatus) || !since) return null;
  const endEvidence = strOrNull(tr.endEvidence, 200);
  // 終わり（ended）は終了の根拠があるときだけ
  if (status === "ended" && !endEvidence) return null;

  const ph = obj(e.phenomenon) ?? {};
  const lb = obj(e.lastBulletin) ?? {};
  const lbReport = reportName(lb.report);
  const phReport = reportName(ph.report);
  // 根拠の電文が分からない記録は、状態の出どころが分からないので捨てる
  if (!lbReport || !phReport) return null;
  const cd = obj(e.cadence) ?? {};
  const expectedMs = numOrNull(cd.expectedMs);
  const okInterval = expectedMs !== null && expectedMs > 0 && expectedMs <= MAX_INTERVAL_MS ? expectedMs : null;
  const sa = obj(e.sourceActivity) ?? {};
  const peers: IntelTrackedEvent["sourceActivity"]["peers"] = [];
  const peerSeen = new Set<string>();
  for (const p of scan(sa.peers, TRACKING_LIMITS.peers * SCAN_FACTOR)) {
    const q = obj(p);
    const stream = streamName(q?.stream);
    const latestAt = isoStrict(q?.latestAt);
    if (!stream || !latestAt || peerSeen.has(stream)) continue;
    peerSeen.add(stream);
    peers.push({ stream, latestAt });
    if (peers.length >= TRACKING_LIMITS.peers) break;
  }
  const history: IntelBulletinHistoryEntry[] = [];
  for (const h of scan(e.history, TRACKING_LIMITS.history * SCAN_FACTOR)) {
    const entry = historyEntry(h);
    if (entry) history.push(entry);
    if (history.length >= TRACKING_LIMITS.history) break;
  }

  return {
    id,
    source,
    stream: streamName(e.stream),
    seenEventIds: texts(e.seenEventIds, TRACKING_LIMITS.eventIds, (s) => idText(s, 60)),
    phenomenon: {
      code: pick(ph.code, PHENOMENA, "unknown"),
      raw: strOrNull(ph.raw, 60),
      observedAt: isoStrict(ph.observedAt),
      report: phReport,
    },
    lastBulletin: {
      report: lbReport,
      serial: strOrNull(lb.serial, 20),
      reportAt: isoStrict(lb.reportAt),
      targetAt: isoStrict(lb.targetAt),
      hasForecast: boolOrNull(lb.hasForecast),
      hasWindPart: boolOrNull(lb.hasWindPart),
      // 見出しが空だと確かめた（""）と、確かめられない（null）を分ける
      headline: typeof lb.headline === "string" ? cleanText(lb.headline, 200) : null,
    },
    cadence: {
      recentAt: isoList(cd.recentAt, TRACKING_LIMITS.recentAt),
      expectedMs: okInterval,
      // 間隔が無いなら、その出どころも無い
      basis: okInterval !== null && (cd.basis === "observed" || cd.basis === "config") ? cd.basis : null,
    },
    freshness: freshness(e.freshness),
    sourceActivity: {
      status: pick(sa.status, ACTIVITY, "unverified"),
      peers,
      basis: texts(sa.basis, TRACKING_LIMITS.basis, sentence(160)),
    },
    tracking: {
      status: status as IntelTrackingStatus,
      since,
      basis: texts(tr.basis, TRACKING_LIMITS.basis, sentence(160)),
      // 終わっていない記録には、終了の根拠を持たせない
      endEvidence: status === "ended" ? endEvidence : null,
    },
    history,
    firstSeenAt,
    lastEvaluatedAt,
  };
}

/**
 * 追跡の記録全体（state.json の tracking）を読む。今の版（1）の形でなければ null。
 * 読めない出来事・系列は 1 件ずつ捨て、読めたものは残す。同じ ID が重なったら、新しく判定したほうを残す。
 * 見る数にも上限がある（書く側は上限内でしか書かないので、ふつうは全部見る）。
 * 知らない版（2 以上）の記録は、ここでは読まない（state.ts が中身を変えずに書き戻す）。
 */
export function normalizeTracking(raw: unknown): IntelTracking | null {
  const t = obj(raw);
  if (!t || t.version !== TRACKING_VERSION) return null;
  const byId = new Map<string, IntelTrackedEvent>();
  for (const [, v] of scanValues(t.events, TRACKING_LIMITS.events * SCAN_FACTOR)) {
    const e = normalizeTrackedEvent(v);
    if (!e) continue;
    const prev = byId.get(e.id);
    if (!prev || Date.parse(e.lastEvaluatedAt) > Date.parse(prev.lastEvaluatedAt)) byId.set(e.id, e);
  }
  const events = Object.fromEntries(
    [...byId.values()]
      .sort((a, b) => Date.parse(b.lastEvaluatedAt) - Date.parse(a.lastEvaluatedAt))
      .slice(0, TRACKING_LIMITS.events)
      .map((e) => [e.id, e]),
  );
  const streamEntries: [string, { lastTrackedId: string; latestAt: string }][] = [];
  for (const [k, v] of scanValues(t.streams, TRACKING_LIMITS.streams * SCAN_FACTOR)) {
    const name = streamName(k);
    const s = obj(v);
    const lastTrackedId = idText(s?.lastTrackedId, 160);
    const latestAt = isoStrict(s?.latestAt);
    if (name && lastTrackedId && latestAt) streamEntries.push([name, { lastTrackedId, latestAt }]);
  }
  const streams = Object.fromEntries(streamEntries.sort((a, b) => Date.parse(b[1].latestAt) - Date.parse(a[1].latestAt)).slice(0, TRACKING_LIMITS.streams));
  return { version: TRACKING_VERSION, events, streams };
}

/**
 * 知らない版（今の版より新しい）の追跡の記録か。
 * 版が 2 以上の整数で、中身がオブジェクトのときだけ。壊れた記録（版が無い・数でない・1 以下）とは区別する。
 */
export function isUnsupportedTracking(raw: unknown): boolean {
  const t = obj(raw);
  return Boolean(t && typeof t.version === "number" && Number.isInteger(t.version) && t.version > TRACKING_VERSION);
}
