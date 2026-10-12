/**
 * フィードの観測の記録の保存（.friday/intel/observations.json）。Phase 3-1：保存の仕組みだけ（収集・分析・通知にはまだつながない）。
 *
 * 1 つのファイルに、情報源ごとの「直近の観測（そのまま）」と「履歴（小さくしたもの・新しい順・上限あり）」を持つ。
 *
 * 壊れたデータ・知らない版を守るための決まり：
 *   - ファイルが無い（読み込みが null）ときだけ、新しく作る
 *   - 中身が空・JSON でない・形が違う・知らない版・大きすぎる・深すぎるときは、読むのも書くのもやめて、理由をエラーで返す
 *     （空のデータで上書きしない。読めない履歴を黙って削って保存しない。どこが読めないかはエラーの path で分かる）
 *   - 消してよいのは、上限（件数・大きさ）を超えた古い履歴だけ。直近の観測は消さない
 *   - 書く前に、実際に書く文字列の大きさを確かめる
 * 読み書きは brain-io（GitHub の Contents API）を通す。読み込みは、無ければ null・取れなければ例外・中身が空なら ""。
 * update は、書き換えの関数が例外を出すと書かない。sha 無しの新規作成は、既にあるファイルを上書きできない。
 */
import { abortInfo, isWriteUnknown, type IntelBrainIO, INTEL_OBSERVATIONS_PATH } from "./brain-io";
import { cleanText, isoStrict } from "./normalize";
import { isSourceId } from "./sources";
import { inspectJsonValue } from "./state";
import {
  FEED_OBSERVATION_LIMITS,
  type FeedBulletinOutcome,
  type FeedObservation,
  type FeedObservationHistoryEntry,
  type FeedObservationStatus,
  type FeedStreamObservation,
  type IntelFetchErrorKind,
  type IntelObservationSourceRecord,
  type IntelObservationStore,
  type IntelSourceId,
} from "./types";

/** 今の形の版 */
export const OBSERVATION_STORE_VERSION = 1;

export const OBSERVATION_STORE_LIMITS = {
  /** 情報源ごとの履歴の件数（1 時間ごとの取得で約 7 日分） */
  history: 168,
  /** ファイル全体の大きさ（UTF-8 のバイト数。書く文字列そのもので測る） */
  bytes: 200_000,
  /** 入れ子の深さ（ファイル全体を 1 段目とする。今の形は 7 段まで） */
  depth: 8,
  /** 読む前に受け付ける大きさの上限（これを超えたら JSON として読まない） */
  readBytes: 1_000_000,
  /** 文字の長さ */
  itemId: 200,
  report: 80,
  stream: 40,
} as const;

export type ObservationStoreErrorCode =
  | "not-configured" // 脳につながっていない
  | "read-failed" // 読み込みに失敗した（ファイルが無いとはみなさない）
  | "write-failed" // 書き込みに失敗した
  | "empty" // ファイルはあるのに中身が空
  | "invalid-json" // JSON として読めない
  | "too-large" // 大きすぎる（読み込み時・書き込み前）
  | "too-deep" // 入れ子が深すぎる
  | "not-serializable" // JSON にすると値が変わる・消える値を含む（NaN・Infinity・undefined・関数・Date など）
  | "unsupported-version" // 知らない版（新しい版）。変更・上書きしない
  | "invalid-structure" // 形が違う（path で場所が分かる）
  | "invalid-observation" // 追加しようとした観測の形が違う
  | "out-of-order" // 追加しようとした観測が、直近の観測より古い（または同じ時刻で中身が違う）
  | "aborted" // 書き込みを送った後に止めた（GitHub 側で反映されたかは分からない）
  | "aborted-before-write" // 書き込みを送る前に止めた（書いていない）
  | "write-unknown"; // 書き込みを送った後に通信が切れた・GitHub の 5xx（反映されたかは分からない）

/** エラーの path・メッセージの長さの上限（文字数） */
export const OBSERVATION_STORE_ERROR_LIMITS = { path: 200, detail: 200, message: 400 } as const;

/** ファイルにある知らない項目名・情報源名の代わりに出す文言（名前そのものは出さない） */
export const UNKNOWN_KEY_LABEL = "<不正な項目名>";
export const UNKNOWN_SOURCE_LABEL = "<不正な情報源名>";

