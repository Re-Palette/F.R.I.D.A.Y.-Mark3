"use client";

/**
 * F.R.I.D.A.Y. Mark3 メイン画面。
 * HUB（Core + Agent カード）と CHAT（会話ログ）を中央ステージで切り替える。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { StatusResponse } from "@/core/types";
import { useChat } from "@/hooks/useChat";
import { Composer, type ComposerHandle } from "./Composer";
import { Conversation } from "./Conversation";
import { Header } from "./Header";
import { Orbit, type ChatAgentStatus } from "./Orbit";
import { RightPanel } from "./RightPanel";
import { Sidebar, type View } from "./Sidebar";

function useAgentStatus() {
  const [status, setStatus] = useState<ChatAgentStatus>("checking");
  const [model, setModel] = useState<string>();
  const [maxContext, setMaxContext] = useState(24);
  const [reason, setReason] = useState<string>();

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/status", { cache: "no-store" });
      const json = (await res.json()) as StatusResponse;
      const chat = json.agents.chat;
      setStatus(chat?.status === "online" ? "online" : "offline");
      setModel(chat?.model);
      setReason(chat?.reason);
      setMaxContext(json.context.maxMessages);
    } catch {
      setStatus("offline");
      setReason("サーバーに接続できません");
    }
  }, []);

  useEffect(() => {
    void refresh();
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refresh]);

  return { status, model, maxContext, reason, refresh, setStatus };
}

export function Dashboard() {
  const chat = useChat();
  const agent = useAgentStatus();
  const [view, setView] = useState<View>("home");
  const composerRef = useRef<ComposerHandle>(null);

  // セッション復元時に会話があればチャット表示から始める
  const restored = useRef(false);
  useEffect(() => {
    if (!restored.current && chat.messages.length > 0) {
      restored.current = true;
      setView("chat");
    }
  }, [chat.messages.length]);

  // API キー関連のエラーが出たらステータスを更新
  useEffect(() => {
    if (chat.lastErrorCode === "MISSING_API_KEY" || chat.lastErrorCode === "INVALID_API_KEY") {
      agent.setStatus("offline");
    } else if (chat.lastRun.ttftMs !== undefined && chat.lastErrorCode === null) {
      agent.setStatus("online");
    }
  }, [chat.lastErrorCode, chat.lastRun.ttftMs]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && view === "chat" && chat.phase === "idle") setView("home");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [view, chat.phase]);

  const send = useCallback(
    (text: string) => {
      const ok = chat.send(text);
      if (ok) setView("chat");
      return ok;
    },
    [chat],
  );

  const openChat = useCallback(() => {
    setView("chat");
    composerRef.current?.focus();
  }, []);

  const inChat = view === "chat";

  return (
    <div className="app">
      <div className="bg" aria-hidden="true">
        <div className="bg__circuit" />
        <div className="bg__scan" />
        <div className="bg__glow" />
        <div className="bg__streaks">
          <i />
          <i />
          <i />
          <i />
        </div>
      </div>

      <Header />

      <Sidebar
        view={view}
        onNavigate={(v) => (v === "chat" ? openChat() : setView(v))}
        chatStatus={agent.status}
        model={agent.model}
        lastRun={chat.lastRun}
        sessionCount={chat.messages.length}
        maxContext={agent.maxContext}
      />

      <main className="center">
        <div className="stage" data-view={view} data-phase={chat.phase}>
          <Orbit
            phase={chat.phase}
            chatStatus={agent.status}
            onOpenChat={openChat}
            hidden={inChat}
            model={agent.model}
            context={`${chat.lastRun.contextMessages ?? 0} / ${agent.maxContext} MSG`}
          />
          <Conversation
            messages={chat.messages}
            phase={chat.phase}
            onRetry={chat.retry}
            onSuggest={send}
            onBack={() => setView("home")}
            onClear={chat.clear}
            hidden={!inChat}
          />
        </div>

        {agent.status === "offline" && (
          <div className="banner" role="status">
            <b>CHAT AI OFFLINE</b>
            <span>
              {agent.reason === "GEMINI_API_KEY が未設定です"
                ? "Gemini APIキーが設定されていません。.env.local に GEMINI_API_KEY を設定してサーバーを再起動してください。"
                : (agent.reason ?? "Gemini に接続できません。")}
            </span>
            <button type="button" className="ghost-btn" onClick={() => void agent.refresh()}>
              再確認
            </button>
          </div>
        )}

        <Composer ref={composerRef} phase={chat.phase} disabled={false} onSend={send} onStop={chat.stop} />
      </main>

      <RightPanel />
    </div>
  );
}
