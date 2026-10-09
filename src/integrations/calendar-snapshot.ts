/**
 * 画面が持っている予定の控え（ブラウザが最後に読み込んだ、今日から 7 日分の Google カレンダーの予定）。
 *
 * サーバーレスでは、会話を受け持つサーバーが毎回同じとは限らない。初めてのサーバーは Google への問い合わせから始めるので、
 * 返答前に待てる時間に間に合わず「予定を読めなかった」になることがある。そのときの予備として、画面が送ってくる控えを使う。
 * 控えは本人の画面から届いた本人の予定だけ。形と長さを確かめ、古すぎるものは使わない。
 */
import type { CalendarEvent } from "./google-calendar";

export interface CalendarSnapshot {
  events: CalendarEvent[];
  /** 画面が Google カレンダーの予定を読み込んだ時刻（ミリ秒） */
  at: number;
}

/** これより古い控えは使わない */
export const SNAPSHOT_MAX_AGE_MS = 6 * 60 * 60_000;
const MAX_EVENTS = 60;

const str = (v: unknown, max: number): string | undefined => (typeof v === "string" && v.length <= max ? v : undefined);

/** 画面から届いた控えを確かめる（おかしければ undefined） */
export function parseCalendarSnapshot(raw: unknown, now = Date.now()): CalendarSnapshot | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const { events, at } = raw as { events?: unknown; at?: unknown };
  if (typeof at !== "number" || !Number.isFinite(at) || at > now + 60_000 || now - at > SNAPSHOT_MAX_AGE_MS) return undefined;
  if (!Array.isArray(events) || events.length > MAX_EVENTS) return undefined;
  const out: CalendarEvent[] = [];
  for (const e of events) {
    if (!e || typeof e !== "object") return undefined;
    const r = e as Record<string, unknown>;
    const id = str(r.id, 1024);
    const title = str(r.title, 300);
    const start = str(r.start, 40);
    const end = str(r.end, 40);
    const dayLabel = str(r.dayLabel, 40);
    const timeLabel = str(r.timeLabel, 40);
    const rangeLabel = str(r.rangeLabel, 40);
    if (!id || title === undefined || !start || !end || !dayLabel || !timeLabel || !rangeLabel || typeof r.allDay !== "boolean") return undefined;
    if (!/^\d{4}-\d{2}-\d{2}/.test(start) || !/^\d{4}-\d{2}-\d{2}/.test(end)) return undefined;
    const location = str(r.location, 300);
    out.push({ id, title, start, end, allDay: r.allDay, dayLabel, timeLabel, rangeLabel, ...(location ? { location } : {}) });
  }
  return { events: out, at };
}

const addDays = (day: string, n: number) => {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/**
 * 控えから、今日から days 日分の予定だけを取り出す（日をまたいだ控えでも、終わった日の予定は除く）。
 * 予定の日時は Google がその地域の時刻で返したもの（"2026-10-09T15:00:00+09:00" / 終日 "2026-10-09"）。
 */
export function snapshotEvents(snap: CalendarSnapshot, now: Date, timezone: string, days = 7): CalendarEvent[] {
  const today = new Intl.DateTimeFormat("sv-SE", { timeZone: timezone }).format(now);
  const last = addDays(today, days);
  return snap.events.filter((e) => {
    const startDay = e.start.slice(0, 10);
    const endDay = e.end.slice(0, 10);
    // 終日の予定の終わりは「次の日」（その日は含まない）
    const endsToday = e.allDay ? endDay > today : endDay >= today;
    return endsToday && startDay < last;
  });
}
