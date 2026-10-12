/**
 * GOD'S EYE VIEW（EARTH）の人工衛星レイヤー：軌道データ（CelesTrak の GP。OMM の JSON 形式）の読み取りと、
 * satellite.js（SGP4）による位置の計算。
 *   - 軌道データの取得（サーバー：/api/edith/earth/satellites）と、位置の計算（この画面の中）は分ける。
 *     位置を計算するたびに取りに行くことはない
 *   - 計算した位置は「軌道要素から計算した推定位置」で、観測した位置ではない。
 *     画面には、軌道データの取得時刻・軌道要素の時刻（EPOCH）・位置の計算に使った時刻を分けて出す
 *   - 座標：SGP4 の結果（TEME の慣性系）を、グリニッジ恒星時で地球に固定した座標（緯度・経度・高度）に直す
 */
import { degreesLat, degreesLong, eciToGeodetic, gstime, json2satrec, propagate, type OMMJsonObject, type SatRec } from "satellite.js";

/** 選べる衛星のグループ（CelesTrak の GROUP の名前） */
export const SAT_GROUPS = [
  { key: "stations", label: "宇宙ステーション（ISS など）" },
  { key: "visual", label: "明るい衛星（肉眼で見えるもの）" },
  { key: "weather", label: "気象衛星" },
  { key: "gnss", label: "測位衛星（GPS など）" },
] as const;
export type SatGroup = (typeof SAT_GROUPS)[number]["key"];
export const isSatGroup = (v: unknown): v is SatGroup => SAT_GROUPS.some((g) => g.key === v);

/** 一度に描く衛星の数（既定・上限） */
export const SAT_LIMIT_DEFAULT = 40;
export const SAT_LIMIT_MAX = 150;
/** 1 回の読み取りで受け付ける件数の上限（それ以上は読まない） */
export const SAT_PARSE_MAX = 400;

/** 画面から軌道データを取りに行く間隔（サーバー側は 2 時間ためておく） */
export const SAT_POLL_MS = 60 * 60_000;
/** 軌道データの取得がこれより古ければ STALE */
export const SAT_STALE_MS = 6 * 60 * 60_000;
/** 位置を計算し直す間隔 */
export const SAT_TICK_MS = 1000;

/** 軌道データ 1 件（OMM のうち、計算に使う項目だけ） */
export interface OrbitElement {
  /** NORAD のカタログ番号 */
  id: string;
  name: string;
  /** 国際標識番号（例 1998-067A） */
  intlId: string | null;
  /** 軌道要素の時刻（ISO・UTC） */
  epoch: string;
  omm: OMMJsonObject;
}

export type SatellitesOk = {
  ok: true;
  source: "CelesTrak";
  group: SatGroup;
  /** CelesTrak から取得した時刻（ISO） */
  fetchedAt: string;
  elements: OrbitElement[];
};

/**
 * 取得できなかった理由（サーバーが決める）
 *   rate-limited … 429（アクセスの制限）。待ってから自動で確認する
 *   temporary    … 5xx・時間切れ・接続の失敗。少しずつ間を空けて自動で確認する
 *   long-stop    … 一時的な失敗が続いた。長く空けてから 1 回だけ自動で確認する
 *   halted       … 403・リダイレクト・404・データ形式の異常など。原因を確かめるまで自動では取りに行かない
 */
export type SatFailReason = "rate-limited" | "temporary" | "long-stop" | "halted";
/** 止めている範囲：CelesTrak 全体（全グループ）か、このグループだけか */
export type SatFailScope = "all" | "group";

export type SatellitesFail = {
  ok: false;
  error: string;
  /** 以下は追加の項目（古いサーバー・古い画面では無い） */
  reason?: SatFailReason;
  scope?: SatFailScope;
  /** 次に自動で確認する時刻（ISO）。null は「自動では取りに行かない」 */
  retryAt?: string | null;
  /** 最後に取れたデータ（取得時刻はその時のまま。最新のデータではない） */
  last?: SatellitesOk | null;
};

