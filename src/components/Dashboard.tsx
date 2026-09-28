"use client";

/**
 * F.R.I.D.A.Y. Mark3 メイン画面。
 * HUB（Core + Agent カード）と CHAT（会話ログ）を中央ステージで切り替える。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { StatusResponse } from "@/core/types";
import { STATUS_CHANGED, useChat } from "@/hooks/useChat";
import { useVoice } from "@/hooks/useVoice";
import { Composer, type ComposerHandle } from "./Composer";
import { Conversation } from "./Conversation";
import { Header } from "./Header";
import { HomeDialog } from "./HomeDialog";
import { Orbit, type ChatAgentStatus } from "./Orbit";
import { RightPanel } from "./RightPanel";
import { Sidebar, type View } from "./Sidebar";

const CALENDAR_NOTICE: Record<string, string> = {
  connected: "Google カレンダーに接続しました。「フライデー、明日の予定は？」「明日 15 時に打ち合わせを入れて」のように話しかけてみてください。",
  denied: "Google カレンダーへの接続がキャンセルされました。",
  failed: "Google カレンダーに接続できませんでした。Google Cloud の設定（リダイレクト URI・テストユーザー）を確認して、もう一度お試しください。",
  "not-configured": "Google カレンダーの設定（GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET）がまだありません。",
};

/** Google から戻ってきたとき（?calendar=…）の結果を一度だけ表示する */
function useCalendarNotice() {
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    const url = new URL(window.location.href);
    const result = url.searchParams.get("calendar");
    if (!result) return;
    setNotice(CALENDAR_NOTICE[result] ?? null);
    url.searchParams.delete("calendar");
    url.searchParams.delete("reason");
    window.history.replaceState(null, "", url.pathname + url.search + url.hash);
  }, []);
  return [notice, () => setNotice(null)] as const;
}

function useAgentStatus() {
  const [status, setStatus] = useState<ChatAgentStatus>("checking");
  const [model, setModel] = useState<string>();
  const [maxContext, setMaxContext] = useState(24);
  const [reason, setReason] = useState<string>();
  const [tts, setTts] = useState<StatusResponse["tts"]>({ provider: "browser" });
  const [brain, setBrain] = useState<StatusResponse["brain"]>({ configured: false, connected: false });
  const [calendar, setCalendar] = useState<StatusResponse["calendar"]>({ configured: false, connected: false });
  const [news, setNews] = useState<StatusResponse["news"]>();

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
      if (json.brain) setBrain(json.brain);
      if (json.calendar) setCalendar(json.calendar);
      if (json.news) setNews(json.news);
    } catch {
      setStatus("offline");
      setReason("サーバーに接続できません");
    }
  }, []);

  useEffect(() => {
    void refresh();
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    window.addEventListener(STATUS_CHANGED, onFocus);
    return () => {
      window.removeEventListener("focus", onFocus);
      window.removeEventListener(STATUS_CHANGED, onFocus);
    };
  }, [refresh]);

  return { status, model, maxContext, reason, tts, brain, calendar, news, refresh, setStatus };
}

export function Dashboard() {
  const chat = useChat();
  const agent = useAgentStatus();
  const [calendarNotice, closeCalendarNotice] = useCalendarNotice();
  const [view, setView] = useState<View>("home");
  const composerRef = useRef<ComposerHandle>(null);

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

  // 話しかけても画面は切り替えない（HOME では中央下のパネルにやり取りを表示する）
  const send = chat.send;

  // 入力中に Gemini への接続を温める（サーバー側でも間引くが、ここでも 2 秒に 1 回まで）
  const lastWarm = useRef(0);
  const warm = useCallback(() => {
    const now = Date.now();
    if (now - lastWarm.current < 2000 || agent.status !== "online") return;
    lastWarm.current = now;
    void fetch("/api/warm", { method: "POST", keepalive: true }).catch(() => {});
  }, [agent.status]);

  // 画面を開いた時点で、脳・予定・天気の読み込みを始めておく（最初の返答を速くする）
  const warmedOnce = useRef(false);
  useEffect(() => {
    if (agent.status === "online" && !warmedOnce.current) {
      warmedOnce.current = true;
      warm();
    }
  }, [agent.status, warm]);

  /* ---- 音声会話 ---- */
  const { send: chatSend, stop: chatStop } = chat;
  const onVoiceCommand = useCallback((text: string) => void chatSend(text, { voice: true }), [chatSend]);
  const voice = useVoice({
    onCommand: onVoiceCommand,
    onBargeIn: chatStop, // 返答の途中で話し始めたら、生成を止めてそちらを聞く
    cloudVoice: agent.tts.provider === "elevenlabs",
  });
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
  const [brainNoticeClosed, setBrainNoticeClosed] = useState(false);
  const ttsNotice =
    voice.state !== "off" && agent.tts.reason && !ttsNoticeClosed ? `${agent.tts.reason}（今はブラウザの声で読み上げます）` : null;

  // 聞き取りを始めたら Gemini / ElevenLabs への接続を温めておく（話し終わった瞬間に速く返すため）
  useEffect(() => {
    if (voice.state === "listening" || voice.interim === "…") warm();
  }, [voice.state, voice.interim, warm]);

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
            brain={agent.brain}
            calendar={!agent.calendar.configured ? "NOT SET" : agent.calendar.connected ? "LINKED" : "NOT LINKED"}
            news={!agent.news ? "—" : agent.news.time === "off" ? "OFF" : `DAILY ${agent.news.time}`}
          />
          <HomeDialog
            messages={chat.messages}
            phase={chat.phase}
            voiceState={voice.state}
            hidden={inChat}
            onOpenChat={openChat}
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

        {calendarNotice && (
          <div className="banner" role="status">
            <b>CALENDAR</b>
            <span>{calendarNotice}</span>
            <button type="button" className="ghost-btn" onClick={closeCalendarNotice}>
              閉じる
            </button>
          </div>
        )}

        {agent.brain.configured && !agent.brain.connected && !brainNoticeClosed && (
          <div className="banner" role="status">
            <b>BRAIN OFFLINE</b>
            <span>{agent.brain.reason ?? "脳（Obsidian）に接続できません。"}（記憶なしで会話します）</span>
            <button type="button" className="ghost-btn" onClick={() => void agent.refresh()}>
              再確認
            </button>
            <button type="button" className="ghost-btn" onClick={() => setBrainNoticeClosed(true)}>
              閉じる
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
