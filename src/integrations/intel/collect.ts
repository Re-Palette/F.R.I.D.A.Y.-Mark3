/**
 * E.D.I.T.H. の情報収集の 1 回分（定期実行 /api/cron/intel から呼ぶ）。
 *
 *   0. EDITH_INTEL=on でなければ何もしない（脳にも外にも触れない）
 *   1. 設定ノートを読む（無ければ既定値で作る。あるノートは上書きしない）。「全体」が OFF なら終わる
 *   2. 印を取る前に、状態を読むだけで確かめる（書かない）。ほかの実行の有効な印があれば busy、
 *      時刻が来た情報源が無ければ done で終わる（何もしない回は、脳に書き込まない）。読めない・締切なら、そのとおりに返す
 *      そうでなければ実行中の印を取る（ほかの実行が先に取っていれば busy。書けない・障害は error。busy と区別する）
 *   3. 時刻が来た情報源だけ取りに行く（1 つ失敗しても、ほかは続ける。全体の持ち時間を超えたら次回へ）
 *   4. 保存の前に、まだ自分が印を持っているか確かめる（失っていたら何も書かない）
 *   5. 集めた情報を保存し、フィードの観測の記録を保存し（Phase 3-2）、情報源ごとの結果（成功・失敗・次の時刻）を状態に書いて印を外す
 *      観測の記録は取得中は手元にためるだけ（ctx.observe）。保存に失敗・時間切れでも、収集の結果は変えない
 *
 * 時間（呼び出しから。Vercel の打ち切り 60 秒の前に、状態の記録を済ませるため）：
 *   20 秒 … 新しい情報源の取得を始める締切。さらに「経過時間＋その情報源の取得の最長 ≤ 40 秒」のときだけ始める（40 秒までに終わる）
 *   40 秒 … finishRun を始める締切。設定ノート・印・所有権の確認・情報の保存・観測の記録の保存は、ここで止める（signal）
 *   55 秒 … 全体を止める締切。finishRun（再試行を含む）もここで止める
 * 集めた情報を保存できなかった（止めた・結果が分からない）情報源は、成功と記録しない（recordDeferred）。失敗は記録する。
 *
 * ここでは情報を集めて保存するだけ。メール・予定・ファイル操作などの機能は読み込まない・呼ばない。
 * 取った文章はデータとして保存するだけで、命令として扱わない。
 */
import { abortInfo, githubBrainIO, INTEL_STATE_PATH, type IntelBrainIO } from "./brain-io";
import { SourceError, type FetchLike } from "./http";
import { activeSources, ensureSettingsNote, intelAllowedByEnv, readIntelSettings, type IntelSettings } from "./settings";
import { readItems, saveItems } from "./store";
import { confirmOwner, finishRun, isDue, isStale, lockHeld, parseState, recordDeferred, recordFailure, recordSuccess, sourceStatus, stillOwner, tryAcquireRun, type IntelRun } from "./state";
import { uniqueById, type SourceFetcher } from "./sources/common";
import { fetchUsgs } from "./sources/usgs";
import { fetchNhc } from "./sources/nhc";
import { fetchJmaQuake, fetchJmaTyphoon } from "./sources/jma";
import { recordObservation, type ObservationStoreErrorCode } from "./observation-store";
import type { FeedObservation, IntelItem, IntelSourceId, IntelState } from "./types";

export const FETCHERS: Partial<Record<IntelSourceId, SourceFetcher>> = {
  usgs: fetchUsgs,
  nhc: fetchNhc,
  jma: fetchJmaQuake,
  jmatyphoon: fetchJmaTyphoon,
};

/** 1 回の実行の持ち時間（Vercel の 60 秒の打ち切りより十分前に終える） */
const RUN_BUDGET_MS = 35_000;
/**
 * 実行の打ち切り（Vercel の maxDuration）。route.ts の `export const maxDuration = 60` は、Next.js の決まりで
 * その場に書いた値でなければならない（ほかから読み込めない）ため、ここと 2 か所に書く。同じ値かはテストで確かめる。
 */