export type SatellitesResponse = SatellitesOk | SatellitesFail;

/** 自動では取りに行かない状態のとき、画面がサーバーに状態を確かめに行く間隔（サーバーは外へは取りに行かない） */
export const SAT_HALT_RECHECK_MS = 6 * 60 * 60_000;

const NUM_FIELDS = ["MEAN_MOTION", "ECCENTRICITY", "INCLINATION", "RA_OF_ASC_NODE", "ARG_OF_PERICENTER", "MEAN_ANOMALY", "BSTAR", "MEAN_MOTION_DOT", "MEAN_MOTION_DDOT"] as const;

const finite = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};
const clean = (v: unknown, max = 80): string | null => (typeof v === "string" && v.trim() ? v.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, max) : null);

/** EPOCH を ISO に（タイムゾーンが無ければ UTC とみなす） */
export function epochMs(epoch: string): number {
  const s = /[zZ]|[+-]\d\d:?\d\d$/.test(epoch) ? epoch : `${epoch}Z`;
  return Date.parse(s);
}

/** OMM 1 件を確かめる（計算できない・形の違うものは null） */
export function parseOmm(raw: unknown): OrbitElement | null {
  const o = raw as Record<string, unknown> | null;
  if (!o || typeof o !== "object" || Array.isArray(o)) return null;
  const name = clean(o.OBJECT_NAME);
  const norad = finite(o.NORAD_CAT_ID);
  const epoch = clean(o.EPOCH, 40);
  if (!name || norad === null || !Number.isInteger(norad) || norad <= 0 || !epoch || !Number.isFinite(epochMs(epoch))) return null;
  if (o.EPHEMERIS_TYPE !== undefined && finite(o.EPHEMERIS_TYPE) !== 0) return null; // SGP4 で計算できるのは 0 だけ
  if (o.CENTER_NAME !== undefined && o.CENTER_NAME !== "EARTH") return null;
  if (o.REF_FRAME !== undefined && o.REF_FRAME !== "TEME") return null;
  const nums: Record<string, number> = {};
  for (const k of NUM_FIELDS) {
    const n = finite(o[k]);
    if (n === null) return null;
    nums[k] = n;
  }
  const ecc = nums.ECCENTRICITY;
  if (ecc < 0 || ecc >= 1 || nums.MEAN_MOTION <= 0 || nums.MEAN_MOTION > 20) return null;
  const omm: OMMJsonObject = {
    OBJECT_NAME: name,
    OBJECT_ID: clean(o.OBJECT_ID, 20) ?? "",
    EPOCH: new Date(epochMs(epoch)).toISOString().replace("Z", ""),
    MEAN_MOTION: nums.MEAN_MOTION,
    ECCENTRICITY: ecc,
    INCLINATION: nums.INCLINATION,
    RA_OF_ASC_NODE: nums.RA_OF_ASC_NODE,
    ARG_OF_PERICENTER: nums.ARG_OF_PERICENTER,
    MEAN_ANOMALY: nums.MEAN_ANOMALY,
    EPHEMERIS_TYPE: 0,
    CLASSIFICATION_TYPE: "U",
    NORAD_CAT_ID: norad,
    ELEMENT_SET_NO: finite(o.ELEMENT_SET_NO) ?? 999,
    REV_AT_EPOCH: finite(o.REV_AT_EPOCH) ?? 0,
    BSTAR: nums.BSTAR,
    MEAN_MOTION_DOT: nums.MEAN_MOTION_DOT,
    MEAN_MOTION_DDOT: nums.MEAN_MOTION_DDOT,
  };
  return { id: String(norad), name, intlId: clean(o.OBJECT_ID, 20), epoch: new Date(epochMs(epoch)).toISOString(), omm };
}

