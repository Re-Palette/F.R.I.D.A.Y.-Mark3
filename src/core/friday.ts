/**
 * F.R.I.D.A.Y. Core — 依頼を受け取り、Router で Agent を選び、結果をストリームで返す。
 *
 *   ユーザー → Core → Router → Agent（Chat / Search / ...）→ Core → ユーザー
 */
import type { ChatMessage, StreamEvent } from "@/core/types";
import { routeRequest } from "@/core/router";
import { getContextConfig, getGeminiConfig, getTimezone, settingsHint } from "@/lib/config";
import { FridayError, toFridayError } from "@/lib/errors";
import { buildConversationWindow } from "@/memory/context";
import { getLongTermMemory, type SaveTurnInput } from "@/memory/long-term";
import { CalendarError, type CalendarAccess, type NewEventInput } from "@/integrations/google-calendar";
import { TagFilter, toFact } from "./hidden-tags";

/** <calendar>{"title":…,"start":…}</calendar> の中身を読む */
function parseCalendarTag(raw: string): NewEventInput | null {
  const json = raw.replace(/^```(?:json)?|```$/g, "").trim();
  try {
    const v = JSON.parse(json) as Partial<NewEventInput>;
    return v && typeof v === "object" && typeof v.title === "string" && typeof v.start === "string" ? (v as NewEventInput) : null;
  } catch {
    return null;
  }
}

/** 予定の日時を読み上げ・表示用に（"2026-09-29T15:00" → "9/29 15:00"） */
function describeWhen(input: NewEventInput): string {
  const m = /^\d{4}-(\d{2})-(\d{2})(?:T(\d{2}:\d{2}))?/.exec(input.start ?? "");
  if (!m) return input.start ?? "";
  return `${Number(m[1])}/${Number(m[2])}${m[3] && !input.allDay ? ` ${m[3]}` : "（終日）"}`;
}

export const MAX_MESSAGE_CHARS = 16000;
const MAX_HISTORY_ITEMS = 400;

/** クライアントから来た履歴を検証・正規化する */
export function sanitizeHistory(input: unknown): ChatMessage[] {
  if (!Array.isArray(input)) {
    throw new FridayError("BAD_REQUEST", "messages が不正です。", 400);
  }
  const messages = input
    .slice(-MAX_HISTORY_ITEMS)
    .filter(
      (m): m is ChatMessage =>
        !!m &&
        typeof m === "object" &&
        (m.role === "user" || m.role === "assistant") &&
        typeof m.content === "string" &&
        m.content.trim().length > 0,
    )
    .map((m) => ({ role: m.role, content: m.content.slice(0, MAX_MESSAGE_CHARS) }));

  if (messages.length === 0 || messages[messages.length - 1].role !== "user") {
    throw new FridayError("BAD_REQUEST", "送信するメッセージがありません。", 400);
  }
  return messages;
}

/** 事前チェック（ストリーム開始前に HTTP ステータスで返したいエラー） */
export function preflight(): void {
  if (!getGeminiConfig().apiKey) {
    throw new FridayError(
      "MISSING_API_KEY",
      `Gemini API キーが設定されていません。${settingsHint("GEMINI_API_KEY")}`,
      503,
    );
  }
}

export async function* handleConversation(
  history: ChatMessage[],
  signal?: AbortSignal,
  options: {
    voice?: boolean;
    /** 返答が最後まで終わったら 1 往復分を渡す（脳への保存用）。失敗・中断時は null */
    onTurn?: (turn: SaveTurnInput | null) => void;
    /** この端末で接続済みの Google カレンダー */
    calendar?: CalendarAccess;
  } = {},
): AsyncGenerator<StreamEvent> {
  let turn: SaveTurnInput | null = null;
  try {
    const window = buildConversationWindow(history, getContextConfig());
    const agent = await routeRequest(window.messages);

    const meta = {
      type: "meta" as const,
      agent: agent.id,
      model: agent.describe().model,
      contextMessages: window.messages.length,
    };
    yield meta;

    const memory = getLongTermMemory();
    let finishReason: string | undefined;
    let reply = "";
    const tags = new TagFilter(["memory", "calendar"] as const);
    for await (const chunk of agent.run({
      messages: window.messages,
      memory,
      now: new Date(),
      timezone: getTimezone(),
      voice: options.voice ?? false,
      calendar: options.calendar,
      signal,
    })) {
      // 候補の先頭以外に自動で切り替わった場合は、実際のモデル名を知らせ直す
      if (chunk.model && chunk.model !== meta.model) yield { ...meta, model: chunk.model };
      if (chunk.text) {
        // <memory>…</memory> / <calendar>…</calendar> は画面にも読み上げにも出さない
        const text = tags.push(chunk.text);
        if (text) {
          reply += text;
          yield { type: "delta", text };
        }
      }
      if (chunk.finishReason) finishReason = chunk.finishReason;
    }
    const rest = tags.flush();
    if (rest) {
      reply += rest;
      yield { type: "delta", text: rest };
    }

    // 頼まれた予定を Google カレンダーに追加する（失敗したら本文でも知らせる＝読み上げにも乗る）
    for (const raw of tags.captures.calendar) {
      if (signal?.aborted) break;
      const input = parseCalendarTag(raw);
      const title = input?.title ?? "予定";
      const when = input ? describeWhen(input) : "";
      let error: string | undefined;
      if (!options.calendar) error = "Google カレンダーに接続されていません。";
      else if (!input) error = "予定の内容を読み取れませんでした。";
      else {
        try {
          const added = await options.calendar.add(input);
          yield { type: "calendar", ok: true, title: added.title, when: `${added.dayLabel} ${added.rangeLabel}` };
          continue;
        } catch (err) {
          error = err instanceof CalendarError ? err.message : "Google カレンダーに登録できませんでした。";
        }
      }
      yield { type: "calendar", ok: false, title, when, error };
      const note = `${reply.endsWith("\n") ? "" : "\n\n"}（「${title}」はカレンダーに登録できませんでした。${error}）`;
      reply += note;
      yield { type: "delta", text: note };
    }

    const facts = tags.captures.memory.map(toFact).filter(Boolean);
    // 脳が無い・つながらないときは保存されないので、覚えたとは表示しない（保存自体は試みる）
    if (memory.save && memory.healthy !== false) for (const text of facts) yield { type: "memory", text };
    turn = {
      user: window.messages[window.messages.length - 1]?.content ?? "",
      assistant: reply.trim(),
      memories: memory.save ? facts : [],
      voice: options.voice ?? false,
    };
    yield { type: "done", finishReason };
  } catch (err) {
    if (signal?.aborted) return;
    const e = toFridayError(err);
    if (e.code === "UNKNOWN") console.error("[friday] conversation error:", err);
    yield { type: "error", code: e.code, message: e.message, retryable: e.retryable };
  } finally {
    options.onTurn?.(turn);
  }
}
