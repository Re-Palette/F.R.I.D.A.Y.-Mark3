/**
 * E.D.I.T.H. の情報収集の状態（.friday/intel/state.json）と排他制御。
 *
 * 二重実行・同時書き込みの防ぎ方：
 *   1. 実行の最初に「実行中の印（lock）」を状態ファイルに書く。GitHub の sha 比較で、
 *      同時に書こうとした側は拒否され、最新を読み直す → 印があれば取らずに終わる。
 *   2. 印を持っている実行だけが状態・情報ファイルを書く。最後に印を外す（自分の印のときだけ）。
 *   3. 途中で止まっても、印の期限（until）を過ぎれば次の実行が取り直せる。
 */
import { randomUUID } from "node:crypto";
import { type IntelBrainIO, INTEL_STATE_PATH } from "./brain-io";
import { isUnsupportedTracking, normalizeTracking } from "./normalize";
import { sourceDef } from "./sources";
import type { IntelSourceId, IntelSourceStatus, IntelState, UnsupportedTrackingHold } from "./types";

/** 印の期限（実行は 60 秒で打ち切られるので、余裕を見て 3 分） */
export const LOCK_TTL_MS = 3 * 60_000;
/** 失敗が続いたときの待ちの上限 */
const MAX_BACKOFF_MS = 6 * 60 * 60_000;
/**
 * 知らない版の追跡の記録を、そのまま書き戻す大きさの上限（バイト。UTF-8）。
 * 測るのは state.json の中に書かれる形そのもの（字下げ 1・tracking の項目名を含む。unsupportedTrackingBytes）。
 * state.json 全体の大きさの上限ではない（ほかの項目の分は別）。超える記録は保てないので、state.json を書かない。
 */
export const MAX_UNSUPPORTED_TRACKING_BYTES = 256_000;
/** 知らない版の追跡の記録の入れ子の深さの上限（tracking のオブジェクト自体を 1 段目とする） */
export const MAX_UNSUPPORTED_TRACKING_DEPTH = 32;

/** 知らない版の追跡の記録を保てないため、state.json を書かないときの例外（ファイルは書き換えない） */
export class TrackingHoldError extends Error {
  constructor(reason: string) {
    super(`知らない版の追跡の記録を正しく書き戻せない（${reason}）ため、state.json を書きません`);
    this.name = "TrackingHoldError";
  }
}

/**
 * JSON として、読んだときのまま書き戻せる値か（入れ子の深さも確かめる）。再帰を使わずに調べる。
 *   null・真偽・文字・有限の数・配列・ふつうのオブジェクトだけ。Infinity（JSON では null になる）・BigInt・関数などは不可。
 *   深さは、入れ物（配列・オブジェクト）ごとに 1 段。値そのもの（文字・数など）は段に数えない。
 */
export function inspectJsonValue(v: unknown, maxDepth: number): "ok" | "too-deep" | "not-serializable" {
  const stack: [unknown, number][] = [[v, 1]];
  while (stack.length) {
    const [x, depth] = stack.pop()!;
    if (x === null || typeof x === "string" || typeof x === "boolean") continue;
    if (typeof x === "number") {
      if (!Number.isFinite(x)) return "not-serializable";
      continue;
    }
    if (typeof x !== "object") return "not-serializable";
    if (depth > maxDepth) return "too-deep";
    if (Array.isArray(x)) {
      for (let i = 0; i < x.length; i++) {
        if (!(i in x)) return "not-serializable"; // 穴のある配列（JSON では null になる）
        stack.push([x[i], depth + 1]);
      }
      continue;
    }
    const proto = Object.getPrototypeOf(x);
    if ((proto !== Object.prototype && proto !== null) || typeof (x as { toJSON?: unknown }).toJSON === "function") return "not-serializable";
    for (const k of Object.keys(x)) stack.push([(x as Record<string, unknown>)[k], depth + 1]);
  }
  return "ok";
}

/** state.json の中に書かれる形での、追跡の記録の大きさ（バイト。字下げ 1・項目名 "tracking" を含む） */
export function unsupportedTrackingBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify({ tracking: value }, null, 1), "utf8");
}

/**
 * 知らない版の追跡の記録の預かり方を決める（state.json から読んだ値）。
 * 先に深さと値の種類を調べ（再帰なし）、通ったものだけ実際の保存の形で大きさを測る。どこかでつまずいたら保てない扱い。
 */