export const PLATFORM_LIMIT_MS = 60_000;
/** 外部への 1 回の取得の打ち切り（http.ts の getText の既定 10 秒。情報源は上書きしていない。同じ値かはテストで確かめる） */
export const SOURCE_REQUEST_TIMEOUT_MS = 10_000;
/**
 * 情報源ごとの、順番に行う外部への取得の回数（同時に行う取得は 1 回と数える）。取得の最長 ＝ 回数 × 1 回の打ち切り。
 *   usgs       … まとめフィード（getJson）＝ 1 回
 *   nhc        … まとめフィード（getJson）＝ 1 回
 *   jma        … 高頻度フィード → （取りこぼしの補い）長期フィード → 電文（同時）＝ 3 回
 *   jmatyphoon … 長期フィード → 電文（同時）＝ 2 回
 */
const SOURCE_SEQUENTIAL_REQUESTS: Partial<Record<IntelSourceId, number>> = { usgs: 1, nhc: 1, jma: 3, jmatyphoon: 2 };
/** 情報源ごとの取得の最長（ミリ秒）。usgs・nhc 10 秒、jma 30 秒、jmatyphoon 20 秒 */
export const SOURCE_MAX_MS_BY_ID: Partial<Record<IntelSourceId, number>> = Object.fromEntries(
  Object.entries(SOURCE_SEQUENTIAL_REQUESTS).map(([id, n]) => [id, n! * SOURCE_REQUEST_TIMEOUT_MS]),
);
/** 取得の最長の最大値（決まっていない情報源にも使う） */
export const SOURCE_MAX_MS = Math.max(...Object.values(SOURCE_MAX_MS_BY_ID).map((v) => v!));

/**
 * この情報源の取得を、いま始めてよいか。
 * 新しい取得の締切（20 秒）の前で、かつ「経過時間＋その情報源の取得の最長」が finishRun の開始締切（40 秒）以内のときだけ。
 */
export function canStartSource(elapsedMs: number, id: IntelSourceId, dl: RunDeadlines, maxById: Partial<Record<IntelSourceId, number>> = SOURCE_MAX_MS_BY_ID): boolean {
  const max = maxById[id] ?? SOURCE_MAX_MS;
  return elapsedMs < dl.sourceStartMs && elapsedMs + max <= dl.finishStartMs;
}
/** GitHub への 1 回の呼び出しの打ち切り（github-brain.ts の gh と同じ 8 秒） */
const GITHUB_CALL_MS = 8_000;

/** 実行の締切（すべて呼び出しから・ミリ秒） */
export interface RunDeadlines {
  /** 新しい情報源の取得を始める締切 */
  sourceStartMs: number;
  /** finishRun を始める締切（それより前の GitHub の読み書きはここで止める） */
  finishStartMs: number;
  /** 全体を止める締切（finishRun の再試行を含む） */
  runEndMs: number;
}
export const DEFAULT_RUN_DEADLINES: RunDeadlines = { sourceStartMs: 20_000, finishStartMs: 40_000, runEndMs: 55_000 };

export function runDeadlines(o: Partial<RunDeadlines> = {}): RunDeadlines {
  return {
    sourceStartMs: o.sourceStartMs ?? DEFAULT_RUN_DEADLINES.sourceStartMs,
    finishStartMs: o.finishStartMs ?? DEFAULT_RUN_DEADLINES.finishStartMs,
    runEndMs: o.runEndMs ?? DEFAULT_RUN_DEADLINES.runEndMs,
  };
}

/** 観測の記録の保存を始めてよい締切の上限（実行の呼び出しから） */
const OBSERVATION_DEADLINE_MS = 45_000;
/** 観測の記録 1 件の保存を待つ上限。過ぎたら止める（signal） */
const OBSERVATION_SAVE_WAIT_MS = 8_000;
/** 止めた後、保存の処理が終わるのを待つ上限（GitHub の口は止めればすぐ終わる。止まらない口のための保険） */
const OBSERVATION_ABORT_GRACE_MS = 1_000;

/**
 * 観測の記録の保存を始めてよい締切（実行の呼び出しから・ミリ秒）。
 * 上限（既定 45 秒）と、「finishRun の開始締切 − 待つ分 − 止めた後に待つ分」の短いほう（既定では 40 − 8 − 1 = 31 秒）。
 * 始めた保存は、finishRun の開始締切までに終わる（止める）。
 */