/** ログに出してよい形の文字にする（改行・制御文字・行区切り・書字方向の制御を空白にし、長さを切る） */
const logSafe = (v: unknown, max: number): string => cleanText(String(v ?? "").replace(/[\u0080-\u009f\u2028\u2029]/g, " "), max);

/**
 * 観測の記録の読み書きのエラー。path は形が違う場所（例 "sources.jmatyphoon.history[3].bulletin"）。
 * 中身の値・ファイルにある知らない名前は含めない（固定の文言に置き換える）。path・メッセージは長さを切り、制御文字を除く。
 */
export class ObservationStoreError extends Error {
  public readonly path: string | null;
  constructor(
    public readonly code: ObservationStoreErrorCode,
    path: string | null = null,
    detail?: string,
  ) {
    const p = path === null ? null : logSafe(path, OBSERVATION_STORE_ERROR_LIMITS.path);
    const d = detail ? logSafe(detail, OBSERVATION_STORE_ERROR_LIMITS.detail) : "";
    super(logSafe(`観測の記録（observations.json）：${code}${p ? `（${p}）` : ""}${d ? `：${d}` : ""}`, OBSERVATION_STORE_ERROR_LIMITS.message));
    this.path = p;
    this.name = "ObservationStoreError";
  }
}

/* ---------- 形の確かめ（厳密。読めないものは削らずにエラー） ---------- */

const STATUSES: FeedObservationStatus[] = ["ok", "fetch-failed", "unparseable"];
const BULLETINS: FeedBulletinOutcome[] = ["new-read", "already-known", "doc-fetch-failed", "doc-unparseable", "doc-not-normal"];
const ERROR_KINDS: IntelFetchErrorKind[] = ["http", "timeout", "network", "too-large", "redirect", "other"];
const STREAM_RE = /^[A-Za-z0-9_.:-]{1,40}$/;
const JMA_TYPHOON_STREAM_RE = /^VPTW6[0-5]$/;
const REPORT_RE = /^[A-Za-z0-9_.-]{1,80}$/;

const fail = (path: string, detail?: string): never => {
  throw new ObservationStoreError("invalid-structure", path, detail);
};

function record(v: unknown, path: string, keys: readonly string[]): Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v)) return fail(path, "オブジェクトではありません");
  const o = v as Record<string, unknown>;
  const at = (k: string) => (path === "$" ? k : `${path}.${k}`); // ファイル全体（$）の直下は項目名だけ
  for (const k of Object.keys(o)) if (!keys.includes(k)) fail(at(UNKNOWN_KEY_LABEL), "知らない項目です"); // 名前そのものは出さない
  for (const k of keys) if (!Object.prototype.hasOwnProperty.call(o, k)) fail(at(k), "項目がありません");
  return o;
}

function list(v: unknown, path: string, max: number): unknown[] {
  if (!Array.isArray(v)) return fail(path, "配列ではありません");
  if (v.length > max) fail(path, `件数が上限（${max}）を超えています`);
  return v;
}

/** ISO 形式（UTC・ミリ秒つき）の時刻そのものか。書き直すと値が変わるものは受け付けない */
function iso(v: unknown, path: string): string {
  if (typeof v !== "string" || isoStrict(v) !== v) fail(path, "時刻の形が違います");
  return v as string;
}
const isoOrNull = (v: unknown, path: string): string | null => (v === null ? null : iso(v, path));

function oneOf<T extends string>(v: unknown, values: readonly T[], path: string): T {
  if (typeof v !== "string" || !values.includes(v as T)) fail(path, "決まった値ではありません");
  return v as T;
}

function countOrNull(v: unknown, path: string): number | null {
  if (v === null) return null;
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0) fail(path, "0 以上の整数ではありません");
  return v as number;
}

function httpStatus(v: unknown, kind: IntelFetchErrorKind, path: string): number | null {
  if (v === null) {
    if (kind === "http") fail(path, "HTTP の失敗なのに状態の番号がありません");
    return null;
  }
  if (typeof v !== "number" || !Number.isInteger(v) || v < 100 || v > 599) fail(path, "HTTP の状態の番号ではありません");
  if (kind !== "http") fail(path, "HTTP 以外の失敗に状態の番号があります");
  return v as number;
}