export function holdUnsupportedTracking(value: unknown): UnsupportedTrackingHold {
  const version = Number((value as { version?: unknown } | null)?.version);
  try {
    const shape = inspectJsonValue(value, MAX_UNSUPPORTED_TRACKING_DEPTH);
    if (shape !== "ok") return { status: "rejected", version, reason: shape };
    if (unsupportedTrackingBytes(value) > MAX_UNSUPPORTED_TRACKING_BYTES) return { status: "rejected", version, reason: "too-large" };
    return { status: "kept", version, value };
  } catch {
    return { status: "rejected", version, reason: "not-serializable" };
  }
}

/**
 * 追跡の記録（今の版）を判定・更新して書いてよいか。知らない版の記録を預かっている間は false
 * （判定しても書き戻さない。知らない版を消さないため。追跡の判定の処理は、これが false なら何もしない）。
 */
export function trackingWritable(s: IntelState): boolean {
  return s.unsupportedTracking === undefined;
}
/** 送った通知の記録を覚えておく時間 */
const NOTIFIED_KEEP_MS = 3 * 24 * 60 * 60_000;

export function emptyState(): IntelState {
  return { version: 1, lock: null, sources: {}, notified: {}, daily: { date: "", normal: 0, urgent: 0 }, lastRunAt: null };
}

/** 読み込んだ JSON を安全な形に直す（壊れていても止まらない） */
export function parseState(raw: string | null): IntelState {
  if (!raw) return emptyState();
  try {
    const j = JSON.parse(raw) as Partial<IntelState>;
    const base = emptyState();
    return {
      version: 1,
      lock: j.lock && typeof j.lock.owner === "string" && typeof j.lock.until === "string" ? { owner: j.lock.owner, until: j.lock.until } : null,
      sources: j.sources && typeof j.sources === "object" ? j.sources : {},
      notified: j.notified && typeof j.notified === "object" ? j.notified : {},
      daily: j.daily && typeof j.daily.date === "string" ? { date: j.daily.date, normal: Number(j.daily.normal) || 0, urgent: Number(j.daily.urgent) || 0 } : base.daily,
      lastRunAt: typeof j.lastRunAt === "string" ? j.lastRunAt : null,
      // 追跡の記録（Phase 3）。無い・形が違うときは持たない（ほかの項目はそのまま読む。
      // 追跡の記録の読み込みでつまずいても、印・情報源の状態・通知の記録まで消さない）
      ...(() => {
        try {
          // 知らない版（新しい版）の記録は、読まずに預かる（壊れた記録とは区別する。保てないときも空にはしない）
          if (isUnsupportedTracking(j.tracking)) return { unsupportedTracking: holdUnsupportedTracking(j.tracking) };
          const tracking = normalizeTracking(j.tracking);
          return tracking ? { tracking } : {};
        } catch {
          return {};
        }
      })(),
    };
  } catch {
    return emptyState();
  }
}

/**
 * state.json に書く文字列。
 * 知らない版の追跡の記録を預かっているときは、必ずそれを tracking に書き戻す（今の版の tracking があっても書かない）。
 * 預かれなかったとき（rejected）は、書き戻すと中身が変わる・壊れるので、書かずに例外にする（ファイルはそのまま残る）。
 */
export function serializeState(s: IntelState): string {
  const { unsupportedTracking: hold, ...rest } = s;
  if (hold?.status === "rejected") throw new TrackingHoldError(hold.reason);
  const out = hold?.status === "kept" ? { ...rest, tracking: hold.value } : rest;
  return JSON.stringify(out, null, 1);
}

export function lockHeld(s: IntelState, now = Date.now()): boolean {
  return Boolean(s.lock && Date.parse(s.lock.until) > now);
}

export interface IntelRun {
  owner: string;
  /** 印を取ったときの状態（以後の書き込みはこれを元にする） */
  state: IntelState;
}

/**
 * 実行中の印を取る。ほかの実行が動いていれば null（何もせずに終わる）。
 * 書き込みは GitHub の sha 比較で守られるので、同時に 2 つが取ることはない。
 */
export async function acquireRun(io: IntelBrainIO, now = Date.now(), owner: string = randomUUID()): Promise<IntelRun | null> {
  let taken: IntelState | null = null;
  try {
    await io.update(
      INTEL_STATE_PATH,
      (current) => {
        const s = parseState(current);
        if (lockHeld(s, now) && s.lock?.owner !== owner) {
          taken = null;
          return current ?? serializeState(s);
        }
        taken = { ...s, lock: { owner, until: new Date(now + LOCK_TTL_MS).toISOString() } };
        return serializeState(taken);
      },
      "E.D.I.T.H.: 情報収集を開始",
    );
  } catch {
    return null; // ぶつかり続けた・書けない → 今回は動かない
  }
  return taken ? { owner, state: taken } : null;
}

