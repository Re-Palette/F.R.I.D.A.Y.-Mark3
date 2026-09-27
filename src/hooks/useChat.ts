"use client";

/**
 * 会話ループの状態管理。
 *   話しかける → すぐ反応 → ストリーミング表示 → 履歴を保持 → また話しかける
 *
 * 会話履歴はセッション中ブラウザ側（sessionStorage）に保持し、
 * 送信のたびにサーバーへ渡す。何件を Gemini に渡すかはサーバー側
 * （src/memory/context.ts）が上限をかけて決める。
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
  meta?: { model?: string; ttftMs?: number; totalMs?: number };
}

export type ChatPhase = "idle" | "waiting" | "streaming";

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

export interface LastRunStats {
  ttftMs?: number;
  totalMs?: number;
  contextMessages?: number;
  model?: string;
}

export function useChat() {
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [phase, setPhase] = useState<ChatPhase>("idle");
  const [lastRun, setLastRun] = useState<LastRunStats>({});
  const [lastErrorCode, setLastErrorCode] = useState<string | null>(null);

  const messagesRef = useRef<UiMessage[]>([]);
  const abortRef = useRef<AbortController | null>(null);
  const [hydrated, setHydrated] = useState(false);

  messagesRef.current = messages;

  // セッション復元（ハイドレーション後）
  useEffect(() => {
    setMessages(loadSession());
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

  const patch = useCallback((id: string, update: (m: UiMessage) => UiMessage) => {
    setMessages((prev) => prev.map((m) => (m.id === id ? update(m) : m)));
  }, []);

  const run = useCallback(
    async (history: UiMessage[]) => {
      const assistantId = uid();
      const startedAt = performance.now();
      const controller = new AbortController();
      abortRef.current = controller;

      setMessages([
        ...history,
        { id: assistantId, role: "assistant", content: "", createdAt: Date.now(), status: "streaming" },
      ]);
      setPhase("waiting");
      setLastErrorCode(null);

      // 描画は requestAnimationFrame 単位でまとめて反映（ヌルヌル・軽量）
      let buffer = "";
      let frame = 0;
      let ttftMs: number | undefined;
      let model: string | undefined;
      const flush = () => {
        frame = 0;
        const text = buffer;
        patch(assistantId, (m) => ({ ...m, content: text }));
      };
      const scheduleFlush = () => {
        if (!frame) frame = requestAnimationFrame(flush);
      };

      const fail = (error: UiError) => {
        if (frame) cancelAnimationFrame(frame);
        patch(assistantId, (m) => ({ ...m, content: buffer, status: "error", error }));
        setLastErrorCode(error.code);
      };

      try {
        const res = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ messages: toApiHistory(history) }),
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
          return;
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let pending = "";
        let finished = false;

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
              buffer += event.text;
              scheduleFlush();
              break;
            case "done": {
              finished = true;
              if (frame) cancelAnimationFrame(frame);
              const totalMs = Math.round(performance.now() - startedAt);
              const text = buffer;
              if (!text.trim()) {
                fail({ code: "EMPTY", message: "F.R.I.D.A.Y. から応答がありませんでした。もう一度試してください。", retryable: true });
                break;
              }
              patch(assistantId, (m) => ({
                ...m,
                content: text,
                status: "done",
                meta: { model, ttftMs, totalMs },
              }));
              setLastRun((s) => ({ ...s, ttftMs, totalMs, model }));
              break;
            }
            case "error":
              finished = true;
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
        if (!finished) {
          fail({ code: "NETWORK_ERROR", message: "通信が途中で切れました。もう一度試してください。", retryable: true });
        }
      } catch (err) {
        if (controller.signal.aborted) {
          if (frame) cancelAnimationFrame(frame);
          const text = buffer;
          patch(assistantId, (m) =>
            text.trim()
              ? { ...m, content: text, status: "stopped", meta: { model, ttftMs } }
              : { ...m, status: "error", error: { code: "ABORTED", message: "応答を停止しました。", retryable: true } },
          );
        } else {
          console.error(err);
          fail({
            code: "NETWORK_ERROR",
            message: "F.R.I.D.A.Y. のサーバーに接続できませんでした。サーバーが起動しているか確認してください。",
            retryable: true,
          });
        }
      } finally {
        if (abortRef.current === controller) abortRef.current = null;
        setPhase("idle");
      }
    },
    [patch],
  );

  const send = useCallback(
    (text: string) => {
      const content = text.trim();
      if (!content || abortRef.current) return false;
      const userMsg: UiMessage = { id: uid(), role: "user", content, createdAt: Date.now(), status: "done" };
      void run([...messagesRef.current, userMsg]);
      return true;
    },
    [run],
  );

  /** 失敗した応答をやり直す */
  const retry = useCallback(() => {
    if (abortRef.current) return;
    const list = [...messagesRef.current];
    while (list.length && list[list.length - 1].role === "assistant") list.pop();
    if (!list.length) return;
    void run(list);
  }, [run]);

  const stop = useCallback(() => abortRef.current?.abort(), []);

  const clear = useCallback(() => {
    abortRef.current?.abort();
    setMessages([]);
    setLastRun({});
    setLastErrorCode(null);
    try {
      sessionStorage.removeItem(STORAGE_KEY);
    } catch {
      /* noop */
    }
  }, []);

  return { messages, phase, lastRun, lastErrorCode, send, retry, stop, clear };
}