function errorRef(v: unknown, path: string): { kind: IntelFetchErrorKind; httpStatus: number | null } {
  const o = record(v, path, ["kind", "httpStatus"]);
  const kind = oneOf(o.kind, ERROR_KINDS, `${path}.kind`);
  return { kind, httpStatus: httpStatus(o.httpStatus, kind, `${path}.httpStatus`) };
}

function streamName(v: unknown, source: IntelSourceId, path: string): string {
  if (typeof v !== "string" || !STREAM_RE.test(v)) fail(path, "系列の名前の形が違います");
  if (source === "jmatyphoon" && !JMA_TYPHOON_STREAM_RE.test(v as string)) fail(path, "気象庁の台風の系列（VPTW60〜65）ではありません");
  return v as string;
}

const reportOrNull = (v: unknown, path: string): string | null => {
  if (v === null) return null;
  if (typeof v !== "string" || !REPORT_RE.test(v)) fail(path, "電文の名前の形が違います");
  return v as string;
};

/** 系列ごとの扱いと、ほかの項目の組み合わせ（new-read だけが項目の id・発表時刻を持ち、doc-fetch-failed だけが失敗の種類を持つ） */
function checkStreamFields(o: Record<string, unknown>, bulletin: FeedBulletinOutcome, path: string, withDetail: boolean): void {
  if (bulletin !== "new-read" && o.reportAt !== null) fail(`${path}.reportAt`, "新しく読んだ電文でないのに発表時刻があります");
  if (!withDetail) return;
  if (bulletin === "new-read") {
    if (typeof o.itemId !== "string" || !o.itemId || o.itemId.length > OBSERVATION_STORE_LIMITS.itemId || cleanText(o.itemId, OBSERVATION_STORE_LIMITS.itemId) !== o.itemId)
      fail(`${path}.itemId`, "項目の id の形が違います");
  } else if (o.itemId !== null) fail(`${path}.itemId`, "新しく読んだ電文でないのに項目の id があります");
  if (bulletin === "doc-fetch-failed") {
    if (o.docError === null) fail(`${path}.docError`, "電文の取得の失敗なのに種類がありません");
  } else if (o.docError !== null) fail(`${path}.docError`, "電文の取得の失敗でないのに種類があります");
}

function streamObservation(v: unknown, source: IntelSourceId, path: string): FeedStreamObservation {
  const o = record(v, path, ["stream", "latestAt", "latestReport", "recentAt", "bulletin", "itemId", "reportAt", "docError"]);
  const bulletin = oneOf(o.bulletin, BULLETINS, `${path}.bulletin`);
  checkStreamFields(o, bulletin, path, true);
  const recentAt = list(o.recentAt, `${path}.recentAt`, FEED_OBSERVATION_LIMITS.recentAt).map((t, i) => iso(t, `${path}.recentAt[${i}]`));
  for (let i = 1; i < recentAt.length; i++) if (Date.parse(recentAt[i]) >= Date.parse(recentAt[i - 1])) fail(`${path}.recentAt[${i}]`, "新しい順・重複なしではありません");
  return {
    stream: streamName(o.stream, source, `${path}.stream`),
    latestAt: isoOrNull(o.latestAt, `${path}.latestAt`),
    latestReport: reportOrNull(o.latestReport, `${path}.latestReport`),
    recentAt,
    bulletin,
    itemId: o.itemId as string | null,
    reportAt: isoOrNull(o.reportAt, `${path}.reportAt`),
    docError: o.docError === null ? null : errorRef(o.docError, `${path}.docError`),
  };
}

function uniqueStreams(streams: { stream: string }[], path: string): void {
  const seen = new Set<string>();
  streams.forEach((s, i) => {
    if (seen.has(s.stream)) fail(`${path}[${i}].stream`, "同じ系列が重なっています");
    seen.add(s.stream);
  });
}

/** 取得の結果（status）と、失敗・件数・系列の組み合わせ（失敗の回は件数 null・系列なし。ok の回は失敗なし・件数あり） */
function checkStatusFields(status: FeedObservationStatus, failure: unknown, feedNewestEntryAt: unknown, streams: unknown[], path: string, counts?: { entry: number | null; typhoon: number | null }): void {
  if (status === "ok") {
    if (failure !== null) fail(`${path}.failure`, "取得できた回に失敗の内容があります");
    if (counts && (counts.entry === null || counts.typhoon === null)) fail(`${path}.entryCount`, "取得できた回に件数がありません");
    if (counts && counts.typhoon !== null && counts.entry !== null && counts.typhoon > counts.entry) fail(`${path}.typhoonEntryCount`, "全体の件数より多くなっています");
  } else {
    if (failure === null) fail(`${path}.failure`, "失敗の回に失敗の内容がありません");
    if (feedNewestEntryAt !== null) fail(`${path}.feedNewestEntryAt`, "失敗の回に時刻があります");
    if (streams.length) fail(`${path}.streams`, "失敗の回に系列があります");
    if (counts && (counts.entry !== null || counts.typhoon !== null)) fail(`${path}.entryCount`, "失敗の回に件数があります（分からないは null）");
  }
}