/**
 * 実行の結果を書いて印を外す。change は最新の状態を受け取って直す。
 * 自分の印が無くなっていたら（期限切れで別の実行が取った）、何も書かない。
 */
export async function finishRun(io: IntelBrainIO, run: IntelRun, change: (s: IntelState) => IntelState, now = Date.now()): Promise<boolean> {
  let wrote = false;
  await io.update(
    INTEL_STATE_PATH,
    (current) => {
      const s = parseState(current);
      if (s.lock?.owner !== run.owner) {
        wrote = false;
        return current ?? serializeState(s);
      }
      const next = pruneNotified(change(s), now);
      wrote = true;
      return serializeState({ ...next, lock: null, lastRunAt: new Date(now).toISOString() });
    },
    "E.D.I.T.H.: 情報収集の記録",
  );
  return wrote;
}

/** いまも自分が印を持っているか（ほかのファイルを書く前に確かめる） */
export async function stillOwner(io: IntelBrainIO, run: IntelRun, now = Date.now()): Promise<boolean> {
  const s = parseState(await io.read(INTEL_STATE_PATH));
  return s.lock?.owner === run.owner && lockHeld(s, now);
}

function emptyStatus(): IntelSourceStatus {
  return { lastRunAt: null, lastSuccessAt: null, lastError: null, failures: 0, nextAllowedAt: null, lastCount: 0 };
}

export function sourceStatus(s: IntelState, id: IntelSourceId): IntelSourceStatus {
  return { ...emptyStatus(), ...s.sources[id] };
}

/** その情報源を、いま取りに行ってよいか（間隔・待ちの時刻を守る） */
export function isDue(s: IntelState, id: IntelSourceId, now = Date.now()): boolean {
  const st = sourceStatus(s, id);
  return !st.nextAllowedAt || Date.parse(st.nextAllowedAt) <= now;
}

/** 取れたとき */
export function recordSuccess(s: IntelState, id: IntelSourceId, count: number, now = Date.now()): IntelState {
  const def = sourceDef(id);
  const at = new Date(now).toISOString();
  const st: IntelSourceStatus = {
    ...sourceStatus(s, id),
    lastRunAt: at,
    lastSuccessAt: at,
    lastError: null,
    failures: 0,
    lastCount: count,
    nextAllowedAt: new Date(now + (def?.minIntervalMs ?? 60 * 60_000)).toISOString(),
  };
  return { ...s, sources: { ...s.sources, [id]: st } };
}

export interface FailureInfo {
  message: string;
  /** HTTP の状態（429・403 などは待ちを長くする） */
  status?: number;
  /** 相手が指定した待ち時間（Retry-After、ミリ秒） */
  retryAfterMs?: number;
}

/** 失敗したとき（続けて失敗するほど、次まで長く待つ。制限・拒否は特に長く） */
export function recordFailure(s: IntelState, id: IntelSourceId, f: FailureInfo, now = Date.now()): IntelState {
  const def = sourceDef(id);
  const prev = sourceStatus(s, id);
  const failures = prev.failures + 1;
  const base = def?.minIntervalMs ?? 60 * 60_000;
  let wait = Math.min(MAX_BACKOFF_MS, base * 2 ** Math.min(failures - 1, 6));
  if (f.status === 429 || f.status === 403) wait = Math.max(wait, 60 * 60_000);
  if (f.retryAfterMs && f.retryAfterMs > 0) wait = Math.max(wait, Math.min(f.retryAfterMs, 24 * 60 * 60_000));
  const st: IntelSourceStatus = {
    ...prev,
    lastRunAt: new Date(now).toISOString(),
    lastError: `${f.status ? `${f.status} ` : ""}${f.message}`.slice(0, 200),
    failures,
    nextAllowedAt: new Date(now + wait).toISOString(),
  };
  return { ...s, sources: { ...s.sources, [id]: st } };
}

/** 情報源のデータが古いか（最後に取れてから時間がたちすぎ。一度も取れていなければ「古い」ではない） */
export function isStale(s: IntelState, id: IntelSourceId, now = Date.now()): boolean {
  const st = sourceStatus(s, id);
  const def = sourceDef(id);
  if (!st.lastSuccessAt || !def) return false;
  return now - Date.parse(st.lastSuccessAt) > def.maxAgeMs;
}

/** 古い「送った通知」の記録を捨てる */
export function pruneNotified(s: IntelState, now = Date.now()): IntelState {
  const notified: Record<string, string> = {};
  for (const [k, at] of Object.entries(s.notified)) if (now - Date.parse(at) < NOTIFIED_KEEP_MS) notified[k] = at;
  return { ...s, notified };
}
