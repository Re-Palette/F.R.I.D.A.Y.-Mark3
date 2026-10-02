/**
 * F.R.I.D.A.Y. Core — 依頼を受け取り、Router で Agent を選び、結果をストリームで返す。
 *
 *   ユーザー → Core → Router → Agent（Chat / Search / ...）→ Core → ユーザー
 */
import type { ChatFile, ChatImage, ChatMessage, StreamEvent } from "@/core/types";
import { isAttachmentPath } from "@/lib/brain-paths";
import { appendQuizResult, QUIZ_LOG_PATH, saveFileNote } from "@/integrations/brain-notes";
import { parseFocus } from "@/lib/focus-command";
import { routeRequest } from "@/core/router";
import { getContextConfig, getGeminiConfig, getTimezone, settingsHint } from "@/lib/config";
import { FridayError, toFridayError } from "@/lib/errors";
import { buildConversationWindow } from "@/memory/context";
import { getLongTermMemory, type SaveTurnInput } from "@/memory/long-term";
import type { CalendarAccess } from "@/integrations/google-calendar";
import { saveNewsSettings } from "@/integrations/news";
import type { AgentContext } from "@/agents/types";
import { BRAIN_TAGS, runBrainActions } from "./brain-actions";
import { CALENDAR_TAGS, runCalendarActions } from "./calendar-actions";
import { TagFilter, toFact } from "./hidden-tags";
import { BROWSER_TAGS, toBrowserEvent } from "./browser-actions";
import { GMAIL_TAGS, runGmailActions } from "./gmail-actions";
import { MUSIC_TAGS, runMusicActions } from "./music-actions";
import type { SpotifyAccess } from "@/integrations/spotify";
import type { DraftInput } from "@/integrations/gmail";
import { saveDocument, toFolder } from "@/integrations/documents";

export const MAX_MESSAGE_CHARS = 16000;
const MAX_HISTORY_ITEMS = 400;
/** カメラの画像の上限（base64 の文字数。約 1.5MB。画面側で 1024px 以内の JPEG にしてから送る） */
const MAX_IMAGE_CHARS = 2_000_000;
const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

/** 画像が正しい形か（種類・大きさ・base64 の文字だけか） */
function toImage(v: unknown): ChatImage | undefined {
  if (!v || typeof v !== "object") return undefined;
  const { mimeType, data } = v as { mimeType?: unknown; data?: unknown };
  if (typeof mimeType !== "string" || !IMAGE_TYPES.has(mimeType)) return undefined;
  if (typeof data !== "string" || data.length === 0 || data.length > MAX_IMAGE_CHARS || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) return undefined;
  return { mimeType: mimeType as ChatImage["mimeType"], data };
}

/** 添えたファイルの上限（画像・PDF の base64 の合計・文字の合計・数） */
const MAX_FILE_DATA_CHARS = 3_400_000;
const MAX_FILE_TEXT_CHARS = 260_000;
const MAX_FILES = 16;
const FILE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "application/pdf", "text/plain"]);