/** 観測の記録 1 件（第 2 段階の FeedObservation）。source は期待する情報源 */
export function validateFeedObservation(v: unknown, path = "observation", expectedSource?: IntelSourceId): FeedObservation {
  const o = record(v, path, ["source", "fetchedAt", "status", "failure", "feedLastModified", "feedNewestEntryAt", "entryCount", "typhoonEntryCount", "streams"]);
  if (typeof o.source !== "string" || !isSourceId(o.source)) return fail(`${path}.source`, "知らない情報源です");
  const source = o.source as IntelSourceId;
  if (expectedSource && source !== expectedSource) fail(`${path}.source`, "置き場所の情報源と違います");
  const status = oneOf(o.status, STATUSES, `${path}.status`);
  let failure: FeedObservation["failure"] = null;
  if (o.failure !== null) {
    const f = record(o.failure, `${path}.failure`, ["kind", "httpStatus", "message"]);
    const kind = oneOf(f.kind, ERROR_KINDS, `${path}.failure.kind`);
    if (typeof f.message !== "string" || cleanText(f.message, FEED_OBSERVATION_LIMITS.message) !== f.message) fail(`${path}.failure.message`, "メッセージの形が違います（長さ・制御文字）");
    failure = { kind, httpStatus: httpStatus(f.httpStatus, kind, `${path}.failure.httpStatus`), message: f.message as string };
  }
  const entryCount = countOrNull(o.entryCount, `${path}.entryCount`);
  const typhoonEntryCount = countOrNull(o.typhoonEntryCount, `${path}.typhoonEntryCount`);
  const rawStreams = list(o.streams, `${path}.streams`, FEED_OBSERVATION_LIMITS.streams);
  checkStatusFields(status, o.failure, o.feedNewestEntryAt, rawStreams, path, { entry: entryCount, typhoon: typhoonEntryCount });
  const streams = rawStreams.map((s, i) => streamObservation(s, source, `${path}.streams[${i}]`));
  uniqueStreams(streams, `${path}.streams`);
  return {
    source,
    fetchedAt: iso(o.fetchedAt, `${path}.fetchedAt`),
    status,
    failure,
    feedLastModified: isoOrNull(o.feedLastModified, `${path}.feedLastModified`),
    feedNewestEntryAt: isoOrNull(o.feedNewestEntryAt, `${path}.feedNewestEntryAt`),
    entryCount,
    typhoonEntryCount,
    streams,
  };
}

function historyEntry(v: unknown, source: IntelSourceId, path: string): FeedObservationHistoryEntry {
  const o = record(v, path, ["fetchedAt", "status", "feedNewestEntryAt", "failure", "streams"]);
  const status = oneOf(o.status, STATUSES, `${path}.status`);
  const rawStreams = list(o.streams, `${path}.streams`, FEED_OBSERVATION_LIMITS.streams);
  checkStatusFields(status, o.failure, o.feedNewestEntryAt, rawStreams, path);
  const streams = rawStreams.map((s, i) => {
    const p = `${path}.streams[${i}]`;
    const so = record(s, p, ["stream", "latestAt", "latestReport", "bulletin", "reportAt"]);
    const bulletin = oneOf(so.bulletin, BULLETINS, `${p}.bulletin`);
    checkStreamFields(so, bulletin, p, false);
    return {
      stream: streamName(so.stream, source, `${p}.stream`),
      latestAt: isoOrNull(so.latestAt, `${p}.latestAt`),
      latestReport: reportOrNull(so.latestReport, `${p}.latestReport`),
      bulletin,
      reportAt: isoOrNull(so.reportAt, `${p}.reportAt`),
    };
  });
  uniqueStreams(streams, `${path}.streams`);
  return {
    fetchedAt: iso(o.fetchedAt, `${path}.fetchedAt`),
    status,
    feedNewestEntryAt: isoOrNull(o.feedNewestEntryAt, `${path}.feedNewestEntryAt`),
    failure: o.failure === null ? null : errorRef(o.failure, `${path}.failure`),
    streams,
  };
}

