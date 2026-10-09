/**
 * 画面が持つ予定の控え（今日から 7 日分の Google カレンダーの予定）。画面側で動く。
 *
 * 会話を送るときに一緒に送り、サーバーが Google から最新の予定を取るのに間に合わなかったときの予備にする
 * （サーバーレスでは、初めてのサーバーが返答前の短い時間に間に合わないことがあるため）。
 * 画面を開いたとき・画面に戻ったとき・5 分ごと・予定が変わったとき・入力中に読み直す。
 * この端末の中だけに置き、6 時間より古い控えは送らない。
 */
import type { CalendarEventView, CalendarResponse } from "@/core/types";

const KEY = "friday.calendar.v1";
/** これより古い控えは送らない（サーバー側でも同じ長さで確かめる） */
const MAX_AGE_MS = 6 * 60 * 60_000;
/** 続けて読み直すのは、この間隔まで（予定が変わったときは待たない） */
const MIN_INTERVAL_MS = 60_000;

export interface CalendarCache {
  events: CalendarEventView[];
  /** Google カレンダーから読み込んだ時刻 */
  at: number;
}

let memo: CalendarCache | null | undefined;
let inflight: Promise<void> | null = null;
let lastTry = 0;

function read(): CalendarCache | null {
  if (memo !== undefined) return memo;
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "null") as CalendarCache | null;
    memo = raw && Array.isArray(raw.events) && typeof raw.at === "number" ? raw : null;
  } catch {
    memo = null;
  }
  return memo;
}

function write(next: CalendarCache | null) {
  memo = next;
  try {
    if (next) localStorage.setItem(KEY, JSON.stringify(next));
    else localStorage.removeItem(KEY);
  } catch {
    /* noop */
  }
}

/** 会話と一緒に送る控え（無い・古いときは undefined） */
export function calendarForChat(): CalendarCache | undefined {
  const c = read();
  return c && Date.now() - c.at < MAX_AGE_MS ? c : undefined;
}

/** 控えを読み直す（force: 予定が変わった直後など、間隔を空けずに） */
export function refreshCalendarCache(force = false): Promise<void> {
  if (inflight) return inflight;
  if (!force && Date.now() - lastTry < MIN_INTERVAL_MS) return Promise.resolve();
  lastTry = Date.now();
  inflight = (async () => {
    try {
      const res = await fetch("/api/calendar/events?days=7", { cache: "no-store", signal: AbortSignal.timeout(15_000) });
      if (!res.ok) return;
      const json = (await res.json()) as CalendarResponse;
      if (!json.configured || !json.connected) write(null); // 接続していない・切れた：古い予定を送らない
      else if (json.events) write({ events: json.events, at: Date.now() });
      // 読み込めなかった（Google の一時的なエラー）ときは、前回の控えをそのまま使う
    } catch {
      /* ネットが切れているなど：前回の控えをそのまま使う */
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}