/** 添えたファイルが正しい形か（種類・大きさ・base64 の文字だけか）。合計が上限を超える分は捨てる */
function toFiles(v: unknown): ChatFile[] | undefined {
  if (!Array.isArray(v)) return undefined;
  let data = 0;
  let text = 0;
  const out: ChatFile[] = [];
  for (const f of v.slice(0, MAX_FILES)) {
    if (!f || typeof f !== "object") continue;
    const { name, mimeType, data: d, text: t } = f as Record<string, unknown>;
    if (typeof mimeType !== "string" || !FILE_TYPES.has(mimeType)) continue;
    const file: ChatFile = { name: typeof name === "string" ? name.slice(0, 120) : "ファイル", mimeType: mimeType as ChatFile["mimeType"] };
    if (mimeType === "text/plain") {
      if (typeof t !== "string" || !t.trim() || text + t.length > MAX_FILE_TEXT_CHARS) continue;
      file.text = t;
      text += t.length;
    } else {
      if (typeof d !== "string" || !d || data + d.length > MAX_FILE_DATA_CHARS || !/^[A-Za-z0-9+/]+={0,2}$/.test(d)) continue;
      file.data = d;
      data += d.length;
    }
    out.push(file);
  }
  return out.length ? out : undefined;
}

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
    .map((m, i, all) => {
      const out: ChatMessage = { role: m.role, content: m.content.slice(0, MAX_MESSAGE_CHARS) };
      // 画像は最新のユーザー発言のものだけ受け取る（古い画像を毎回送り直さない）
      const image = i === all.length - 1 && m.role === "user" ? toImage((m as { image?: unknown }).image) : undefined;
      return image ? { ...out, image } : out;
    });
  // この発言で新しく添えたファイルの名前と原本の場所（最新の発言だけ）
  const lastRaw = input[input.length - 1] as { attached?: unknown } | undefined;
  if (Array.isArray(lastRaw?.attached)) {
    const attached = lastRaw.attached
      .slice(0, 8)
      .filter((a): a is { name: string; path?: unknown } => !!a && typeof (a as { name?: unknown }).name === "string")
      .map((a) => ({ name: a.name.slice(0, 120), ...(typeof a.path === "string" && isAttachmentPath(a.path) ? { path: a.path } : {}) }));
    if (attached.length) messages[messages.length - 1] = { ...messages[messages.length - 1], attached };
  }
  // 添えたファイルは、ファイルの付いた最後のユーザー発言のものだけ受け取る（直近 10 件以内）
  const raw = input.slice(-MAX_HISTORY_ITEMS) as { role?: unknown; content?: unknown; files?: unknown }[];
  for (let i = raw.length - 1, j = messages.length - 1; i >= 0 && j >= 0 && messages.length - j <= 10; i--) {
    const m = raw[i];
    if (!m || typeof m.content !== "string" || !m.content.trim() || (m.role !== "user" && m.role !== "assistant")) continue;
    if (m.role === "user" && m.files !== undefined) {
      const files = toFiles(m.files);
      if (files) messages[j] = { ...messages[j], files };
      break;
    }
    j--;
  }

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
    /** 未読メールを読む */
    mail?: AgentContext["mail"];
    /** 返信用に直近のメールを本文つきで読む・下書きを作れるか */
    mailRecent?: AgentContext["mailRecent"];
    mailCanDraft?: AgentContext["mailCanDraft"];
    /** Gmail に下書きを作る（送信はしない） */
    draft?: (input: DraftInput) => Promise<{ to: string; subject: string }>;
    /** この端末で接続済みの Spotify */
    spotify?: SpotifyAccess;
    /** Spotify のサーバー側の設定があるか（未接続なら接続の仕方を伝える） */
    spotifyConfigured?: boolean;
    /** 音楽の話のとき、画面から届いた Amazon Music の状態 */
    amazon?: AgentContext["amazon"];
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
    const tags = new TagFilter(["memory", "news-settings", "document", "file-note", "focus", "quiz-result", ...CALENDAR_TAGS, ...BRAIN_TAGS, ...BROWSER_TAGS, "hologram", ...GMAIL_TAGS, ...MUSIC_TAGS] as const, {
      document: 30_000,
      "gmail-draft": 8000,
      "file-note": 6000,
    });
    const sources: { title: string; uri: string }[] = [];
    // ページを開く・閉じるは待たせたくないので、タグが閉じた時点ですぐ画面に送る
    const browserSent = { "open-url": 0, "close-tab": 0, hologram: 0 };
    const browserEvents = function* (): Generator<StreamEvent> {
      for (const tag of BROWSER_TAGS) {
        const list = tags.captures[tag];
        for (; browserSent[tag] < list.length; browserSent[tag]++) {
          yield toBrowserEvent(tag, list[browserSent[tag]], tags.attrs[tag][browserSent[tag]]);
        }
      }
      // 3D ホログラムを作る・消す（設計は画面から /api/hologram に頼む）
      const holos = tags.captures.hologram;
      for (; browserSent.hologram < holos.length; browserSent.hologram++) {
        const subject = holos[browserSent.hologram].replace(/\s+/g, " ").trim().slice(0, 60);
        yield { type: "hologram", subject: /^(clear|消す|off|none)$/i.test(subject) ? null : subject };
      }
    };
    for await (const chunk of agent.run({
      messages: window.messages,
      memory,
      now: new Date(),
      timezone: getTimezone(),
      voice: options.voice ?? false,
      calendar: options.calendar,
      news: options.news,
      mail: options.mail,
      mailRecent: options.mailRecent,
      mailCanDraft: options.mailCanDraft,
      spotify: options.spotify,
      spotifyConfigured: options.spotifyConfigured,
      amazon: options.amazon,
      signal,
    })) {
      // 候補の先頭以外に自動で切り替わった場合は、実際のモデル名を知らせ直す
      if (chunk.model && chunk.model !== meta.model) yield { ...meta, model: chunk.model };
      if (chunk.stage) yield { type: "stage", stage: chunk.stage };
      if (chunk.text) {
        // <memory> / <calendar…> の隠しタグは画面にも読み上げにも出さない
        const text = tags.push(chunk.text);
        if (text) {
          reply += text;
          yield { type: "delta", text };
        }
        yield* browserEvents();
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
    yield* browserEvents();

    // 頼まれた予定の追加・変更・削除（失敗したら本文でも知らせる＝読み上げにも乗る）
    for await (const { event, note } of runCalendarActions(tags.captures, options.calendar, signal)) {
      yield event;
      if (note) {
        const text = `${reply.endsWith("\n") ? "" : "\n\n"}${note}`;
        reply += text;
        yield { type: "delta", text };
      }
    }
    // ToDo・進捗・リマインダーを脳に書く（失敗したら本文でも知らせる）
    for await (const { event, note } of runBrainActions(tags.captures, memory.connected, signal)) {
      yield event;
      if (note) {
        const text = `${reply.endsWith("\n") ? "" : "\n\n"}${note}`;
        reply += text;
        yield { type: "delta", text };
      }
    }
    // 頼まれた音楽の操作（Spotify はここで実行、Amazon Music は画面に頼む。失敗したら本文でも知らせる）
    for await (const { event, note } of runMusicActions(tags.captures, options.spotify, Boolean(options.amazon?.ext), signal)) {
      yield event;
      if (note) {
        const text = `${reply.endsWith("\n") ? "" : "\n\n"}${note}`;
        reply += text;
        yield { type: "delta", text };
      }
    }
    // クイズの結果を脳の「学習/クイズ記録.md」に残す
    for (const raw of tags.captures["quiz-result"].slice(0, 1)) {
      try {
        const v = JSON.parse(raw.replace(/^```(?:json)?|```$/g, "").trim()) as { subject?: unknown; score?: unknown; total?: unknown; weak?: unknown };
        const total = Math.max(0, Math.min(50, Number(v.total) || 0));
        if (!total || !memory.connected) continue;
        const result = {
          subject: typeof v.subject === "string" ? v.subject.slice(0, 40) : "",
          score: Math.max(0, Math.min(total, Number(v.score) || 0)),
          total,
          weak: Array.isArray(v.weak) ? v.weak.filter((w): w is string => typeof w === "string").map((w) => w.slice(0, 40)).slice(0, 5) : [],
        };
        await appendQuizResult(result);
        yield { type: "document", ok: true, title: `クイズ記録（${result.score} / ${result.total}）`, path: QUIZ_LOG_PATH };
      } catch {
        /* 読めない・保存できなければ記録しない */
      }
    }
    // 集中モード（タイマー・音楽は画面が動かす）
    for (const raw of tags.captures.focus.slice(0, 1)) {
      const cmd = parseFocus(raw);
      if (cmd) yield { type: "focus", ...cmd };
    }
    // 頼まれたメールの下書きを Gmail に保存（送信はしない。失敗したら本文でも知らせる）
    for await (const { event, note } of runGmailActions(tags.captures, tags.attrs, options.draft, signal)) {
      yield event;
      if (note) {
        const text = `${reply.endsWith("\n") ? "" : "\n\n"}${note}`;
        reply += text;
        yield { type: "delta", text };
      }
    }
    // 書いた文書を脳に保存（本文は画面のカードに出す。読み上げはしない）
    for (const [i, content] of tags.captures.document.entries()) {
      const attrs = tags.attrs.document[i] ?? {};
      const title = attrs.title || /^#\s+(.+)$/m.exec(content)?.[1]?.trim() || "無題";
      try {
        if (!memory.connected) throw new Error("脳（Obsidian）が接続されていないため保存できません。");
        const saved = await saveDocument({ title, folder: toFolder(attrs.folder), content });
        yield { type: "document", ok: true, title: saved.title, path: saved.path, content, updated: saved.updated };
      } catch (err) {
        const error = err instanceof Error ? err.message : "脳に保存できませんでした。";
        yield { type: "document", ok: false, title, content, error };
      }
    }
    // 添えたファイルの要点を脳の「資料」に保存（原本は画面から「添付」に保存済み）
    const latest = window.messages[window.messages.length - 1];
    if (latest?.attached?.length && memory.connected && reply.trim()) {
      const attrs = tags.attrs["file-note"][0] ?? {};
      const points = tags.captures["file-note"][0] ?? "";
      const title = attrs.title || latest.attached[0].name.replace(/\.[^.]+$/, "");
      try {
        const saved = await saveFileNote({ title, points, question: latest.content, answer: reply, files: latest.attached });
        yield { type: "document", ok: true, title: saved.title, path: saved.path };
      } catch (err) {
        yield { type: "document", ok: false, title, error: err instanceof Error ? err.message : "資料を脳に保存できませんでした。" };
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
      // カメラの映像を見せたことだけ記録する（画像そのものは保存しない）
      user: `${window.messages[window.messages.length - 1]?.content ?? ""}${window.messages[window.messages.length - 1]?.image ? "（カメラの映像つき）" : ""}${
        window.messages[window.messages.length - 1]?.files ? `（添付：${[...new Set(window.messages[window.messages.length - 1].files!.map((f) => f.name.replace(/（\d+ ページ）$/, "")))].join("、")}）` : ""
      }`,
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