export function observationSaveDeadline(o: { capMs?: number; finishStartMs?: number; waitMs?: number; graceMs?: number } = {}): number {
  const cap = o.capMs ?? OBSERVATION_DEADLINE_MS;
  const room = (o.finishStartMs ?? DEFAULT_RUN_DEADLINES.finishStartMs) - (o.waitMs ?? OBSERVATION_SAVE_WAIT_MS) - (o.graceMs ?? OBSERVATION_ABORT_GRACE_MS);
  return Math.max(0, Math.min(cap, room));
}

/** 時計を進める仕組み（テストで偽の時計に差し替える）。戻り値で取り消す */
export type SetTimer = (ms: number, fn: () => void) => () => void;
const realTimer: SetTimer = (ms, fn) => {
  const h = setTimeout(fn, ms); // 実行の終わり（finally）で必ず取り消す
  return () => clearTimeout(h);
};

/** 呼び出しから数える締切（1 つの時計）。signal(t) は、呼び出しから t ミリ秒で止まる signal */
function deadlineClock(now: () => number, invokedAt: number, setTimer: SetTimer) {
  const cancels: (() => void)[] = [];
  return {
    passed: (t: number) => now() - invokedAt >= t,
    remaining: (t: number) => invokedAt + t - now(),
    signal(t: number): AbortSignal {
      const c = new AbortController();
      const left = invokedAt + t - now();
      if (left <= 0) c.abort();
      else cancels.push(setTimer(left, () => c.abort()));
      return c.signal;
    },
    dispose() {
      for (const cancel of cancels.splice(0)) cancel();
    },
  };
}
/** 1 回の実行でためておく観測の記録の上限 */
const MAX_PENDING_OBSERVATIONS = 12;

/**
 * 観測の記録を保存しなかった・できなかった理由（保存の仕組みのエラーの種類か、ここでの理由）。
 *   aborted              … 待つ上限で止めた。書き込みを送った後だったので、反映されたかは分からない（unknown）
 *   aborted-before-write … 待つ上限で止めた。書き込みを送る前だった（書いていない。skipped）
 *   write-unknown        … 書き込みを送った後に通信が切れた・GitHub の 5xx（反映されたかは分からない。unknown）
 *   save-not-settled     … 止めても保存の処理が終わらなかった（unknown）。その処理は裏で続くことがあり、後から書き込むかもしれない。
 *                          残りの観測の記録は保存を始めない（skipped）
 */
export type IntelObservationRunCode = ObservationStoreErrorCode | "time-budget-exceeded" | "save-not-settled" | "unexpected-error";

/** 観測の記録の保存の結果（件数と理由の種類だけ。メッセージ・中身は入れない） */
export interface IntelObservationRunResult {
  saved: number;
  /** 保存を始めなかった（締切を過ぎた・書き込みを送る前に止めた・前の保存が終わらなかったので後回しにした） */
  skipped: number;
  /**
   * 保存できなかったと判断した（ファイルが壊れている・知らない版・順番が違う・GitHub が 4xx で拒否した など）。
   * 「確実に保存されていない」とは限らない（GitHub の口が見分けられない失敗もここに入る）。次の回は読み直してから書くので安全
   */
  failed: number;
  /**
   * 保存されたか分からない（書き込みを送った後に止めた・通信が切れた・5xx、止めても処理が終わらなかった）。
   * GitHub 側で受け付けた書き込みは取り消せない。次の回は読み直してから書くので安全
   */
  unknown: number;
  codes: IntelObservationRunCode[];
}

/**
 * 1 回の実行の結果。
 *   timeout      … 締切に間に合わなかった（印を取る前に止めた、または情報を保存できず finishRun で失敗だけ記録した、
 *                  または finishRun 自体が締切で止まった）。印は外したか、期限で自然に外れる
 *   lock-unknown … 印の書き込みの結果が分からず、自分の印だと確かめられなかった（何もしていない。印が書かれていれば期限で外れる）
 */
export type IntelRunStatus = "disabled" | "not-configured" | "off" | "busy" | "lost-lock" | "timeout" | "lock-unknown" | "done" | "error";