/** OMM の配列を読む（全体が配列でなければ例外。おかしな項目は捨てる。同じ番号は 1 件に。max 件まで） */
export function parseOmmList(json: unknown, max = SAT_PARSE_MAX): OrbitElement[] {
  if (!Array.isArray(json)) throw new Error("軌道データの形が正しくありません");
  const out: OrbitElement[] = [];
  const seen = new Set<string>();
  for (const x of json) {
    if (out.length >= max) break;
    const el = parseOmm(x);
    if (!el || seen.has(el.id)) continue;
    seen.add(el.id);
    out.push(el);
  }
  return out;
}

/** 計算の準備（SGP4 の初期化に失敗したものは null） */
export function makeSatrec(el: OrbitElement): SatRec | null {
  try {
    const rec = json2satrec(el.omm);
    return rec && rec.error === 0 ? rec : null;
  } catch {
    return null;
  }
}

export interface SatPosition {
  lat: number;
  lon: number;
  /** 高度（km。地球の楕円体からの高さ） */
  heightKm: number;
  /** 計算に使った時刻（ミリ秒） */
  at: number;
}

/** その時刻の推定位置（計算できない・地表より下などのおかしな結果は null） */
export function satPosition(rec: SatRec, at: number): SatPosition | null {
  const date = new Date(at);
  let pv: ReturnType<typeof propagate>;
  try {
    pv = propagate(rec, date);
  } catch {
    return null;
  }
  const p = pv?.position;
  if (!p || typeof p !== "object" || ![p.x, p.y, p.z].every(Number.isFinite)) return null;
  const geo = eciToGeodetic(p, gstime(date));
  const lat = degreesLat(geo.latitude);
  const lon = degreesLong(geo.longitude);
  if (![lat, lon, geo.height].every(Number.isFinite) || geo.height < 80 || geo.height > 500_000) return null;
  return { lat, lon, heightKm: geo.height, at };
}

/** 軌道要素の新しさ：fresh（3 日以内）・aging（7 日以内）・stale（それより古い。推定位置の誤差が大きい） */
export type OrbitFreshness = "fresh" | "aging" | "stale";
export function orbitFreshness(epochIso: string, now: number): OrbitFreshness {
  const age = now - Date.parse(epochIso);
  if (!Number.isFinite(age)) return "stale";
  const day = 86_400_000;
  return age <= 3 * day ? "fresh" : age <= 7 * day ? "aging" : "stale";
}
export const FRESHNESS_LABEL: Record<OrbitFreshness, string> = {
  fresh: "新しい（3 日以内）",
  aging: "やや古い（7 日以内）",
  stale: "古い（誤差が大きい可能性）",
};

const FAIL_REASONS: readonly SatFailReason[] = ["rate-limited", "temporary", "long-stop", "halted"];

function parseSatellitesOk(r: Record<string, unknown>): SatellitesOk | null {
  if (r.ok !== true || !isSatGroup(r.group) || typeof r.fetchedAt !== "string" || !Number.isFinite(Date.parse(r.fetchedAt)) || !Array.isArray(r.elements)) return null;
  const elements = (r.elements as { omm?: unknown }[]).map((e) => parseOmm(e?.omm)).filter((e): e is OrbitElement => e !== null);
  return { ok: true, source: "CelesTrak", group: r.group, fetchedAt: r.fetchedAt, elements };
}

/** 画面で受け取った応答を確かめる（追加の項目が無い古い形の応答も読める） */
export function parseSatellitesResponse(raw: unknown): SatellitesResponse | null {
  const r = raw as Record<string, unknown> | null;
  if (!r || typeof r !== "object") return null;
  if (r.ok === false) {
    const out: SatellitesFail = { ok: false, error: typeof r.error === "string" ? r.error.slice(0, 200) : "取得に失敗しました" };
    if (FAIL_REASONS.includes(r.reason as SatFailReason)) out.reason = r.reason as SatFailReason;
    if (r.scope === "all" || r.scope === "group") out.scope = r.scope;
    if (r.retryAt === null) out.retryAt = null;
    else if (typeof r.retryAt === "string" && Number.isFinite(Date.parse(r.retryAt))) out.retryAt = r.retryAt;
    const last = r.last && typeof r.last === "object" ? parseSatellitesOk(r.last as Record<string, unknown>) : null;
    if (last) out.last = last;
    return out;
  }
  return parseSatellitesOk(r);
}

