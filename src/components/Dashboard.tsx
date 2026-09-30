"use client";

/**
 * F.R.I.D.A.Y. Mark3 メイン画面。
 * HUB（Core + Agent カード）と CHAT（会話ログ）を中央ステージで切り替える。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { StatusResponse } from "@/core/types";
import { STATUS_CHANGED, useChat } from "@/hooks/useChat";
import { REMINDERS_CHANGED, useReminders, type DueReminder } from "@/hooks/useReminders";
import { useVoice } from "@/hooks/useVoice";
import { useBargeIn } from "@/hooks/useBargeIn";
import { chime, pickJapaneseVoice } from "@/lib/speech";
import { Composer, type ComposerHandle } from "./Composer";
import { Conversation } from "./Conversation";
import { Header } from "./Header";
import { HomeHud } from "./home/HomeHud";
import type { ChatAgentStatus } from "./home/panels";
import { RightPanel } from "./RightPanel";
import { CalendarPage, FilesPage, MemoryPage, ProjectsPage, TasksPage } from "./Pages";
import { SettingsView } from "./SettingsView";
import { Sidebar, type View } from "./Sidebar";
import { hasExtension, openTabNow, TAB_BLOCKED, type TabNotice } from "@/lib/tabs";
import { useHoloState } from "@/lib/hologram-model";

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

/** スマホ・タブレット幅（右パネルを出さず、HUB のカードの下に並べる） */
function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 999px)");
    const update = () => setNarrow(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);
  return narrow;
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
  const [voiceSpeed, setVoiceSpeed] = useState(1.15);
  const [automation, setAutomation] = useState<StatusResponse["automation"]>({ diary: false });

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
      if (typeof json.voiceSpeed === "number") setVoiceSpeed(json.voiceSpeed);
      if (json.automation) setAutomation(json.automation);
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

  return { status, model, maxContext, reason, tts, brain, calendar, news, voiceSpeed, automation, refresh, setStatus };
}