export interface IntelRunResult {
  status: IntelRunStatus;
  sources: Partial<Record<IntelSourceId, { ok: boolean; count?: number; error?: string; skipped?: string }>>;
  saved: number;
  stale: IntelSourceId[];
  error?: string;
  /** 観測の記録の保存の結果（観測の記録があった回だけ。Phase 3-2） */
  observations?: IntelObservationRunResult;
  /** 取得はできたが情報を保存できなかったので、成功と記録しなかった情報源（次の回に取り直す） */
  deferred?: IntelSourceId[];
}

export interface RunOptions {
  io?: IntelBrainIO;
  now?: () => number;
  fetchImpl?: FetchLike;
  env?: Record<string, string | undefined>;
  fetchers?: Partial<Record<IntelSourceId, SourceFetcher>>;
  budgetMs?: number;
  /** 観測の記録の保存を始めてよい締切の上限（実行の呼び出しから・ミリ秒。実際は observationSaveDeadline で短くなる） */
  observationDeadlineMs?: number;
  /** 観測の記録 1 件の保存を待つ上限（ミリ秒。過ぎたら止める） */
  observationSaveWaitMs?: number;
  /** 止めた後、保存の処理が終わるのを待つ上限（ミリ秒） */
  observationAbortGraceMs?: number;
  /** 締切（呼び出しから・ミリ秒。既定 20 / 40 / 55 秒） */
  sourceStartDeadlineMs?: number;
  finishStartDeadlineMs?: number;
  runEndDeadlineMs?: number;
  /** 時計を進める仕組み（テスト用。既定は setTimeout） */
  setTimer?: SetTimer;
  /** 情報源ごとの取得の最長（ミリ秒。既定は SOURCE_MAX_MS_BY_ID） */
  sourceMaxMs?: Partial<Record<IntelSourceId, number>>;
}

type Outcome = { id: IntelSourceId; ok: true; count: number; at: number } | { id: IntelSourceId; ok: false; error: SourceError | Error; at: number };

/**
 * 情報源ごとの結果を状態に反映する。itemsCommitted が false（集めた情報を保存できなかった）なら、
 * 項目があった成功は成功と記録しない（recordDeferred）。項目 0 件の成功・失敗（429・Retry-After を含む）は、これまでどおり記録する。
 */
function applyOutcomes(s: IntelState, outcomes: Outcome[], itemsCommitted = true): IntelState {
  let next = s;
  for (const o of outcomes) {
    next = o.ok
      ? itemsCommitted || o.count === 0
        ? recordSuccess(next, o.id, o.count, o.at)
        : recordDeferred(next, o.id, o.at)
      : recordFailure(
          next,
          o.id,
          { message: o.error.message, status: o.error instanceof SourceError ? o.error.status : undefined, retryAfterMs: o.error instanceof SourceError ? o.error.retryAfterMs : undefined },
          o.at,
        );
  }
  return next;
}

/** 成功と記録しない（先送りする）情報源 */
const deferredOf = (outcomes: Outcome[], itemsCommitted: boolean): IntelSourceId[] =>
  itemsCommitted ? [] : outcomes.filter((o) => o.ok && o.count > 0).map((o) => o.id);

/**
 * ためておいた観測の記録を保存する（印を持っていると確かめ、集めた情報を保存した後、finishRun の前に呼ぶ）。
 * 例外は出さない。締切を過ぎていれば保存せずに飛ばす。1 件の保存は待つ上限で止め（signal）、処理が終わるのを待ってから次へ進む
 * （止めた後に新しい書き込みを始めないので、finishRun で印を外した後に、観測の記録の書き込みを始めることはない）。
 */
