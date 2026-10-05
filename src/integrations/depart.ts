/**
 * 出かける前の一言。場所の入った予定の前に「そろそろ出る時間です」と、天気（傘）・今日が期限のものと一緒に知らせる。
 *   画面を開いているとき … 声かけ（/api/nudges）
 *   閉じているとき       … プッシュ通知（/api/cron/push。全端末共通のカレンダー接続 GOOGLE_REFRESH_TOKEN があるとき）
 * 移動時間は、予定の名前か場所に「移動60分」のように書けばその時間、無ければ FRIDAY_DEPART_MINUTES（既定 45 分）前に知らせる。
 * （位置情報から正確な移動時間を出すには有料の地図 API が要るので、ここでは使わない）
 */
import type { CalendarEvent } from "@/integrations/google-calendar";

/** 予定の何分前に知らせるか（移動時間の目安） */
export function defaultLeadMinutes(): number {
  const n = Number(process.env.FRIDAY_DEPART_MINUTES);
  return Number.isFinite(n) && n >= 5 && n <= 240 ? Math.round(n) : 45;
}

/** 出かける予定か（時刻つきで、場所が入っている） */
export function isOuting(ev: CalendarEvent): boolean {
  return !ev.allDay && Boolean(ev.location?.trim());
}

/** この予定の移動時間（分）。名前・場所の「移動60分」「移動:30」を優先 */
export function travelMinutes(ev: CalendarEvent): number {
  const m = /移動\s*[:：]?\s*(\d{1,3})\s*分?/.exec(`${ev.title} ${ev.location ?? ""}`);
  const n = m ? Number(m[1]) : NaN;
  return Number.isFinite(n) && n >= 5 && n <= 240 ? n : defaultLeadMinutes();
}

/** 「15時」「15時半」「15時10分」 */
export function spokenTime(label: string): string {
  const m = /^(\d{1,2}):(\d{2})$/.exec(label);
  if (!m) return label;
  const h = Number(m[1]);
  const min = Number(m[2]);
  return min === 0 ? `${h}時` : min === 30 ? `${h}時半` : `${h}時${min}分`;
}

/** 場所の「移動60分」の書き込みは読み上げない */
const placeName = (ev: CalendarEvent) => (ev.location ?? "").replace(/[（(]?\s*移動\s*[:：]?\s*\d{1,3}\s*分?\s*[)）]?/g, "").trim();

/**
 * 知らせる文。left があれば「あと{left}分で始まります」の形（画面が話す時点の分数に置き換える）。
 * rain は今日の降水確率（%）、dueToday は今日が期限の ToDo。
 */
export function departText(ev: CalendarEvent, opts: { rain?: number; snow?: boolean; dueToday?: string[]; left?: boolean }): string {
  const place = placeName(ev);
  const parts = [`${spokenTime(ev.timeLabel)}から「${ev.title.replace(/[（(]?\s*移動\s*[:：]?\s*\d{1,3}\s*分?\s*[)）]?/g, "").trim()}」${place ? `、場所は${place}` : ""}です。`];
  parts.push(opts.left ? "あと{left}分で始まります。そろそろ出る時間です。" : "そろそろ出る時間です。");
  if (opts.rain !== undefined && opts.rain >= 50) parts.push(`${opts.snow ? "雪" : "雨"}の予報なので、傘を持っていってください。`);
  const due = (opts.dueToday ?? []).slice(0, 2);
  if (due.length) parts.push(`今日が期限なのは${due.join("と")}です。`);
  return parts.join("");
}
