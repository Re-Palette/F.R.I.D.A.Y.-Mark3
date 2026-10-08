/**
 * 返答に付いた隠しタグで頼まれたカレンダー操作を実行する。
 *   <calendar>{"title","start",…}</calendar>          予定を追加
 *   <calendar-update>{"id",…変える項目}</calendar-update>  予定を変更
 *   <calendar-delete>{"id"}</calendar-delete>          予定を削除
 */
import type { StreamEvent } from "@/core/types";
import {
  CalendarError,
  type CalendarAccess,
  type CalendarEvent,
  type EventChangeInput,
  type NewEventInput,
} from "@/integrations/google-calendar";

import { CALENDAR_TAGS } from "./tag-names";
export { CALENDAR_TAGS };
export type CalendarTag = (typeof CALENDAR_TAGS)[number];

type CalendarEventOut = Extract<StreamEvent, { type: "calendar" }>;

function parseJson(raw: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(raw.replace(/^```(?:json)?|```$/g, "").trim()) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const str = (v: unknown) => (typeof v === "string" ? v : undefined);
const label = (e: CalendarEvent) => `${e.dayLabel} ${e.rangeLabel}`;

/** 予定の日時を表示用に（"2026-09-29T15:00" → "9/29 15:00"） */
function describeWhen(start: string | undefined, allDay?: boolean): string {
  const m = /^\d{4}-(\d{2})-(\d{2})(?:T(\d{2}:\d{2}))?/.exec(start ?? "");
  if (!m) return start ?? "";
  return `${Number(m[1])}/${Number(m[2])}${m[3] && !allDay ? ` ${m[3]}` : "（終日）"}`;
}

const VERB: Record<CalendarTag, string> = { calendar: "登録", "calendar-update": "変更", "calendar-delete": "削除" };
const ACTION: Record<CalendarTag, CalendarEventOut["action"]> = { calendar: "add", "calendar-update": "update", "calendar-delete": "delete" };

async function perform(tag: CalendarTag, v: Record<string, unknown>, calendar: CalendarAccess): Promise<CalendarEventOut> {
  if (tag === "calendar") {
    const added = await calendar.add(v as unknown as NewEventInput);
    return { type: "calendar", action: "add", ok: true, title: added.title, when: label(added) };
  }
  if (tag === "calendar-update") {
    const { before, after } = await calendar.update(v as unknown as EventChangeInput);
    const when = label(before) === label(after) ? label(after) : `${label(before)} → ${label(after)}`;
    return { type: "calendar", action: "update", ok: true, title: after.title, when };
  }
  const removed = await calendar.remove(str(v.id) ?? "");
  return { type: "calendar", action: "delete", ok: true, title: removed.title, when: label(removed) };
}

/**
 * 1 つずつ実行し、結果（と失敗時に本文へ足す一言）を返す。
 * 失敗は本文でも知らせる（音声会話なら読み上げられる）。
 */
export async function* runCalendarActions(
  captures: Record<CalendarTag, string[]>,
  calendar: CalendarAccess | undefined,
  signal?: AbortSignal,
): AsyncGenerator<{ event: CalendarEventOut; note?: string }> {
  for (const tag of CALENDAR_TAGS) {
    for (const raw of captures[tag]) {
      if (signal?.aborted) return;
      const v = parseJson(raw);
      const title = str(v?.title) ?? (tag === "calendar" ? "予定" : "その予定");
      let error: string;
      if (!calendar) error = "Google カレンダーに接続されていません。";
      else if (!v) error = "予定の内容を読み取れませんでした。";
      else {
        try {
          yield { event: await perform(tag, v, calendar) };
          continue;
        } catch (err) {
          error = err instanceof CalendarError ? err.message : `Google カレンダーで${VERB[tag]}できませんでした。`;
        }
      }
      yield {
        event: { type: "calendar", action: ACTION[tag], ok: false, title, when: describeWhen(str(v?.start), v?.allDay === true), error },
        note: `（「${title}」はカレンダーで${VERB[tag]}できませんでした。${error}）`,
      };
    }
  }
}