/** 観測の記録を、履歴に入れる小さな形にする（直近の時刻の一覧・項目の id・失敗のメッセージ・件数は持たない） */
export function toHistoryEntry(o: FeedObservation): FeedObservationHistoryEntry {
  return {
    fetchedAt: o.fetchedAt,
    status: o.status,
    feedNewestEntryAt: o.feedNewestEntryAt,
    failure: o.failure ? { kind: o.failure.kind, httpStatus: o.failure.httpStatus } : null,
    streams: o.streams.map((s) => ({ stream: s.stream, latestAt: s.latestAt, latestReport: s.latestReport, bulletin: s.bulletin, reportAt: s.reportAt })),
  };
}

const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

function sourceRecord(v: unknown, source: IntelSourceId, path: string): IntelObservationSourceRecord {
  const o = record(v, path, ["latest", "history"]);
  const latest = validateFeedObservation(o.latest, `${path}.latest`, source);
  const raw = list(o.history, `${path}.history`, OBSERVATION_STORE_LIMITS.history);
  const history = raw.map((h, i) => historyEntry(h, source, `${path}.history[${i}]`));
  if (!history.length) fail(`${path}.history`, "履歴が空です（直近の観測が先頭に入るはず）");
  if (!sameJson(history[0], toHistoryEntry(latest))) fail(`${path}.history[0]`, "直近の観測と一致しません");
  for (let i = 1; i < history.length; i++)
    if (Date.parse(history[i].fetchedAt) >= Date.parse(history[i - 1].fetchedAt)) fail(`${path}.history[${i}].fetchedAt`, "新しい順・重複なしではありません");
  return { latest, history };
}

/**
 * JSON にしてもそのまま戻る値か（深さも）。JSON.parse(JSON.stringify(…)) で写す前に、元の値に対して使う
 * （NaN・Infinity は null に、undefined・関数の項目は消え、Date は文字になってしまうため、写した後では見つけられない）。
 */
function checkJsonValue(v: unknown, path: string, code?: ObservationStoreErrorCode): void {
  let shape: ReturnType<typeof inspectJsonValue>;
  try {
    shape = inspectJsonValue(v, OBSERVATION_STORE_LIMITS.depth);
  } catch {
    shape = "not-serializable";
  }
  if (shape !== "ok") throw new ObservationStoreError(code ?? (shape === "too-deep" ? "too-deep" : "not-serializable"), path, shape);
}

/**
 * 保存データ（JSON.parse した値）を確かめる。今の形と少しでも違えばエラー（削らない・直さない）。
 * 知らない版は unsupported-version。深すぎるものは too-deep、書き戻せない値は not-serializable。
 */
export function validateObservationStore(v: unknown): IntelObservationStore {
  if (!v || typeof v !== "object" || Array.isArray(v)) return fail("$", "オブジェクトではありません");
  const version = (v as { version?: unknown }).version;
  if (typeof version === "number" && Number.isInteger(version) && version > OBSERVATION_STORE_VERSION) throw new ObservationStoreError("unsupported-version", "version", String(version));
  checkJsonValue(v, "$");
  const o = record(v, "$", ["version", "sources"]);
  if (o.version !== OBSERVATION_STORE_VERSION) fail("version", "版が正しくありません");
  const src = record(o.sources, "sources", Object.keys((o.sources as object) ?? {}));
  const sources: IntelObservationStore["sources"] = {};
  for (const key of Object.keys(src)) {
    if (!isSourceId(key)) fail(`sources.${UNKNOWN_SOURCE_LABEL}`, "知らない情報源です"); // 名前そのものは出さない
    sources[key as IntelSourceId] = sourceRecord(src[key], key as IntelSourceId, `sources.${key}`);
  }
  return { version: OBSERVATION_STORE_VERSION, sources };
}

/* ---------- 純粋な関数（読み書きしない） ---------- */

export function emptyObservationStore(): IntelObservationStore {
  return { version: OBSERVATION_STORE_VERSION, sources: {} };
}

