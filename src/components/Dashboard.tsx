"use client";

/**
 * F.R.I.D.A.Y. Mark3 メイン画面。
 * HUB（Core + Agent カード）と CHAT（会話ログ）を中央ステージで切り替える。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { StatusResponse } from "@/core/types";
import { useChat } from "@/hooks/useChat";
import { useVoice } from "@/hooks/useVoice";
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
  const [tts, setTts] = useState<StatusResponse["tts"]>({ provider: "browser" });

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/status", { cache: "no-store" });
      if (res.status === 401) {
        window.location.href = "/login";
        return;
      }
      const json = (await res.json()) as StatusResponse;
      const chat = json.agents.chat;
      setStatus(chat?.status === "online" ? "online" : "offline");
      setModel(chat?.model);
      setReason(chat?.reason);
      setMaxContext(json.context.maxMessages);
      if (json.tts) setTts(json.tts);
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

  return { status, model, maxContext, reason, tts, refresh, setStatus };
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
    [chat.send],
  );

  // 入力中に Gemini への接続を温める（サーバー側でも間引くが、ここでも 2 秒に 1 回まで）
  const lastWarm = useRef(0);
  const warm = useCallback(() => {
    const now = Date.now();
    if (now - lastWarm.current < 2000 || agent.status !== "online") return;
    lastWarm.current = now;
    void fetch("/api/warm", { method: "POST", keepalive: true }).catch(() => {});
  }, [agent.status]);

  /* ---- 音声会話 ---- */
  const { send: chatSend, stop: chatStop } = chat;
  const onVoiceCommand = useCallback(
    (text: string) => {
      if (chatSend(text, { voice: true })) setView("chat");
    },
    [chatSend],
  );
  const voice = useVoice({ onCommand: onVoiceCommand, cloudVoice: agent.tts.provider === "elevenlabs" });
  const { speak, cancelSpeech, replyFinished } = voice;

  // 音声で話しかけた発言への応答を、届いた文から順に読み上げる
  const lastMsg = chat.messages[chat.messages.length - 1];
  useEffect(() => {
    if (!lastMsg || lastMsg.role !== "assistant" || !lastMsg.voice) return;
    const base = { id: lastMsg.id, createdAt: lastMsg.createdAt };
    if (lastMsg.status === "streaming") speak({ ...base, text: lastMsg.content, done: false });
    else if (lastMsg.status === "done" || lastMsg.status === "stopped")
      speak({ ...base, text: lastMsg.content, done: true });
    else if (lastMsg.status === "error") {
      if (lastMsg.error?.code === "ABORTED") replyFinished();
      else speak({ ...base, text: lastMsg.error?.message ?? "エラーが発生しました。", done: true });
    }
  }, [lastMsg, speak, replyFinished]);

  // ElevenLabs の設定に問題があるときは、音声会話をオンにした時点で一度だけ知らせる
  const [ttsNoticeClosed, setTtsNoticeClosed] = useState(false);
  const ttsNotice =
    voice.state !== "off" && agent.tts.reason && !ttsNoticeClosed ? `${agent.tts.reason}（今はブラウザの声で読み上げます）` : null;

  const stopAll = useCallback(() => {
    chatStop();
    cancelSpeech();
  }, [chatStop, cancelSpeech]);

  const openChat = useCallback(() => {
    setView("chat");
    composerRef.current?.focus();
  }, []);

  const navigate = useCallback((v: View) => (v === "chat" ? openChat() : setView(v)), [openChat]);
  const backToHub = useCallback(() => setView("home"), []);

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
        onNavigate={navigate}
        chatStatus={agent.status}
        model={agent.model}
        lastRun={chat.lastRun}
        sessionCount={chat.messages.length}
        maxContext={agent.maxContext}
      />

      <main className="center">
        <div className="stage" data-view={view} data-phase={chat.phase} data-voice={voice.state}>
          <Orbit
            phase={chat.phase}
            chatStatus={agent.status}
            onOpenChat={openChat}
            hidden={inChat}
            model={agent.model}
            context={`${chat.lastRun.contextMessages ?? 0} / ${agent.maxContext} MSG`}
            voice={agent.tts.provider === "elevenlabs" ? "ELEVENLABS" : "BROWSER"}
          />
          <Conversation
            messages={chat.messages}
            phase={chat.phase}
            onRetry={chat.retry}
            onSuggest={send}
            onBack={backToHub}
            onClear={chat.clear}
            hidden={!inChat}
            voiceState={voice.state}
          />
        </div>

        {agent.status === "offline" && (
          <div className="banner" role="status">
            <b>CHAT AI OFFLINE</b>
            <span>
              {agent.reason ?? "Gemini に接続できません。"}
            </span>
            <button type="button" className="ghost-btn" onClick={() => void agent.refresh()}>
              再確認
            </button>
          </div>
        )}

        {ttsNotice && !voice.error && (
          <div className="banner" role="status">
            <b>VOICE</b>
            <span>{ttsNotice}</span>
            <button type="button" className="ghost-btn" onClick={() => setTtsNoticeClosed(true)}>
              閉じる
            </button>
          </div>
        )}

        {voice.error && (
          <div className="banner" role="alert">
            <b>VOICE</b>
            <span>{voice.error}</span>
            <button type="button" className="ghost-btn" onClick={voice.dismissError}>
              閉じる
            </button>
          </div>
        )}

        <Composer
          ref={composerRef}
          phase={chat.phase}
          disabled={false}
          onSend={send}
          onStop={stopAll}
          voiceState={voice.state}
          voiceInterim={voice.interim}
          onVoiceToggle={voice.toggle}
          onTalk={voice.talkNow}
          onTyping={warm}
        />
      </main>

      <RightPanel />
    </div>
  );
}
