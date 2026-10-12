/**
 * GOD'S EYE VIEW（EARTH）のレイヤーの定期取得（画面側）。DOM に頼らないので、テストで時計を差し替えられる。
 *   - start で 1 回取り、その後は intervalMs ごと。止めたら（stop）、途中の取得も止め、後から届いた結果は捨てる
 *   - 止まっている間（画面が隠れている・オフライン：isPaused）は取りに行かない
 *   - 失敗しても間隔を縮めない（取りに行きすぎない）。相手が待ち時間（retryAfterMs）を言えば、それより早くは取らない
 *   - 同時に 2 つの取得はしない
 */
/** 失敗のとき payload に、API の失敗の応答（確かめたもの）が入る（使うかは呼ぶ側が決める。地震では使わない） */
export type PollResult<T> = { ok: true; data: T; at: number } | { ok: false; error: string; at: number; retryAfterMs?: number; payload?: unknown };

export class PollError extends Error {
  constructor(
    message: string,
    public readonly retryAfterMs?: number,
    public readonly payload?: unknown,
  ) {
    super(message);
    this.name = "PollError";
  }
}

export interface PollerOptions<T> {
  fetchOnce: (signal: AbortSignal) => Promise<T>;
  intervalMs: number;
  onResult: (r: PollResult<T>) => void;
  onLoading?: (loading: boolean) => void;
  isPaused?: () => boolean;
  now?: () => number;
  setTimer?: (ms: number, fn: () => void) => () => void;
}

/** 止まっている（隠れている・オフライン）間に、再開できるか確かめる間隔 */
const PAUSE_RECHECK_MS = 5000;
/**
 * タイマー 1 回で待つ長さの上限。setTimeout は約 24.8 日（2^31-1 ms）を超えると、すぐに動いてしまう。
 * それより長い待ち時間は、この長さずつ区切って待つ（区切っても、最後の期限より前には取りに行かない）
 */
export const MAX_TIMER_MS = 24 * 60 * 60_000;

const realTimer = (ms: number, fn: () => void) => {
  const h = setTimeout(fn, ms);
  return () => clearTimeout(h);
};

export function createPoller<T>(o: PollerOptions<T>) {
  const now = o.now ?? Date.now;
  const setTimer = o.setTimer ?? realTimer;
  let running = false;
  let cancelTimer: (() => void) | null = null;
  let ctrl: AbortController | null = null;
  let inFlight = false;
  /** これより前には取りに行かない（相手の指定した待ち時間） */
  let notBefore = 0;

  const schedule = (ms: number) => {
    cancelTimer?.();
    const wait = Math.max(0, ms);
    // ふつうの長さ（24 時間以内）は、これまでどおりタイマー 1 回
    if (wait <= MAX_TIMER_MS) {
      cancelTimer = setTimer(wait, () => void tick());
      return;
    }
    // とても長い待ち時間：期限を覚えて、区切って待つ
    const due = now() + wait;
    const step = () => {
      const left = due - now();
      if (left <= 0) return void tick();
      cancelTimer = setTimer(Math.min(left, MAX_TIMER_MS), step);
    };
    cancelTimer = setTimer(MAX_TIMER_MS, step);
  };

  async function tick(): Promise<void> {
    if (!running) return;
    if (inFlight) return;
    if (now() < notBefore) {
      schedule(notBefore - now());
      return;
    }
    // 止まっている間は取りに行かず、少し後にまた確かめる（通信はしない）
    if (o.isPaused?.()) {
      schedule(Math.min(o.intervalMs, PAUSE_RECHECK_MS));
      return;
    }
    inFlight = true;
    ctrl = new AbortController();
    const mine = ctrl;
    o.onLoading?.(true);
    let next = o.intervalMs;
    try {
      const data = await o.fetchOnce(mine.signal);
      if (!running || mine.signal.aborted) return;
      o.onResult({ ok: true, data, at: now() });
    } catch (err) {
      if (!running || mine.signal.aborted) return;
      const retry = err instanceof PollError && err.retryAfterMs ? err.retryAfterMs : 0;
      if (retry > 0) notBefore = now() + retry;
      next = Math.max(o.intervalMs, retry);
      const failure: PollResult<T> = { ok: false, error: err instanceof Error ? err.message.slice(0, 200) : "取得に失敗しました", at: now() };
      if (retry > 0) failure.retryAfterMs = retry;
      if (err instanceof PollError && err.payload !== undefined) failure.payload = err.payload;
      o.onResult(failure);
    } finally {
      if (ctrl === mine) ctrl = null;
      inFlight = false;
      if (running) {
        o.onLoading?.(false);
        schedule(next);
      }
    }
  }

  return {
    start() {
      if (running) return;
      running = true;
      void tick();
    },
    stop() {
      running = false;
      cancelTimer?.();
      cancelTimer = null;
      ctrl?.abort();
      ctrl = null;
      inFlight = false;
    },
    /** すぐ取り直す（取得中・待ち時間の指定中は何もしない） */
    refresh() {
      if (!running || inFlight || now() < notBefore) return;
      void tick();
    },
    get running() {
      return running;
    },
  };
}

/** API を呼んで JSON を読む。失敗は PollError（429 なら待ち時間つき）。応答の形は parse で確かめる */
export async function fetchLayerJson<T>(url: string, signal: AbortSignal, parse: (raw: unknown) => ({ ok: true } & T) | { ok: false; error: string } | null): Promise<{ ok: true } & T> {
  let res: Response;
  try {
    res = await fetch(url, { signal, cache: "no-store", credentials: "same-origin" });
  } catch {
    throw new PollError("接続できませんでした");
  }
  let raw: unknown = null;
  try {
    raw = await res.json();
  } catch {
    /* 下で扱う */
  }
  const retry = Number(res.headers.get("retry-after"));
  const parsed = parse(raw);
  if (res.status === 401) throw new PollError("ログインが必要です");
  if (!res.ok || !parsed || !parsed.ok) {
    const msg = parsed && !parsed.ok ? parsed.error : `取得に失敗しました（HTTP ${res.status}）`;
    throw new PollError(msg, Number.isFinite(retry) && retry > 0 ? retry * 1000 : undefined, parsed && !parsed.ok ? parsed : undefined);
  }
  return parsed;
}
