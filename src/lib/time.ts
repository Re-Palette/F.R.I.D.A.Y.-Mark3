/**
 * タイムゾーン付きの日時の小道具（サーバー・クライアント両用、依存なし）。
 */

/** 例: "+09:00" */
export function tzOffset(date: Date, tz: string): string {
  const name = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "longOffset" })
    .formatToParts(date)
    .find((p) => p.type === "timeZoneName")?.value;
  const m = /GMT([+-]\d{2}):?(\d{2})?/.exec(name ?? "");
  return m ? `${m[1]}:${m[2] ?? "00"}` : "+00:00";
}

/** その地域の "2026-09-29T18:00" → Date */
export function parseLocal(local: string, tz: string): Date {
  const noon = new Date(`${local.slice(0, 10)}T12:00:00Z`);
  return new Date(`${local.slice(0, 16)}:00${tzOffset(noon, tz)}`);
}

/** Date → その地域の "2026-09-29T18:00" */
export function toLocal(date: Date, tz: string): string {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  })
    .format(date)
    .replace(" ", "T");
}

/** "9/29(月) 18:00" */
export function labelLocal(date: Date, tz: string): string {
  const day = new Intl.DateTimeFormat("ja-JP", { timeZone: tz, month: "numeric", day: "numeric", weekday: "short" }).format(date);
  const time = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(date);
  return `${day.replace(/\s/g, "")} ${time}`;
}

/** 人格（system prompt）に入れる「現在日時」の書き方（サーバーとオフラインの画面で同じにする） */
export function formatNow(now: Date, timezone: string): string {
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: timezone,
    year: "numeric",
    month: "long",
    day: "numeric",
    weekday: "long",
    hour: "2-digit",
    minute: "2-digit",
  }).format(now);
}
