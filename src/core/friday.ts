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
import type { CalendarAccess } from "@/integrations/google-calendar";
import { saveNewsSettings } from "@/integrations/news";
import type { AgentContext } from "@/agents/types";
import { CALENDAR_TAGS, runCalendarActions } from "./calendar-actions";
import { TagFilter, toFact } from "./hidden-tags";

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
    /** ニュースの設定と、今回まとめて伝えるか */
    news?: AgentContext["news"];
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
    let prepMs: number | undefined;
    let reply = "";
    const tags = new TagFilter(["memory", "news-settings", ...CALENDAR_TAGS] as const);
    const sources: { title: string; uri: string }[] = [];
    for await (const chunk of agent.run({
      messages: window.messages,
      memory,
      now: new Date(),
      timezone: getTimezone(),
      voice: options.voice ?? false,
      calendar: options.calendar,
      news: options.news,
      signal,
    })) {
      // 候補の先頭以外に自動で切り替わった場合は、実際のモデル名を知らせ直す
      if (chunk.model && chunk.model !== meta.model) yield { ...meta, model: chunk.model };
      if (chunk.text) {
        // <memory> / <calendar…> の隠しタグは画面にも読み上げにも出さない
        const text = tags.push(chunk.text);
        if (text) {
          reply += text;
          yield { type: "delta", text };
        }
      }
      if (chunk.finishReason) finishReason = chunk.finishReason;
      if (chunk.prepMs !== undefined) prepMs = chunk.prepMs;
      for (const src of chunk.sources ?? []) if (!sources.some((x) => x.uri === src.uri)) sources.push(src);
    }
    const rest = tags.flush();
    if (rest) {
      reply += rest;
      yield { type: "delta", text: rest };
    }

    // 頼まれた予定の追加・変更・削除（失敗したら本文でも知らせる＝読み上げにも乗る）
    for await (const { event, note } of runCalendarActions(tags.captures, options.calendar, signal)) {
      yield event;
      if (note) {
        const text = `${reply.endsWith("\n") ? "" : "\n\n"}${note}`;
        reply += text;
        yield { type: "delta", text };
      }
    }
    if (sources.length) yield { type: "sources", sources: sources.slice(0, 8) };

    // ニュースの設定変更（時間・興味のある分野）
    for (const raw of tags.captures["news-settings"].slice(0, 1)) {
      let change: { time?: string; topics?: string[] } | null = null;
      try {
        const v = JSON.parse(raw) as { time?: unknown; topics?: unknown };
        change = {
          ...(typeof v.time === "string" ? { time: v.time } : {}),
          ...(Array.isArray(v.topics) ? { topics: v.topics.map(String) } : {}),
        };
      } catch {
        /* 読めなければ失敗扱い */
      }
      let error: string | undefined;
      if (!change || (!change.time && !change.topics)) error = "設定の内容を読み取れませんでした。";
      else if (!options.news?.canSave) error = "脳（Obsidian）が接続されていないため保存できません。";
      else {
        try {
          const saved = await saveNewsSettings(change);
          yield { type: "news-settings", ok: true, time: saved.time, topics: saved.topics };
          continue;
        } catch {
          error = "脳に保存できませんでした。";
        }
      }
      yield { type: "news-settings", ok: false, error };
      const text = `${reply.endsWith("\n") ? "" : "\n\n"}（ニュースの設定を変更できませんでした。${error}）`;
      reply += text;
      yield { type: "delta", text };
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
    yield { type: "done", finishReason, prepMs };
  } catch (err) {
    if (signal?.aborted) return;
    const e = toFridayError(err);
    if (e.code === "UNKNOWN") console.error("[friday] conversation error:", err);
    yield { type: "error", code: e.code, message: e.message, retryable: e.retryable };
  } finally {
    options.onTurn?.(turn);
  }
}