/**
 * 読み込んだ中身を解釈する。null（ファイルが無いと確かめられた）だけが新しい空の記録になる。
 * 空・JSON でない・形が違う・知らない版・大きすぎるときはエラー（空の記録として扱わない）。
 */
export function parseObservationStore(raw: string | null): { exists: boolean; store: IntelObservationStore } {
  if (raw === null) return { exists: false, store: emptyObservationStore() };
  if (typeof raw !== "string") throw new ObservationStoreError("read-failed", null, "文字列ではありません");
  if (!raw.trim()) throw new ObservationStoreError("empty");
  if (Buffer.byteLength(raw, "utf8") > OBSERVATION_STORE_LIMITS.readBytes) throw new ObservationStoreError("too-large", "$", "読み込める大きさを超えています");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ObservationStoreError("invalid-json");
  }
  const store = validateObservationStore(parsed);
  if (Buffer.byteLength(raw, "utf8") > OBSERVATION_STORE_LIMITS.bytes) throw new ObservationStoreError("too-large", "$", `上限（${OBSERVATION_STORE_LIMITS.bytes} バイト）を超えています`);
  return { exists: true, store };
}

/** 書く文字列。形を確かめ直し、実際の大きさが上限を超えればエラー（書かない） */
export function serializeObservationStore(store: IntelObservationStore): string {
  checkJsonValue(store, "$"); // 写す前に（値が変わる・消えるものを黙って書かない）
  const text = JSON.stringify(validateObservationStore(JSON.parse(JSON.stringify(store))));
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > OBSERVATION_STORE_LIMITS.bytes) throw new ObservationStoreError("too-large", "$", `${bytes} バイト（上限 ${OBSERVATION_STORE_LIMITS.bytes}）`);
  return text;
}

const storeBytes = (store: IntelObservationStore): number => Buffer.byteLength(JSON.stringify(store), "utf8");

/**
 * 観測の記録を 1 件足した、新しい記録を返す（元の記録は変えない）。
 *   - 直近の観測を置き換え、履歴の先頭に小さくしたものを足す（新しい順）
 *   - 履歴が 168 件を超えたら、その情報源の古いものから捨てる
 *   - ファイル全体が 200KB を超えたら、すべての情報源の中で一番古い履歴から 1 件ずつ捨てる（直近の観測とその履歴の先頭は捨てない）
 *   - それでも超えるならエラー（書かない）
 *   - 直近の観測と同じものは何も変えない。直近より古い・同じ時刻で中身が違うものはエラー
 * dropped は捨てた履歴の件数。
 */
export function appendObservation(store: IntelObservationStore, observation: unknown): { store: IntelObservationStore; dropped: number; changed: boolean } {
  let obs: FeedObservation;
  try {
    checkJsonValue(observation, "observation", "invalid-observation"); // 写す前に（NaN・undefined などを null・欠落にしない）
    obs = validateFeedObservation(JSON.parse(JSON.stringify(observation ?? null)));
  } catch (err) {
    if (err instanceof ObservationStoreError) throw err.code === "invalid-observation" ? err : new ObservationStoreError("invalid-observation", err.path, err.message);
    throw new ObservationStoreError("invalid-observation", null, "JSON にできません");
  }
  checkJsonValue(store, "$");
  const base = validateObservationStore(JSON.parse(JSON.stringify(store)));
  const prev = base.sources[obs.source];
  if (prev) {
    const t = Date.parse(obs.fetchedAt);
    const last = Date.parse(prev.latest.fetchedAt);
    if (t === last && sameJson(prev.latest, obs)) return { store: base, dropped: 0, changed: false };
    if (t <= last) throw new ObservationStoreError("out-of-order", `sources.${obs.source}.latest.fetchedAt`, "直近の観測より新しくありません");
  }
  const history = [toHistoryEntry(obs), ...(prev?.history ?? [])];
  let dropped = Math.max(0, history.length - OBSERVATION_STORE_LIMITS.history);
  const next: IntelObservationStore = {
    version: OBSERVATION_STORE_VERSION,
    sources: { ...base.sources, [obs.source]: { latest: obs, history: history.slice(0, OBSERVATION_STORE_LIMITS.history) } },
  };
  // 大きさの上限：一番古い履歴から 1 件ずつ捨てる（各情報源の先頭＝直近の観測の分は残す）
  while (storeBytes(next) > OBSERVATION_STORE_LIMITS.bytes) {
    let oldest: { id: IntelSourceId; at: number } | null = null;
    for (const [id, rec] of Object.entries(next.sources) as [IntelSourceId, IntelObservationSourceRecord][]) {
      if (rec.history.length <= 1) continue;
      const at = Date.parse(rec.history[rec.history.length - 1].fetchedAt);
      if (!oldest || at < oldest.at) oldest = { id, at };
    }
    if (!oldest) throw new ObservationStoreError("too-large", "$", "直近の観測だけで上限を超えています");
    const rec = next.sources[oldest.id]!;
    next.sources[oldest.id] = { latest: rec.latest, history: rec.history.slice(0, -1) };
    dropped++;
  }
  return { store: next, dropped, changed: true };
}