async function saveObservations(
  io: IntelBrainIO,
  pending: FeedObservation[],
  elapsed: () => number,
  deadlineMs: number,
  waitMs: number,
  graceMs: number,
  setTimer: SetTimer = realTimer,
): Promise<IntelObservationRunResult> {
  const r: IntelObservationRunResult = { saved: 0, skipped: 0, failed: 0, unknown: 0, codes: [] };
  const note = (code: IntelObservationRunCode) => {
    if (!r.codes.includes(code) && r.codes.length < 10) r.codes.push(code);
  };
  for (let i = 0; i < pending.length; i++) {
    const o = pending[i];
    if (elapsed() > deadlineMs) {
      r.skipped++;
      note("time-budget-exceeded");
      continue;
    }
    const stop = new AbortController();
    const timers: (() => void)[] = [];
    try {
      timers.push(setTimer(waitMs, () => stop.abort()));
      // 止めた後も終わらない口のための保険（止めてから graceMs 待っても終わらなければ、待つのをやめる）
      const notSettled = new Promise<"not-settled">((resolve) => {
        stop.signal.addEventListener("abort", () => timers.push(setTimer(graceMs, () => resolve("not-settled"))), { once: true });
      });
      const res = await Promise.race([recordObservation(io, o, { signal: stop.signal }), notSettled]);
      if (res === "not-settled") {
        // 止めても終わらない口：その処理は裏で続くことがある（後から書き込むかもしれない）。残りは保存を始めない
        r.unknown++;
        note("save-not-settled");
        r.skipped += pending.length - i - 1;
        break;
      } else if (res.ok) r.saved++;
      else if (res.error.code === "aborted" || res.error.code === "write-unknown") {
        r.unknown++;
        note(res.error.code);
      } else if (res.error.code === "aborted-before-write") {
        r.skipped++;
        note("aborted-before-write");
      } else {
        r.failed++;
        note(res.error.code);
      }
    } catch {
      r.failed++;
      note("unexpected-error");
    } finally {
      for (const cancel of timers) cancel();
    }
  }
  return r;
}

