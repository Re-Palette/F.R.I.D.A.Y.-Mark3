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
import type { ChatMessage, StreamEvent } from "@/core/types";

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
  /** ニュースの設定を変えた結果 */
  newsSettings?: { ok: boolean; time?: string; topics?: string[]; error?: string };
}

/** 予定を追加したら右パネルなどに知らせるイベント名 */
export const CALENDAR_CHANGED = "friday:calendar-changed";
/** 設定が変わったので状態を読み直してほしいときのイベント名 */
export const STATUS_CHANGED = "friday:status-changed";

export interface SendOptions {
  /** 音声会話モード（読み上げ向けの短い話し言葉で返答させる） */
  voice?: boolean;
}

export type ChatPhase = "idle" | "waiting" | "streaming";

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

function toApiHistory(messages: UiMessage[]): ChatMessage[] {
  return messages
    .filter((m) => m.status !== "error" && m.content.trim())
    .map((m) => ({ role: m.role, content: m.content }));
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
            const step = opts.voice
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

      const fail = (error: UiError) =>
        finishNow(() => {
          const text = received;
          patch(assistantId, (m) => ({ ...m, content: text, status: "error", error }));
          setLastErrorCode(error.code);
        });

      try {
        const res = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ messages: toApiHistory(history), mode: opts.voice ? "voice" : "text" }),
          signal: controller.signal,
        });

        if (!res.ok || !res.body) {
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
          fail(err);
        } else {
          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          let pending = "";

          const handle = (event: StreamEvent) => {
            switch (event.type) {
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
              case "news-settings": {
                const { ok, time, topics, error } = event;
                patch(assistantId, (m) => ({ ...m, newsSettings: { ok, time, topics, error } }));
                window.dispatchEvent(new Event(STATUS_CHANGED));
                break;
              }
              case "sources": {
                const { sources } = event;
                patch(assistantId, (m) => ({ ...m, sources }));
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
                fail({ code: event.code, message: event.message, retryable: event.retryable });
                break;
            }
          };

          while (true) {
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
          if (!settled) {
            fail({ code: "NETWORK_ERROR", message: "通信が途中で切れました。もう一度試してください。", retryable: true });
          }
        }
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
      const content = text.trim();
      if (!content) return false;
      enqueue(
        (current) => [...current, { id: uid(), role: "user", content, createdAt: Date.now(), status: "done" }],
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
  }, [update]);

  return { messages, phase, lastRun, lastErrorCode, send, retry, stop, clear };
}