/* ---------- 読み書き（brain-io を通す） ---------- */

export type ObservationStoreResult<T> = ({ ok: true } & T) | { ok: false; error: ObservationStoreError };

const asStoreError = (err: unknown, fallback: ObservationStoreErrorCode): ObservationStoreError =>
  err instanceof ObservationStoreError ? err : new ObservationStoreError(fallback, null, err instanceof Error ? cleanText(err.message, 120) : undefined);

/** 安全に読む。読めない（失敗・空・壊れている・知らない版）ときは ok:false（ファイルが無いとはみなさない） */
export async function readObservationStore(io: IntelBrainIO): Promise<ObservationStoreResult<{ exists: boolean; store: IntelObservationStore }>> {
  if (!io.configured()) return { ok: false, error: new ObservationStoreError("not-configured") };
  let raw: string | null;
  try {
    raw = await io.read(INTEL_OBSERVATIONS_PATH);
  } catch (err) {
    return { ok: false, error: asStoreError(err, "read-failed") };
  }
  try {
    return { ok: true, ...parseObservationStore(raw) };
  } catch (err) {
    return { ok: false, error: asStoreError(err, "invalid-structure") };
  }
}

/**
 * 観測の記録を 1 件足して保存する。書き換えの関数の中で最新の中身を読み直して確かめ、
 * 読めない（空・壊れている・知らない版など）ときは例外を出して書かない（brain-io の update は、例外なら書かない）。
 * ファイルが無いときだけ新しく作る（sha 無しの作成は、既にあるファイルを上書きできない）。
 */
export async function recordObservation(
  io: IntelBrainIO,
  observation: FeedObservation,
  opts?: { signal?: AbortSignal },
): Promise<ObservationStoreResult<{ created: boolean; changed: boolean; dropped: number; bytes: number }>> {
  if (!io.configured()) return { ok: false, error: new ObservationStoreError("not-configured") };
  const signal = opts?.signal;
  if (signal?.aborted) return { ok: false, error: new ObservationStoreError("aborted-before-write") };
  let info = { created: false, changed: false, dropped: 0, bytes: 0 };
  try {
    await io.update(
      INTEL_OBSERVATIONS_PATH,
      (current) => {
        const { exists, store } = parseObservationStore(current);
        const r = appendObservation(store, observation);
        if (!r.changed && exists && current !== null) {
          info = { created: false, changed: false, dropped: 0, bytes: Buffer.byteLength(current, "utf8") };
          return current; // 変わらない（同じ中身なら書かない）
        }
        const text = serializeObservationStore(r.store);
        info = { created: !exists, changed: true, dropped: r.dropped, bytes: Buffer.byteLength(text, "utf8") };
        return text;
      },
      "E.D.I.T.H.: 観測の記録",
      signal ? { signal } : undefined,
    );
  } catch (err) {
    // 止めたとき：書き込みを送った後なら「分からない」（取り消せない）、送る前なら「書いていない」
    const aborted = abortInfo(err);
    if (aborted) return { ok: false, error: new ObservationStoreError(aborted.maybeWritten ? "aborted" : "aborted-before-write") };
    if (isWriteUnknown(err)) return { ok: false, error: new ObservationStoreError("write-unknown") };
    // 見分けのつかない失敗でも、止めた後なら「分からない」側に倒す（書いていないとは言わない）
    if (signal?.aborted && !(err instanceof ObservationStoreError)) return { ok: false, error: new ObservationStoreError("aborted") };
    return { ok: false, error: asStoreError(err, "write-failed") };
  }
  return { ok: true, ...info };
}