export function Dashboard() {
  const chat = useChat();
  const agent = useAgentStatus();
  const [calendarNotice, closeCalendarNotice] = useCalendarNotice();
  const [blockedTab, setBlockedTab] = useState<TabNotice | null>(null);
  useEffect(() => {
    void hasExtension(); // 最初の「開いて」を待たせないよう、先に調べておく
    const onBlocked = (e: Event) => setBlockedTab((e as CustomEvent<TabNotice>).detail);
    window.addEventListener(TAB_BLOCKED, onBlocked);
    return () => window.removeEventListener(TAB_BLOCKED, onBlocked);
  }, []);
  const [bargeIn] = useBargeIn();
  // 「〇〇のホログラムを作って」と頼まれたら、見える HOME に戻る
  const holoStatus = useHoloState().status;
  const narrow = useNarrow();
  const [view, setView] = useState<View>("home");
  const composerRef = useRef<ComposerHandle>(null);
  useEffect(() => {
    if (holoStatus === "loading") setView("home");
  }, [holoStatus]);

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
      if (e.key === "Escape" && view !== "home" && chat.phase === "idle") setView("home");
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
    speed: agent.voiceSpeed,
    bargeIn,
  });
  const { speak, cancelSpeech, replyFinished } = voice;
  const voiceRef = useRef(voice);
  voiceRef.current = voice;

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

  /* ---- リマインダー: 時間になったら音・声・通知で知らせる ---- */
  const [reminder, setReminder] = useState<DueReminder | null>(null);
  const cloudTts = agent.tts.provider === "elevenlabs";
  const announce = useCallback(
    (r: DueReminder, late: boolean) => {
      setReminder(r);
      chime("wake");
      const text = late ? `${r.label.split(" ")[1]}のお知らせです。${r.text}` : `お知らせです。${r.text}`;
      voiceRef.current?.noteSpoken(text); // 自分で読み上げた言葉を聞き取って返事しないように
      window.setTimeout(() => {
        if (cloudTts) {
          const audio = new Audio(`/api/tts?text=${encodeURIComponent(text)}`);
          audio.play().catch(() => {});
        } else if ("speechSynthesis" in window) {
          const u = new SpeechSynthesisUtterance(text);
          u.lang = "ja-JP";
          u.voice = pickJapaneseVoice(window.speechSynthesis.getVoices());
          window.speechSynthesis.speak(u);
        }
      }, 450);
      try {
        if ("Notification" in window && Notification.permission === "granted") {
          new Notification("F.R.I.D.A.Y. リマインダー", { body: `${r.label} ${r.text}`, tag: r.id });
        }
      } catch {
        /* 通知が使えない環境 */
      }
    },
    [cloudTts],
  );
  useReminders(announce, agent.brain.configured);

  // リマインダーを初めて設定したら、通知を許可してもらう（別のタブを見ていても気づけるように）
  const [askNotify, setAskNotify] = useState(false);
  useEffect(() => {
    const onSet = () => {
      if ("Notification" in window && Notification.permission === "default") setAskNotify(true);
    };
    window.addEventListener(REMINDERS_CHANGED, onSet);
    return () => window.removeEventListener(REMINDERS_CHANGED, onSet);
  }, []);

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
    <div className="app" data-view={view}>
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
        {/* 奥行き：遠くの都市のシルエット・データライン・漂う光の粒・微細なノイズ */}
        <svg className="bg__city" viewBox="0 0 1600 220" preserveAspectRatio="none">
          <path d="M0 220V150h40v-30h26v48h30v-70h22v40h36V92h18v58h40v-36h30v60h24V70h20v86h34v-42h28v50h40V96h26v64h30v-48h22v70h36v-90h18v58h46v-30h24v52h30V84h22v72h40v-44h28v58h34V64h20v90h36v-40h26v62h30v-86h24v60h40v-26h22v48h30V100h24v58h34v-38h28v56h40V78h20v84h36v-44h24v58h30v-70h22v54h44v-30h26v46h30V92h24v66h36v-40h28v62h40V120h24v100z" />
        </svg>
        <div className="bg__data">
          <i />
          <i />
          <i />
          <i />
          <i />
          <i />
        </div>
        <div className="bg__particles">
          {Array.from({ length: 14 }, (_, i) => (
            <i key={i} style={{ left: `${(i * 37) % 100}%`, animationDelay: `${-(i * 1.9) % 18}s`, animationDuration: `${14 + (i % 5) * 3}s` }} />
          ))}
        </div>
        <div className="bg__noise" />
      </div>
      {/* 画面全体を囲む HUD の枠（HOME のときだけ見せる） */}
      <svg className="screen-frame" viewBox="0 0 1000 1000" preserveAspectRatio="none" aria-hidden="true">
        <path d="M0 40V8L8 0H300M700 0H992L1000 8V40M1000 960V992L992 1000H700M300 1000H8L0 992V960" />
      </svg>

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
          <HomeHud
            phase={chat.phase}
            stage={chat.stage}
            chatStatus={agent.status}
            onOpenChat={openChat}
            onNavigate={navigate}
            hidden={view !== "home"}
            brain={agent.brain}
            calendar={agent.calendar}
            automation={agent.automation}
            news={agent.news}
            voiceState={voice.state}
            messages={chat.messages}
            lastRun={chat.lastRun}
            maxContext={agent.maxContext}
          />
          <ProjectsPage hidden={view !== "projects"} />
          <TasksPage hidden={view !== "tasks"} />
          <CalendarPage hidden={view !== "calendar"} />
          <MemoryPage hidden={view !== "memory"} />
          <FilesPage hidden={view !== "files"} />
          <SettingsView
            hidden={view !== "settings"}
            onChanged={agent.refresh}
            status={{
              chatStatus: agent.status,
              model: agent.model,
              brain: agent.brain,
              calendar: agent.calendar,
              tts: agent.tts,
              automation: agent.automation,
            }}
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

        {reminder && (
          <div className="banner banner--reminder" role="alert">
            <b>REMINDER</b>
            <span>
              {reminder.label}　{reminder.text}
            </span>
            <button type="button" className="ghost-btn" onClick={() => setReminder(null)}>
              OK
            </button>
          </div>
        )}

        {askNotify && (
          <div className="banner" role="status">
            <b>NOTIFY</b>
            <span>通知を許可すると、別のタブやアプリを見ていてもリマインダーに気づけます。</span>
            <button
              type="button"
              className="ghost-btn"
              onClick={() => {
                void Notification.requestPermission().finally(() => setAskNotify(false));
              }}
            >
              許可する
            </button>
            <button type="button" className="ghost-btn" onClick={() => setAskNotify(false)}>
              あとで
            </button>
          </div>
        )}

        {blockedTab && (
          <div className="banner" role="alert">
            <b>{blockedTab.reason ? "TABS" : "OPEN"}</b>
            <span>
              {blockedTab.reason ??
                "ブラウザが自動で開くのを止めました。「開く」を押してください。SETTINGS の「BROWSER」から拡張機能を入れると、毎回押さずに開けて、閉じることもできます。"}
            </span>
            {blockedTab.url && (
              <button
                type="button"
                className="ghost-btn"
                onClick={() => {
                  openTabNow(blockedTab.url!);
                  setBlockedTab(null);
                }}
              >
                {blockedTab.label} を開く
              </button>
            )}
            {blockedTab.reason && (
              <button
                type="button"
                className="ghost-btn"
                onClick={() => {
                  setBlockedTab(null);
                  setView("settings");
                }}
              >
                拡張機能を入れる
              </button>
            )}
            <button type="button" className="ghost-btn" onClick={() => setBlockedTab(null)}>
              閉じる
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

      {!narrow && view !== "home" && <RightPanel gmail={agent.calendar.connected ? agent.calendar.gmail : undefined} />}
    </div>
  );
}
