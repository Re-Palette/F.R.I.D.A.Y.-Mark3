"use client";

/**
 * 会話ループの状態管理。
 *   話しかける → すぐ反応 → ストリーミング表示 → 履歴を保持 → また話しかける
 *
 * - Gemini は数十文字の塊で届くため、受信分をフレームごとに少しずつ流して表示する
 *   （溜まっている量に応じて速度を上げるので、遅延はほぼ増えない）。
 * - 応答中に次の発言を送ると、今の応答を止めてすぐ次へ進む。
 * - 会話履歴はセッション中ブラウザ側（sessionStorage）に保持し、送信のたびにサーバーへ渡す。
 *   何件を Gemini に渡すかはサーバー側（src/memory/context.ts）が上限をかけて決める。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { ActionKind, ChatFile, ChatImage, ChatMessage, DocKind, StreamEvent } from "@/core/types";
import { saveDocFiles } from "@/lib/doc-export";
import { amazonMusicState, musicReply, runAmazonMusic } from "@/lib/amazon-music";
import { asksForMusic, quickMusicCommand } from "@/lib/music";
import { startFocus, stopFocus } from "@/lib/focus";
import { clearHologram, requestHologram } from "@/lib/hologram-model";
import { closeTabs, openTab, TAB_BLOCKED } from "@/lib/tabs";
import { REMINDERS_CHANGED } from "./useReminders";
import { useSessionSync } from "./useSessionSync";
import { beginLocalWork, currentRoute, localReadyForQuickChat, markGeminiFailed, markLocalFailed, probeRoute } from "@/lib/ai-router";
import { runLocalConversation, runQuickChat } from "@/lib/offline-core";
import { localAiPrefs } from "@/lib/local-ai";
import { isQuickChat } from "@/lib/quick-chat";
import { calendarForChat } from "@/lib/calendar-cache";
import { getAiMode } from "@/lib/ai-mode";
import { requestCreation } from "@/lib/karen-controller";
import { shouldFallback } from "@/llm/provider";

export interface UiError {
  code: string;
  message: string;
  retryable: boolean;
}

export interface UiMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: number;
  status: "streaming" | "done" | "stopped" | "error";
  error?: UiError;
  /** prepMs: サーバーで返答前の準備（記憶・予定・天気）にかかった時間 */
  meta?: { model?: string; ttftMs?: number; totalMs?: number; prepMs?: number };
  /** 音声で話しかけた発言への応答（読み上げ対象） */
  voice?: boolean;
  /** この返答で F.R.I.D.A.Y. が脳に覚えたこと */
  memories?: string[];
  /** この返答で Google カレンダーを操作した結果（失敗も含む） */
  calendar?: { action: "add" | "update" | "delete"; ok: boolean; title: string; when: string; error?: string }[];
  /** Web 検索で参照したページ */
  sources?: { title: string; uri: string }[];
  /** 脳への書き込み（ToDo・進捗・リマインダー）の結果 */
  actions?: { kind: ActionKind; ok: boolean; label: string; error?: string }[];
  /** この返答で書いた文書（脳に保存したもの） */
  documents?: { ok: boolean; title: string; path?: string; content?: string; updated?: boolean; error?: string; kind?: DocKind; files?: string[] }[];
  /** この返答で開いた（開こうとした）Web ページ・閉じたタブ */
  tabs?: { action: "open" | "close"; ok: boolean; label: string; url?: string; blocked?: boolean; error?: string }[];
  /** ニュースの設定を変えた結果 */
  newsSettings?: { ok: boolean; time?: string; topics?: string[]; error?: string };
  /** カメラで見せた 1 枚（画面に出す小さい版の data URL） */
  image?: string;
  /** 添えたファイル（画面に出す名前・種類・小さな画像） */
  files?: { name: string; kind: string; thumb?: string }[];
  /** Spotify を操作した結果 */
  music?: { ok: boolean; label: string; error?: string }[];
  /** Gmail に保存した下書き（送信はしていない） */
  drafts?: { ok: boolean; to: string; subject: string; error?: string }[];
}

/** 予定を追加したら右パネルなどに知らせるイベント名 */
export const CALENDAR_CHANGED = "friday:calendar-changed";
/** 設定が変わったので状態を読み直してほしいときのイベント名 */
export const STATUS_CHANGED = "friday:status-changed";
/** ToDo・進捗が変わったとき（右パネルを読み直す） */
export const TASKS_CHANGED = "friday:tasks-changed";