export async function runIntel(opts: RunOptions = {}): Promise<IntelRunResult> {
  const io = opts.io ?? githubBrainIO;
  const now = opts.now ?? Date.now;
  // 呼び出された時刻（すべての締切をここから数える）
  const invokedAt = now();
  const env = opts.env ?? process.env;
  const fetchers = opts.fetchers ?? FETCHERS;
  const budget = opts.budgetMs ?? RUN_BUDGET_MS;
  const dl = runDeadlines({ sourceStartMs: opts.sourceStartDeadlineMs, finishStartMs: opts.finishStartDeadlineMs, runEndMs: opts.runEndDeadlineMs });
  const observationWait = opts.observationSaveWaitMs ?? OBSERVATION_SAVE_WAIT_MS;
  const observationGrace = opts.observationAbortGraceMs ?? OBSERVATION_ABORT_GRACE_MS;
  const observationDeadline = observationSaveDeadline({ capMs: opts.observationDeadlineMs, finishStartMs: dl.finishStartMs, waitMs: observationWait, graceMs: observationGrace });
  const setTimer = opts.setTimer ?? realTimer;
  const sourceMax = { ...SOURCE_MAX_MS_BY_ID, ...opts.sourceMaxMs };
  const result: IntelRunResult = { status: "done", sources: {}, saved: 0, stale: [] };

  if (!intelAllowedByEnv(env)) return { ...result, status: "disabled" };
  if (!io.configured()) return { ...result, status: "not-configured" };

  const clock = deadlineClock(now, invokedAt, setTimer);
  try {
    // 1. 設定ノート（印を取る前。finishRun の開始締切で止める。止まったら何も書いていない）
    let settings: IntelSettings;
    try {
      const pre = clock.signal(dl.finishStartMs);
      settings = await readIntelSettings(io, { signal: pre });
      if (!settings.fromBrain) await ensureSettingsNote(io, { signal: pre });
    } catch (err) {
      if (abortInfo(err) || clock.passed(dl.finishStartMs)) return { ...result, status: "timeout", error: "設定ノートを時間内に読み書きできませんでした" };
      throw err;
    }
    if (!settings.enabled) return { ...result, status: "off" };
    if (clock.passed(dl.finishStartMs)) return { ...result, status: "timeout", error: "印を取る前に締切を過ぎました" };

    // 2. 印を取る前に、状態を読むだけで確かめる（書かない。読めない・締切を「情報源なし」とは扱わない）
    let before: IntelState;
    try {
      before = parseState(await io.read(INTEL_STATE_PATH, { signal: clock.signal(dl.finishStartMs) }));
    } catch (err) {
      if (abortInfo(err) || clock.passed(dl.finishStartMs)) return { ...result, status: "timeout", error: "状態を時間内に読めませんでした（何も書いていません）" };
      throw err;
    }
    const checkedAt = now();
    // ほかの実行の有効な印がある：取りに行かず、何も書かない
    if (lockHeld(before, checkedAt)) return { ...result, status: "busy" };
    // 時刻が来た情報源が無い：印を取らず、何も書かずに終わる（印を取った後にも、最新の状態で決め直す）
    if (!activeSources(settings, env).some((id) => fetchers[id] && isDue(before, id, checkedAt))) {
      return { ...result, stale: activeSources(settings, env).filter((id) => isStale(before, id, checkedAt)) };
    }

    // 実行中の印（finishRun の開始締切で止める。書かれたか分からなければ、自分の印だと確かめられたときだけ続ける）
    const started = now();
    const acq = await tryAcquireRun(io, started, undefined, { signal: clock.signal(dl.finishStartMs) });
    let run: IntelRun;
    if (acq.status === "acquired") run = acq.run;
    else if (acq.status === "busy") return { ...result, status: "busy" };
    else if (acq.status === "failed") {
      if (acq.aborted || clock.passed(dl.finishStartMs)) return { ...result, status: "timeout", error: "印を時間内に取れませんでした（印は書いていません）" };
      // 書けない（権限・制限）・通信の失敗・ぶつかり続けた・状態を書き戻せない など。ほかの実行が動いている（busy）とは限らないので、失敗にする
      return { ...result, status: "error", error: "印を取れませんでした（脳に書けない・通信の失敗など。印は書いていません）" };
    } else {
      let confirmed: IntelRun | null = null;
      if (clock.remaining(dl.finishStartMs) >= GITHUB_CALL_MS) {
        confirmed = await confirmOwner(io, acq.owner, now(), { signal: clock.signal(dl.finishStartMs) }).catch(() => null);
      }
      if (!confirmed || clock.passed(dl.finishStartMs)) {
        // 自分の印だと確かめられない：続けない（重複実行をしない）。書かれていれば、印は期限（3 分）で外れる
        return { ...result, status: "lock-unknown", error: "印が書かれたか確かめられませんでした（書かれていれば期限で外れます）" };
      }
      run = confirmed;
    }

    const outcomes: Outcome[] = [];
    // 集めた情報を保存できたか（できなければ、項目があった成功は成功と記録しない）
    let itemsCommitted = false;
    // 締切のために保存を飛ばした・止めた
    let timedOut = false;
    try {
      const due = activeSources(settings, env).filter((id) => fetchers[id] && isDue(run.state, id, now()));
      // 3. 取得（20 秒までに、かつ「経過時間＋その情報源の取得の最長」が 40 秒以内のときだけ始める）
      let canFetch = due.length > 0 && !clock.passed(dl.sourceStartMs);
      let existing: IntelItem[] = [];
      if (canFetch) {
        try {
          existing = await readItems(io, { signal: clock.signal(dl.sourceStartMs) });
        } catch (err) {
          if (!abortInfo(err) && !clock.passed(dl.sourceStartMs)) throw err;
          canFetch = false; // 保存済みの情報を読めなかった：重複を見分けられないので、今回は取りに行かない
        }
      }
      const known = new Set(existing.map((i) => i.id));
      const knownReports = new Set(existing.map((i) => i.facts.report).filter((r): r is string => typeof r === "string"));
      const collected: IntelItem[] = [];
      // 観測の記録は、取得中は手元にためるだけ（保存は最後。時刻が来て取りに行った情報源だけが呼ぶ）
      const observations: FeedObservation[] = [];
      const observe = (o: FeedObservation) => {
        if (observations.length < MAX_PENDING_OBSERVATIONS) observations.push(o);
      };

      for (const id of due) {
        if (!canFetch || now() - started > budget || !canStartSource(now() - invokedAt, id, dl, sourceMax)) {
          result.sources[id] = { ok: false, skipped: "時間切れのため次回" };
          continue;
        }
        const st = sourceStatus(run.state, id);
        try {
          const items = await fetchers[id]!({
            now: now(),
            fetchImpl: opts.fetchImpl,
            known,
            knownReports,
            lastSuccessAt: st.lastSuccessAt ? Date.parse(st.lastSuccessAt) : null,
            observe,
          });
          collected.push(...items);
          outcomes.push({ id, ok: true, count: items.length, at: now() });
          result.sources[id] = { ok: true, count: items.length };
        } catch (err) {
          const e = err instanceof Error ? err : new Error("取得に失敗しました");
          outcomes.push({ id, ok: false, error: e, at: now() });
          result.sources[id] = { ok: false, error: e.message.slice(0, 120) };
        }
      }

      // 4. 保存の前に、まだ自分が印を持っているか（40 秒まで。確かめられなければ保存せずに finishRun へ）
      let owner: boolean | null = null;
      if (!clock.passed(dl.finishStartMs)) {
        try {
          owner = await stillOwner(io, run, now(), { signal: clock.signal(dl.finishStartMs) });
        } catch (err) {
          if (!abortInfo(err) && !clock.passed(dl.finishStartMs)) throw err;
          owner = null;
        }
      }
      if (owner === false) return { ...result, status: "lost-lock" };
      const incoming = uniqueById(collected);
      if (owner === null || clock.passed(dl.finishStartMs)) timedOut = true;
      else if (!incoming.length) itemsCommitted = true;
      else {
        // 5. 集めた情報の保存（40 秒で止める。止めた・結果が分からないときは、成功と記録しない）
        try {
          await saveItems(io, incoming, now(), { signal: clock.signal(dl.finishStartMs) });
          itemsCommitted = true;
          result.saved = incoming.length;
        } catch (err) {
          if (!abortInfo(err)) throw err;
          timedOut = true;
        }
      }
      // 6. 観測の記録（集めた情報を保存できた後・状態を書く前。失敗・時間切れでも、収集の結果は変えない）
      if (observations.length) {
        if (itemsCommitted && !timedOut)
          result.observations = await saveObservations(io, observations, () => now() - invokedAt, observationDeadline, observationWait, observationGrace, setTimer);
        else result.observations = { saved: 0, skipped: observations.length, failed: 0, unknown: 0, codes: ["time-budget-exceeded"] };
      }
      const deferred = deferredOf(outcomes, itemsCommitted);
      if (deferred.length) result.deferred = deferred;

      // 7. 状態の記録と印を外す（55 秒で止める。再試行もここまで）
      if (clock.passed(dl.runEndMs)) return { ...result, status: "timeout", error: "状態を記録する前に締切を過ぎました（印は期限で外れます）" };
      let wrote: boolean;
      try {
        wrote = await finishRun(io, run, (s) => applyOutcomes(s, outcomes, itemsCommitted), now(), { signal: clock.signal(dl.runEndMs) });
      } catch (err) {
        if (!abortInfo(err)) throw err;
        return { ...result, status: "timeout", error: "状態の記録が時間内に終わりませんでした（印は期限で外れます）" };
      }
      if (!wrote) return { ...result, status: "lost-lock" };
      const final = applyOutcomes(run.state, outcomes, itemsCommitted);
      result.stale = activeSources(settings, env).filter((id) => isStale(final, id, now()));
      if (timedOut) return { ...result, status: "timeout", error: "締切までに情報を保存できませんでした（その情報源は次の回に取り直します）" };
      return result;
    } catch (err) {
      // 途中で止まった：わかっている結果だけ記録して印を外す（書けなければ、印は期限で自然に切れる）。
      // 情報を保存できていなければ、項目があった成功は成功と記録しない
      const deferred = deferredOf(outcomes, itemsCommitted);
      if (deferred.length) result.deferred = deferred;
      if (!clock.passed(dl.runEndMs))
        await finishRun(io, run, (s) => applyOutcomes(s, outcomes, itemsCommitted), now(), { signal: clock.signal(dl.runEndMs) }).catch(() => false);
      return { ...result, status: "error", error: err instanceof Error ? err.message.slice(0, 200) : "失敗しました" };
    }
  } finally {
    clock.dispose();
  }
}