/* ---------- 端末側の停止の記録（補助。サーバーの判断を飛ばすものではない） ---------- */

export const SAT_HOLD_KEY = "friday.edith-earth-sat-hold.v1";

/**
 * サーバーが「しばらく取りに来ないで」と答えたことを、この端末にも覚えておく（ページを開き直しても、その間はサーバーに尋ねない）。
 * 期限が過ぎたら、ふだんどおりサーバーに尋ねるだけ（強制の取り直しはしない。取りに行くかはサーバーが決める）
 */
export interface SatHold {
  /** この時刻までは、この端末からサーバーに尋ねない */
  until: number;
  /** all は全グループ、group は group のグループだけ */
  scope: SatFailScope;
  group: SatGroup | null;
  reason: SatFailReason | null;
  /** サーバーが次に自動で確認する時刻（ISO）。null は自動では取りに行かない */
  retryAt: string | null;
  error: string;
  savedAt: number;
}

/** 失敗の応答から、端末側の停止の記録を作る（理由が付いていない古い形の応答では作らない） */
export function satHoldFromFail(f: SatellitesFail, group: SatGroup, now: number, retryAfterMs?: number): SatHold | null {
  if (!f.reason) return null;
  const retryAt = f.retryAt ?? null;
  const at = retryAt ? Date.parse(retryAt) : NaN;
  // 自動で再開しない状態は、6 時間ごとにサーバーへ状態を確かめるだけ。再開時刻があれば、その時刻（とサーバーの待ち時間指定の遅いほう）まで
  const until = Math.max(Number.isFinite(at) ? at : now + SAT_HALT_RECHECK_MS, now + (retryAfterMs ?? 0));
  if (!(until > now)) return null;
  return { until, scope: f.scope ?? "all", group: f.scope === "group" ? group : null, reason: f.reason, retryAt, error: f.error.slice(0, 200), savedAt: now };
}

export function parseSatHold(raw: unknown): SatHold | null {
  const h = raw as Partial<SatHold> | null;
  if (!h || typeof h !== "object") return null;
  if (typeof h.until !== "number" || !Number.isFinite(h.until) || typeof h.savedAt !== "number" || !Number.isFinite(h.savedAt)) return null;
  if (h.scope !== "all" && h.scope !== "group") return null;
  const group = isSatGroup(h.group) ? h.group : null;
  if (h.scope === "group" && !group) return null;
  return {
    until: h.until,
    scope: h.scope,
    group,
    reason: FAIL_REASONS.includes(h.reason as SatFailReason) ? (h.reason as SatFailReason) : null,
    retryAt: typeof h.retryAt === "string" && Number.isFinite(Date.parse(h.retryAt)) ? h.retryAt : null,
    error: typeof h.error === "string" ? h.error.slice(0, 200) : "取得に失敗しました",
    savedAt: h.savedAt,
  };
}

/** この端末からの問い合わせを、いま控えるか（期限切れ・別のグループの記録なら控えない） */
export function satHoldActive(h: SatHold | null, group: SatGroup, now: number): boolean {
  if (!h || now >= h.until) return false;
  return h.scope === "all" || h.group === group;
}

/** 停止の範囲・再開の見込みを、画面に出す短い文にする */
export function satFailNote(f: { reason?: SatFailReason | null; scope?: SatFailScope; retryAt?: string | null }): string | null {
  if (!f.reason) return null;
  const scope = f.scope === "group" ? "このグループの取得" : "CelesTrak からの取得（全グループ）";
  if (f.reason === "halted" || f.retryAt === null) return `${scope}を止めています。原因を確かめるまで自動では取りに行きません（サーバーが再起動すると、止めた状態が消えることがあります）`;
  return `${scope}を待っています。次に自動で確認するのは ${f.retryAt ? f.retryAt.replace("T", " ").replace(/\.\d+Z$|Z$/, " UTC") : "—"} 以降`;
}