export interface SendOptions {
  /** 音声会話モード（読み上げ向けの短い話し言葉で返答させる） */
  voice?: boolean;
  /** カメラで撮った 1 枚（送る用と、画面に出す小さい版） */
  image?: { full: string; thumb: string };
  /** 添えたファイル（送る中身と、画面に出す名前など） */
  files?: { files: ChatFile[]; shown: { name: string; kind: string; thumb?: string }[]; attached?: { name: string; path?: string }[] };
  /** スマホの音声会話：録った声（文字はサーバーが起こして、届いたら発言の表示を置き換える） */
  audio?: { mimeType: string; data: string };
  /** 録った声から何も聞き取れなかったとき（発言も返答も出さずに、聞き取りに戻る） */
  onNoSpeech?: () => void;
}

/** 声で話しかけて、まだ文字になっていない発言の表示 */
export const HEARING_PLACEHOLDER = "…";

export type ChatPhase = "idle" | "waiting" | "streaming";
/** F.R.I.D.A.Y. が今していること（HOME の THINK / SEARCH / CONNECT / CREATE 表示） */
export type ChatStage = "connect" | "think" | "search" | null;

export interface LastRunStats {
  ttftMs?: number;
  totalMs?: number;
  contextMessages?: number;
  model?: string;
}

const STORAGE_KEY = "friday.session.v1";

function uid(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

/**
 * カメラの画像（送る用の大きい版）。会話の保存（sessionStorage）には入れず、ここに少しだけ持つ。
 * 送るのは最新のユーザー発言の画像だけ（サーバーも最新以外は受け取らない）。
 */
const fullImages = new Map<string, string>();

/** "data:image/jpeg;base64,xxxx" → { mimeType, data } */
function toChatImage(dataUrl: string | undefined): ChatImage | undefined {
  const m = /^data:(image\/(?:jpeg|png|webp));base64,(.+)$/.exec(dataUrl ?? "");
  return m ? { mimeType: m[1] as ChatImage["mimeType"], data: m[2] } : undefined;
}

/**
 * 添えたファイルの中身（送る用）。会話の保存（sessionStorage）には入れず、ここに持つ。
 * 続けて「この表の合計は？」などと聞けるよう、ファイルを添えた最後の発言の分は、その後の質問でも送り直す（直近 10 件まで）。
 */
const fullFiles = new Map<string, ChatFile[]>();
/** その発言で新しく添えたファイルの名前と、脳に保存した原本の場所（要点を「資料」に保存するため。その発言の送信のときだけ渡す） */
const attachedFiles = new Map<string, { name: string; path?: string }[]>();
/** 録った声（まだ文字になっていない最新の発言の分だけ） */
const fullAudio = new Map<string, { mimeType: string; data: string }>();

function toApiHistory(messages: UiMessage[]): ChatMessage[] {
  const list = messages.filter((m) => m.status !== "error" && m.content.trim());
  let withFiles = -1;
  for (let i = list.length - 1; i >= Math.max(0, list.length - 10); i--) {
    if (list[i].role === "user" && fullFiles.has(list[i].id)) {
      withFiles = i;
      break;
    }
  }
  return list.map((m, i) => {
    const out: ChatMessage = { role: m.role, content: m.content };
    const image = i === list.length - 1 && m.role === "user" ? toChatImage(fullImages.get(m.id)) : undefined;
    if (image) out.image = image;
    if (i === withFiles) out.files = fullFiles.get(m.id);
    if (i === list.length - 1 && attachedFiles.has(m.id)) out.attached = attachedFiles.get(m.id);
    // 録った声だけの発言は、文字の代わりに声を送る（サーバーが文字にする）
    const audio = i === list.length - 1 && m.role === "user" ? fullAudio.get(m.id) : undefined;
    if (audio) {
      out.content = "";
      out.audio = audio;
    }
    return out;
  });
}

function loadSession(): UiMessage[] {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as UiMessage[];
    return Array.isArray(parsed)
      ? parsed.map((m) => (m.status === "streaming" ? { ...m, status: "stopped" } : m))
      : [];
  } catch {
    return [];
  }
}

const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff;

/**
 * このフレームで表示を進める文字数（経過時間ベースなので、端末のフレームレートに左右されない）。
 * 塊が届く間隔（avgGap）を学習し、次の塊が届く頃にちょうど出し切る速度で流す
 * → 「一気に出て止まる」を繰り返さず、一定のペースで文字が流れ続ける。
 * 受信完了後や溜まりすぎたときは速めて、遅延を増やさない。
 */
function revealStep(backlog: number, dt: number, avgGap: number, sinceLast: number, streamDone: boolean): number {
  if (streamDone) return Math.max(3, Math.ceil((backlog * dt) / 150));
  const remainingMs = Math.max(dt, avgGap * 1.1 - sinceLast);
  let step = Math.ceil((backlog * dt) / remainingMs);
  if (backlog > 240) step = Math.max(step, Math.ceil((backlog * dt) / 400));
  return Math.max(1, step);
}

export function useChat() {
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [phase, setPhase] = useState<ChatPhase>("idle");
  const [stage, setStage] = useState<ChatStage>(null);
  // 返答が終わったら段階の表示も消す
  useEffect(() => {
    if (phase === "idle") setStage(null);
  }, [phase]);
  const [lastRun, setLastRun] = useState<LastRunStats>({});
  const [lastErrorCode, setLastErrorCode] = useState<string | null>(null);
  const [hydrated, setHydrated] = useState(false);

  /** 常に最新のメッセージ（非同期処理から同期的に読むための正本） */
  const store = useRef<UiMessage[]>([]);
  const abortRef = useRef<AbortController | null>(null);
  const runningRef = useRef<Promise<void> | null>(null);

  const update = useCallback((fn: (prev: UiMessage[]) => UiMessage[]) => {
    store.current = fn(store.current);
    setMessages(store.current);
  }, []);

  const patch = useCallback(
    (id: string, fn: (m: UiMessage) => UiMessage) => update((prev) => prev.map((m) => (m.id === id ? fn(m) : m))),
    [update],
  );

  // セッション復元（ハイドレーション後）
  useEffect(() => {
    store.current = loadSession();
    setMessages(store.current);
    setHydrated(true);
  }, []);

  // セッション保存（ストリーミング中は負荷を避けて保存しない）
  useEffect(() => {
    if (!hydrated || phase !== "idle") return;
    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(messages));
    } catch {
      /* private mode 等では保存しない */
    }
  }, [messages, phase, hydrated]);

  // スマホとパソコンで同じ会話を続ける（脳を通して同期）
  const replace = useCallback((list: UiMessage[]) => update(() => list), [update]);
  const sync = useSessionSync({ hydrated, phase, messages, store, replace });

  const run = useCallback(
    async (history: UiMessage[], opts: SendOptions = {}) => {
      const assistantId = uid();
      const startedAt = performance.now();
      const controller = new AbortController();
      abortRef.current = controller;

      update(() => [
        ...history,
        {
          id: assistantId,
          role: "assistant",
          content: "",
          createdAt: Date.now(),
          status: "streaming",
          voice: opts.voice || undefined,
        },
      ]);
      setPhase("waiting");
      setLastErrorCode(null);

      /* ---- 滑らかな表示（受信済み received のうち shown 文字まで表示） ---- */
      let received = "";
      let shown = 0;
      let lastDeltaAt = 0;
      let lastTickAt = 0;
      let avgGap = 120; // 塊が届く平均間隔 (ms)
      let timer = 0;
      let timerIsRaf = false;
      let streamDone = false;
      let settled = false;
      let onRevealed: (() => void) | null = null;
      let settle!: () => void;
      const revealed = new Promise<void>((resolve) => (settle = resolve));

      const cancelTimer = () => {
        if (!timer) return;
        if (timerIsRaf) cancelAnimationFrame(timer);
        else clearTimeout(timer);
        timer = 0;
      };
      const schedule = () => {
        if (timer) return;
        // 非表示タブでは requestAnimationFrame が止まるのでタイマーで進める
        timerIsRaf = !document.hidden;
        timer = timerIsRaf ? requestAnimationFrame(tick) : window.setTimeout(tick, 60);
      };
      function tick() {
        timer = 0;
        if (shown < received.length) {
          if (document.hidden || controller.signal.aborted) {
            shown = received.length;
          } else {
            const now = performance.now();
            const dt = Math.min(100, Math.max(8, lastTickAt ? now - lastTickAt : 16));
            lastTickAt = now;
            // 音声会話は読み上げを最優先: 表示の演出を省き、届いた分をすぐ出す（読み上げに即渡る）
            // ローカル AI（PC の CPU で答えている）のときも演出を省く（毎フレームの描き直しで CPU を取り合わないように）
            const step = opts.voice || instantReveal
              ? received.length - shown
              : revealStep(received.length - shown, dt, avgGap, now - lastDeltaAt, streamDone);
            shown = Math.min(received.length, shown + step);
            if (shown < received.length && isHighSurrogate(received.charCodeAt(shown - 1))) shown++;
          }
          const text = received.slice(0, shown);
          patch(assistantId, (m) => ({ ...m, content: text }));
        }
        if (shown < received.length) schedule();
        else lastTickAt = 0;
        if (shown >= received.length && streamDone && onRevealed) {
          const fn = onRevealed;
          onRevealed = null;
          fn();
        }
      }
      /** 表示が追いついてから確定する（正常終了） */
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        streamDone = true;
        onRevealed = () => {
          fn();
          settle();
        };
        schedule();
      };
      /** 受信済みをすべて即表示して確定する（エラー・停止） */
      const finishNow = (fn: () => void) => {
        if (settled) return;
        settled = true;
        cancelTimer();
        streamDone = true;
        onRevealed = null;
        shown = received.length;
        fn();
        settle();
      };
      // 表示の途中で停止されたら残りを一気に出す
      controller.signal.addEventListener("abort", () => {
        if (streamDone) schedule();
      });

      let ttftMs: number | undefined;
      let model: string | undefined;
      /** 表示の演出（1 文字ずつ流す）を省くか */
      let instantReveal = false;

      const fail = (error: UiError) =>
        finishNow(() => {
          const text = received;
          patch(assistantId, (m) => ({ ...m, content: text, status: "error", error }));
          setLastErrorCode(error.code);
        });

      try {
        // 音楽の話のときだけ、Amazon Music の状態（拡張機能の有無・流れている曲）を一緒に送る
        const lastUser = [...history].reverse().find((m) => m.role === "user")?.content ?? "";
        const music = asksForMusic(lastUser) ? await amazonMusicState().catch(() => undefined) : undefined;
        const calendar = calendarForChat();
        // 「止めて」「次の曲」などの短い操作は、AI に聞かずにその場で Amazon Music を操作する（声ですぐ効くように）
        const quick = music?.now ? quickMusicCommand(lastUser) : null;
        if (quick && (!quick.ifPlaying || music?.now?.playing)) {
          const r = await runAmazonMusic(quick.cmd);
          if (r.ok) {
            ttftMs = Math.round(performance.now() - startedAt);
            setPhase("streaming");
            received = musicReply(quick.cmd, r);
            patch(assistantId, (m) => ({ ...m, music: [...(m.music ?? []), r] }));
            finish(() => {
              const text = received;
              const totalMs = Math.round(performance.now() - startedAt);
              patch(assistantId, (m) => ({ ...m, content: text, status: "done", meta: { model: "local", ttftMs, totalMs } }));
              setLastRun((s) => ({ ...s, ttftMs, totalMs, model: "local" }));
            });
            await revealed;
            if (abortRef.current === controller) abortRef.current = null;
            return;
          }
        }
        const apiHistory = toApiHistory(history);
        /** いまローカル AI（Ollama）で答えているか */
        let local = false;
        /** サーバー（Gemini）が使えなかったので、ローカル AI で答え直す */
        let switchToLocal = currentRoute().route === "offline";
        const handle = (event: StreamEvent) => {
          switch (event.type) {
            case "transcript": {
              // 録った声を文字にした結果：発言の表示を置き換える。何も聞き取れなければ、発言ごと取り消して聞き取りに戻る
              const userId = history[history.length - 1]?.id;
              if (userId) fullAudio.delete(userId);
              if (!event.text.trim()) {
                finishNow(() => update((prev) => prev.filter((m) => m.id !== userId && m.id !== assistantId)));
                opts.onNoSpeech?.();
                break;
              }
              if (userId) patch(userId, (m) => ({ ...m, content: event.text }));
              break;
            }
            case "meta":
              model = event.model;
              setLastRun((s) => ({ ...s, model: event.model, contextMessages: event.contextMessages }));
              break;
            case "delta":
              if (ttftMs === undefined) {
                ttftMs = Math.round(performance.now() - startedAt);
                setPhase("streaming");
              }
              {
                const now = performance.now();
                if (lastDeltaAt) avgGap = Math.min(600, Math.max(30, avgGap * 0.7 + (now - lastDeltaAt) * 0.3));
                lastDeltaAt = now;
              }
              received += event.text;
              schedule();
              break;
            case "calendar": {
              const { action, ok, title, when, error } = event;
              patch(assistantId, (m) => ({ ...m, calendar: [...(m.calendar ?? []), { action, ok, title, when, error }] }));
              if (ok) window.dispatchEvent(new Event(CALENDAR_CHANGED));
              break;
            }
            case "document": {
              const { ok, title, path, content, updated, error, kind } = event;
              patch(assistantId, (m) => ({ ...m, documents: [...(m.documents ?? []), { ok, title, path, content, updated, error, kind }] }));
              // 資料の PDF・スライドは、脳にも PDF（スライドは PowerPoint も）を保存する
              if (ok && kind && path) {
                void saveDocFiles({ title, content, kind, path })
                  .then((files) =>
                    patch(assistantId, (m) => ({ ...m, documents: m.documents?.map((d) => (d.path === path ? { ...d, files } : d)) })),
                  )
                  .catch(() => {});
              }
              break;
            }
            case "action": {
              const { kind, ok, label, error } = event;
              patch(assistantId, (m) => ({ ...m, actions: [...(m.actions ?? []), { kind, ok, label, error }] }));
              if (ok) window.dispatchEvent(new Event(kind === "reminder" ? REMINDERS_CHANGED : TASKS_CHANGED));
              break;
            }
            case "news-settings": {
              const { ok, time, topics, error } = event;
              patch(assistantId, (m) => ({ ...m, newsSettings: { ok, time, topics, error } }));
              window.dispatchEvent(new Event(STATUS_CHANGED));
              break;
            }
            case "browser": {
              if (event.action === "open") {
                const { ok, url, label, error } = event;
                if (ok && url) {
                  void openTab(url, label).then((opened) =>
                    patch(assistantId, (m) => ({ ...m, tabs: [...(m.tabs ?? []), { action: "open", ok, label, url, blocked: !opened }] })),
                  );
                } else {
                  patch(assistantId, (m) => ({ ...m, tabs: [...(m.tabs ?? []), { action: "open", ok, label, error }] }));
                }
              } else {
                void closeTabs(event.target).then(({ closed, reason }) => {
                  const label = closed ? `${closed} 件のタブ` : reason ? "閉じられませんでした" : "閉じられるタブがありません";
                  patch(assistantId, (m) => ({ ...m, tabs: [...(m.tabs ?? []), { action: "close", ok: closed > 0, label, error: reason }] }));
                  if (reason) window.dispatchEvent(new CustomEvent(TAB_BLOCKED, { detail: { reason } }));
                });
              }
              break;
            }
            case "stage":
              setStage(event.stage);
              break;
            case "hologram":
              // 返答の文は、ホログラムの拡大表示に説明の字幕として出す
              // K.A.R.E.N. のモードでは、制作ワークスペースで作る（F.R.I.D.A.Y. のホログラムは使わない）
              if (event.subject && getAiMode() === "karen") requestCreation(event.subject);
              else if (event.subject) void requestHologram(event.subject, { explainFor: assistantId });
              else clearHologram();
              break;
            case "sources": {
              const { sources } = event;
              patch(assistantId, (m) => ({ ...m, sources }));
              break;
            }
            case "music": {
              const { ok, label, error, command } = event;
              if (command) {
                // Amazon Music：拡張機能に頼んで、開いている Web プレーヤーを操作する
                void runAmazonMusic(command).then((r) => patch(assistantId, (m) => ({ ...m, music: [...(m.music ?? []), r] })));
              } else {
                patch(assistantId, (m) => ({ ...m, music: [...(m.music ?? []), { ok, label, error }] }));
              }
              break;
            }
            case "focus": {
              // 集中モード：タイマーを動かし、頼まれたら作業用の音楽をかける（Amazon Music の拡張機能があるとき）
              if (event.stop) stopFocus();
              else if (event.start) {
                const st = startFocus(event.start.minutes, event.start.task ?? "", event.start.music !== false);
                if (st.music) void runAmazonMusic({ action: "play", query: "集中 作業用 BGM", kind: "playlist" }).catch(() => {});
              }
              break;
            }
            case "mail-draft": {
              const { ok, to, subject, error } = event;
              patch(assistantId, (m) => ({ ...m, drafts: [...(m.drafts ?? []), { ok, to, subject, error }] }));
              break;
            }
            case "memory":
              patch(assistantId, (m) => ({ ...m, memories: [...(m.memories ?? []), event.text] }));
              break;
            case "done": {
              const totalMs = Math.round(performance.now() - startedAt);
              if (!received.trim()) {
                fail({
                  code: "EMPTY",
                  message: "F.R.I.D.A.Y. から応答がありませんでした。もう一度試してください。",
                  retryable: true,
                });
                break;
              }
              finish(() => {
                const text = received;
                const prepMs = event.prepMs;
                patch(assistantId, (m) => ({ ...m, content: text, status: "done", meta: { model, ttftMs, totalMs, prepMs } }));
                setLastRun((s) => ({ ...s, ttftMs, totalMs, model }));
              });
              break;
            }
            case "error":
              // Gemini に届かない・使えない（まだ一文字も出していない）→ ローカル AI で答え直す
              if (!local && !received && shouldFallback(event.code) && !controller.signal.aborted) {
                switchToLocal = true;
                break;
              }
              fail({ code: event.code, message: event.message, retryable: event.retryable });
              break;
          }
        };

        /** ローカル AI（Offline Core）で答える。イベントの形はサーバーと同じなので、表示はそのまま */
        const runLocal = async () => {
          local = true;
          instantReveal = true;
          const endWork = beginLocalWork();
          try {
            await runLocalInner();
          } finally {
            endWork();
          }
        };
        const runLocalInner = async () => {
          const last = apiHistory[apiHistory.length - 1];
          if (last?.audio && !last.content.trim()) {
            fail({ code: "LOCAL_AI_UNAVAILABLE", message: "オフラインのため、録った声を文字にできません。文字で入力するか、オンラインに戻ってから話しかけてください。", retryable: true });
            return;
          }
          for await (const event of runLocalConversation(apiHistory, { voice: Boolean(opts.voice), signal: controller.signal })) {
            if (event.type === "error") {
              // ローカル AI にも届かない → 状態を確かめ直す（表示を「LOCAL AI UNAVAILABLE」に）
              const offline = currentRoute().route === "offline" && currentRoute().why === "network";
              handle(offline ? event : { ...event, message: `Gemini にもローカル AI にも接続できません。${event.message}` });
              void probeRoute();
            } else handle(event);
          }
          if (controller.signal.aborted) throw new DOMException("aborted", "AbortError");
          if (!settled) fail({ code: "LOCAL_AI_UNAVAILABLE", message: "ローカル AI の応答が途中で切れました。もう一度試してください。", retryable: true });
        };

        // 短い日常会話（あいさつ・お礼・相づちなど）は、オンライン中でもローカル AI（Ollama など）で答える。
        // ローカル AI にツールの権限は無い。失敗したら、まだ何も表示していないときだけ Gemini で答え直す（同じ発言を二重に送らない）
        const latestMsg = apiHistory[apiHistory.length - 1];
        const prevAssistant = [...apiHistory.slice(0, -1)].reverse().find((m) => m.role === "assistant")?.content;
        // オフライン中も、短い日常会話は短い指示で答える（長い指示を読ませないので、軽い PC でも速い）
        const offlineNow = switchToLocal;
        if (
          (currentRoute().route === "online" || offlineNow) &&
          (offlineNow ? localAiPrefs().quickLocal : localReadyForQuickChat()) &&
          isQuickChat({ text: latestMsg?.content ?? "", previousAssistant: prevAssistant, hasAttachment: Boolean(latestMsg?.image || latestMsg?.files?.length || latestMsg?.audio) })
        ) {
          let failure: Extract<StreamEvent, { type: "error" }> | null = null;
          instantReveal = true;
          const endWork = beginLocalWork();
          try {
            // オフライン中は答え直す先（Gemini）が無いので、最初の文字まで長めに待つ
            for await (const event of runQuickChat(apiHistory, { voice: Boolean(opts.voice), signal: controller.signal, firstTokenMs: offlineNow ? 60_000 : undefined })) {
              if (event.type === "error") {
                failure = event;
                break;
              }
              handle(event);
            }
          } finally {
            endWork();
            if (failure && !received.trim()) instantReveal = false;
          }
          if (controller.signal.aborted) throw new DOMException("aborted", "AbortError");
          if (failure) {
            markLocalFailed(failure.code === "QUICK_NO_MODEL" ? "no-model" : failure.code === "QUICK_TIMEOUT" ? "timeout" : failure.code === "QUICK_UNAVAILABLE" ? "unavailable" : "error");
            // 途中まで表示していたら答え直さない（同じ返事が二つにならないように）。そこまでを残してエラーを出す。
            // オフライン中も答え直さない（同じローカル AI にもう一度長い指示を読ませると、さらに待たせるため）
            if (received.trim() || offlineNow) fail({ code: failure.code, message: failure.message, retryable: true });
            else {
              model = undefined;
              setPhase("waiting");
            }
          }
        }

        if (!switchToLocal && !settled) {
          let res: Response | null = null;
          try {
            res = await fetch("/api/chat", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                messages: apiHistory,
                mode: opts.voice ? "voice" : "text",
                ...(music ? { music } : {}),
                // 予定の控え（サーバーが Google から間に合わなかったときの予備）
                ...(calendar ? { calendar } : {}),
                // K.A.R.E.N. のモードなら、クリエイティブ担当として答えてもらう
                ...(getAiMode() === "karen" ? { persona: "karen" } : {}),
              }),
              signal: controller.signal,
            });
          } catch (err) {
            if (controller.signal.aborted) throw err;
            switchToLocal = true; // サーバーに届かない（ネットが切れた）
            markGeminiFailed("network");
          }
          if (res && (!res.ok || !res.body)) {
            let err: UiError = {
              code: "UPSTREAM_ERROR",
              message: `サーバーエラーが発生しました（${res.status}）。`,
              retryable: true,
            };
            try {
              const json = (await res.json()) as StreamEvent;
              if (json.type === "error") err = { code: json.code, message: json.message, retryable: json.retryable };
            } catch {
              /* noop */
            }
            // サーバーには届いたが Gemini が使えない（キー・枠など）→ ローカル AI へ。ログイン切れ・不正な依頼はそのまま知らせる
            if (shouldFallback(err.code) && res.status !== 401) {
              switchToLocal = true;
              markGeminiFailed("gemini");
            } else fail(err);
          } else if (res?.body) {
            const reader = res.body.getReader();
            const decoder = new TextDecoder();
            let pending = "";
            try {
              while (!switchToLocal) {
                const { value, done } = await reader.read();
                if (done) break;
                pending += decoder.decode(value, { stream: true });
                let nl: number;
                while ((nl = pending.indexOf("\n")) >= 0) {
                  const line = pending.slice(0, nl).trim();
                  pending = pending.slice(nl + 1);
                  if (!line) continue;
                  try {
                    handle(JSON.parse(line) as StreamEvent);
                  } catch {
                    /* 壊れた行は無視 */
                  }
                }
              }
            } catch (err) {
              // まだ何も表示していないうちに通信が切れたら、ローカル AI で答え直す
              if (controller.signal.aborted || received) throw err;
              switchToLocal = true;
              markGeminiFailed("network");
            }
            if (switchToLocal) {
              void reader.cancel().catch(() => {});
              if (!controller.signal.aborted) markGeminiFailed("gemini");
            } else if (!settled) {
              markGeminiFailed("network");
              fail({ code: "NETWORK_ERROR", message: "通信が途中で切れました。もう一度試してください。", retryable: true });
            }
          }
        }
        if (switchToLocal && !settled) await runLocal();
      } catch (err) {
        if (controller.signal.aborted) {
          finishNow(() => {
            const text = received;
            patch(assistantId, (m) =>
              text.trim()
                ? { ...m, content: text, status: "stopped", meta: { model, ttftMs } }
                : { ...m, status: "error", error: { code: "ABORTED", message: "応答を停止しました。", retryable: true } },
            );
          });
        } else {
          console.error(err);
          fail({
            code: "NETWORK_ERROR",
            message: "F.R.I.D.A.Y. のサーバーに接続できませんでした。サーバーが起動しているか確認してください。",
            retryable: true,
          });
        }
      }

      await revealed;
      if (abortRef.current === controller) abortRef.current = null;
    },
    [patch, update],
  );

  /** 直列実行：前の応答が残っていれば止めてから次を走らせる */
  const enqueue = useCallback(
    (build: (current: UiMessage[]) => UiMessage[] | null, opts: SendOptions = {}) => {
      const job = (async () => {
        const previous = runningRef.current;
        if (previous) {
          abortRef.current?.abort();
          await previous;
        }
        const history = build(store.current);
        if (!history) return;
        await run(history, opts);
      })();
      runningRef.current = job;
      setPhase((p) => (p === "idle" ? "waiting" : p));
      void job.finally(() => {
        if (runningRef.current === job) {
          runningRef.current = null;
          setPhase("idle");
        }
      });
    },
    [run],
  );

  const send = useCallback(
    (text: string, opts: SendOptions = {}) => {
      const content = text.trim() || (opts.audio ? HEARING_PLACEHOLDER : "");
      if (!content) return false;
      const id = uid();
      if (opts.audio) {
        fullAudio.clear(); // 送るのはこの 1 回分だけ
        fullAudio.set(id, opts.audio);
      }
      if (opts.image) {
        fullImages.set(id, opts.image.full);
        // 古い画像は持ち続けない（送るのは最新の 1 枚だけ）
        while (fullImages.size > 3) fullImages.delete(fullImages.keys().next().value!);
      }
      if (opts.files?.files.length) {
        fullFiles.set(id, opts.files.files);
        // 古いファイルは持ち続けない（送り直すのは最後に添えた分だけ）
        while (fullFiles.size > 3) fullFiles.delete(fullFiles.keys().next().value!);
        if (opts.files.attached?.length) {
          attachedFiles.set(id, opts.files.attached);
          while (attachedFiles.size > 3) attachedFiles.delete(attachedFiles.keys().next().value!);
        }
      }
      enqueue(
        (current) => [
          ...current,
          {
            id,
            role: "user",
            content,
            createdAt: Date.now(),
            status: "done",
            ...(opts.image ? { image: opts.image.thumb } : {}),
            ...(opts.files?.shown.length ? { files: opts.files.shown } : {}),
          },
        ],
        opts,
      );
      return true;
    },
    [enqueue],
  );

  /** 失敗した応答をやり直す */
  const retry = useCallback(() => {
    enqueue((current) => {
      const list = [...current];
      while (list.length && list[list.length - 1].role === "assistant") list.pop();
      return list.length ? list : null;
    });
  }, [enqueue]);

  const stop = useCallback(() => abortRef.current?.abort(), []);

  const clear = useCallback(() => {
    abortRef.current?.abort();
    update(() => []);
    setLastRun({});
    setLastErrorCode(null);
    try {
      sessionStorage.removeItem(STORAGE_KEY);
    } catch {
      /* noop */
    }
    sync.markCleared();
  }, [sync, update]);

  /** リアルタイム音声会話の発言・返事を会話ログに足す（同じ id は書き換え）。読み上げはしない（声はもう流れている） */
  const upsertLive = useCallback(
    (turn: { id: string; role: "user" | "assistant"; text: string; done: boolean; stopped?: boolean }) =>
      update((prev) => {
        const i = prev.findIndex((m) => m.id === turn.id);
        const msg: UiMessage = {
          id: turn.id,
          role: turn.role,
          content: turn.text,
          createdAt: i >= 0 ? prev[i].createdAt : Date.now(),
          status: !turn.done ? "streaming" : turn.stopped ? "stopped" : "done",
          ...(turn.role === "assistant" ? { meta: { model: "LIVE" } } : {}),
        };
        return i >= 0 ? prev.map((m, j) => (j === i ? msg : m)) : [...prev, msg];
      }),
    [update],
  );

  return { messages, phase, stage, lastRun, lastErrorCode, send, retry, stop, clear, upsertLive };
}
