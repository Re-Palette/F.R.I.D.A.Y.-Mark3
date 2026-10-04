"use client";

/**
 * F.R.I.D.A.Y. Mark3 メイン画面。
 * HUB（Core + Agent カード）と CHAT（会話ログ）を中央ステージで切り替える。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { StatusResponse } from "@/core/types";
import { STATUS_CHANGED, useChat, type SendOptions } from "@/hooks/useChat";
import { REMINDERS_CHANGED, useReminders, type DueReminder } from "@/hooks/useReminders";
import { useVoice } from "@/hooks/useVoice";
import { useBargeIn } from "@/hooks/useBargeIn";
import { chime, pickJapaneseVoice } from "@/lib/speech";
import { Composer, type ComposerHandle } from "./Composer";
import { Conversation } from "./Conversation";
import { Header } from "./Header";
import { HomeHud } from "./home/HomeHud";
import { ScreenFrame } from "./home/ScreenFrame";
import type { ChatAgentStatus } from "./home/panels";
import { RightPanel } from "./RightPanel";
import { CalendarPage, FilesPage, MemoryPage, ProjectsPage, TasksPage } from "./Pages";
import { LecturePage } from "./LecturePage";
import { SettingsView } from "./SettingsView";
import { Sidebar, type View } from "./Sidebar";
import { hasExtension, openTabNow, TAB_BLOCKED, type TabNotice } from "@/lib/tabs";
import { setHoloExplain, useHoloState } from "@/lib/hologram-model";
import { asksToLook, captureFrame, getCameraState, openCamera, toggleCamera, useCameraState } from "@/lib/camera";
import { CameraView } from "./CameraView";
import { startVoiceLevel, stopVoiceLevel, voiceLevel } from "@/lib/voice-level";
import { duckMusic, runAmazonMusic } from "@/lib/amazon-music";
import { useNudges } from "@/hooks/useNudges";
import { PHONE_QUERY, useMedia } from "@/hooks/useMedia";
import { FOCUS_END, focusLeft, stopFocus, useFocus, type FocusEnd } from "@/lib/focus";
import { addFiles, saveOriginals, takeAttachments } from "@/lib/attachments";
import { asksAboutScreen, captureScreen, getScreenState, toggleScreen, useScreenState } from "@/lib/screen";

const CALENDAR_NOTICE: Record<string, string> = {
  connected: "Google カレンダーに接続しました。「フライデー、明日の予定は？」「明日 15 時に打ち合わせを入れて」のように話しかけてみてください。",
  denied: "Google カレンダーへの接続がキャンセルされました。",
  failed: "Google カレンダーに接続できませんでした。Google Cloud の設定（リダイレクト URI・テストユーザー）を確認して、もう一度お試しください。",
  "not-configured": "Google カレンダーの設定（GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET）がまだありません。",
};

const SPOTIFY_NOTICE: Record<string, string> = {
  connected: "Spotify に接続しました。「フライデー、作業用の音楽かけて」「次の曲」「音量下げて」のように話しかけてみてください（Spotify アプリを開いておいてください）。",
  denied: "Spotify への接続がキャンセルされました。",
  failed: "Spotify に接続できませんでした。Spotify の開発者ダッシュボードのリダイレクト URI と、ユーザー登録（User Management）を確認してください。",
  "not-configured": "Spotify の設定（SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET）がまだありません。",
};

/** Google・Spotify から戻ってきたとき（?calendar=… / ?spotify=…）の結果を一度だけ表示する */
function useCalendarNotice() {
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    const url = new URL(window.location.href);
    const spotify = url.searchParams.get("spotify");
    const result = url.searchParams.get("calendar");
    if (!result && !spotify) return;
    setNotice(spotify ? (SPOTIFY_NOTICE[spotify] ?? null) : (CALENDAR_NOTICE[result!] ?? null));
    url.searchParams.delete("spotify");
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
  const [voiceSpeed, setVoiceSpeed] = useState(0.95);
  const [automation, setAutomation] = useState<StatusResponse["automation"]>({ diary: false });
  const [hologramLibrary, setHologramLibrary] = useState(false);
  const [spotify, setSpotify] = useState<StatusResponse["spotify"]>({ configured: false, connected: false });

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
      setHologramLibrary(Boolean(json.hologram?.library));
      if (json.spotify) setSpotify(json.spotify);
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

  return { status, model, maxContext, reason, tts, brain, calendar, news, voiceSpeed, automation, hologramLibrary, spotify, refresh, setStatus };
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
  // カメラがオンなら、話しかけた瞬間の 1 枚を添える。オフでも「これ何？」「これ見て」なら先にカメラを開く
  const { send: chatSendRaw } = chat;
  const brainOn = useRef(false);
  brainOn.current = Boolean(agent.brain.connected);
  const send = useCallback(
    (text: string, opts: SendOptions = {}) => {
      // 読み込み済みの添付ファイルも一緒に送る（文字が無ければ「読んで」と頼む）
      const atts = takeAttachments();
      if (!text.trim() && !atts.length) return false;
      const content = text.trim() || "この添付ファイルを読んで、内容を教えて。";
      const files = atts.length
        ? {
            files: atts.flatMap((a) => a.files ?? []),
            shown: atts.map((a) => ({ name: a.name, kind: a.kind, thumb: a.thumb })),
            // 脳（Obsidian）が使えるときは、原本を「添付」フォルダに裏で保存し、要点は返答と一緒に「資料」に保存する
            attached: brainOn.current ? saveOriginals(atts) : undefined,
          }
        : undefined;
      // 画面を共有していて、画面について聞かれたら、その瞬間の画面を 1 枚添える（保存はしない）
      const aboutScreen = asksAboutScreen(content);
      if (aboutScreen && !getScreenState().on && /画面/.test(content)) {
        setReminder({ id: `screen-${Date.now()}`, at: Date.now(), label: "", text: "画面を見るには、入力欄の SCREEN を押して、見せたい画面を共有してください。", title: "SCREEN" });
      }
      void (async () => {
        const screen = aboutScreen && getScreenState().on ? await captureScreen() : null;
        const withScreen = screen
          ? {
              files: [...(files?.files ?? []), screen.file],
              shown: [...(files?.shown ?? []), { name: "画面", kind: "image", thumb: screen.thumb }],
              attached: files?.attached,
            }
          : files;
        if (!withScreen && !getCameraState().on && asksToLook(content)) await openCamera();
        const image = !screen && getCameraState().on ? await captureFrame() : null;
        chatSendRaw(content, { ...opts, ...(image ? { image } : {}), ...(withScreen ? { files: withScreen } : {}) });
      })();
      return true;
    },
    [chatSendRaw],
  );

  // 画面のどこにファイルをドロップしても添付する
  const [dropping, setDropping] = useState(false);
  useEffect(() => {
    let depth = 0;
    const hasFiles = (e: DragEvent) => [...(e.dataTransfer?.types ?? [])].includes("Files");
    const enter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth++;
      setDropping(true);
    };
    const leave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth = Math.max(0, depth - 1);
      if (!depth) setDropping(false);
    };
    const over = (e: DragEvent) => {
      if (hasFiles(e)) e.preventDefault();
    };
    const drop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      setDropping(false);
      if (e.dataTransfer?.files.length) addFiles(e.dataTransfer.files);
    };
    window.addEventListener("dragenter", enter);
    window.addEventListener("dragleave", leave);
    window.addEventListener("dragover", over);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragenter", enter);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("dragover", over);
      window.removeEventListener("drop", drop);
    };
  }, []);
  const camera = useCameraState();
  const screen = useScreenState();

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
  const { stop: chatStop } = chat;
  const onVoiceCommand = useCallback((text: string) => void send(text, { voice: true }), [send]);
  const phone = useMedia(PHONE_QUERY);
  const voice = useVoice({
    onCommand: onVoiceCommand,
    onBargeIn: chatStop, // 返答の途中で話し始めたら、生成を止めてそちらを聞く
    cloudVoice: agent.tts.provider === "elevenlabs",
    speed: agent.voiceSpeed,
    // スマホは話している間マイクを止める（スピーカーの声を拾う・iPhone で再生と聞き取りがぶつかるのを防ぐ）
    bargeIn: bargeIn && !phone,
    wakeWord: !phone,
    recorded: phone, // スマホは録った音声をサーバーで文字にする（ブラウザの音声認識が声を拾わないことがあるため） // スマホは「フライデー」で起動しない（中央のコアをタップして話す）
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

  // ホログラムを見せながらの説明：返答の文を拡大表示の字幕に流す
  useEffect(() => {
    if (lastMsg?.role === "assistant" && lastMsg.content) setHoloExplain(lastMsg.id, lastMsg.content);
  }, [lastMsg]);

  // 音声で聞かれて調べものを始めたら、黙って待たせず先に一言（人と話すときのように）
  const { interject } = voice;
  const fillered = useRef("");
  useEffect(() => {
    if (chat.stage !== "search" || !lastMsg || lastMsg.role !== "assistant" || !lastMsg.voice) return;
    if (lastMsg.status !== "streaming" || lastMsg.content || fillered.current === lastMsg.id) return;
    fillered.current = lastMsg.id;
    const lines = ["調べます。少しお待ちください。", "確認します。", "少し調べます。"];
    interject({ id: lastMsg.id, createdAt: lastMsg.createdAt, text: lines[Math.floor(Math.random() * lines.length)] });
  }, [chat.stage, lastMsg, interject]);

  // ElevenLabs の設定に問題があるときは、音声会話をオンにした時点で一度だけ知らせる
  const [ttsNoticeClosed, setTtsNoticeClosed] = useState(false);
  const [brainNoticeClosed, setBrainNoticeClosed] = useState(false);
  const ttsNotice =
    voice.state !== "off" && agent.tts.reason && !ttsNoticeClosed ? `${agent.tts.reason}（今はブラウザの声で読み上げます）` : null;

  // 音声モードの間は、マイクの声の大きさを測って HOME のコアと波形を揺らす（音は録音・送信しない）
  useEffect(() => {
    if (voice.state === "off") stopVoiceLevel();
    else void startVoiceLevel();
    voiceLevel.speaking = voice.state === "speaking";
  }, [voice.state]);

  // 聞いている・考えている・話している間は、Amazon Music の音を小さくする（呼びかけた瞬間から）
  const duck = voice.state === "listening" || voice.state === "thinking" || voice.state === "speaking" || voice.interim === "…";
  useEffect(() => {
    void duckMusic(duck);
  }, [duck]);
  useEffect(() => () => stopVoiceLevel(), []);

  // 聞き取りを始めたら Gemini / ElevenLabs への接続を温めておく（話し終わった瞬間に速く返すため）
  useEffect(() => {
    if (voice.state === "listening" || voice.interim === "…") warm();
  }, [voice.state, voice.interim, warm]);

  /* ---- リマインダー・先回りの声かけ: 時間になったら音・声・通知で知らせる ---- */
  const [reminder, setReminder] = useState<(DueReminder & { title?: string }) | null>(null);
  const cloudTts = agent.tts.provider === "elevenlabs";
  const voiceSpeedRef = useRef(agent.voiceSpeed);
  voiceSpeedRef.current = agent.voiceSpeed;
  /** 会話とは別に、F.R.I.D.A.Y. のほうから一言話す（チャイム → 声 → 通知） */
  const sayAloud = useCallback(
    (text: string, notify?: { title: string; body: string; tag: string; always?: boolean }) => {
      chime("wake");
      voiceRef.current?.noteSpoken(text); // 自分で読み上げた言葉を聞き取って返事しないように
      window.setTimeout(() => {
        if (cloudTts) {
          const audio = new Audio(`/api/tts?text=${encodeURIComponent(text)}`);
          audio.play().catch(() => {});
        } else if ("speechSynthesis" in window) {
          const u = new SpeechSynthesisUtterance(text);
          u.lang = "ja-JP";
          u.voice = pickJapaneseVoice(window.speechSynthesis.getVoices());
          u.rate = Math.min(1.8, Math.max(0.8, (voiceSpeedRef.current / 1.15) * 1.25));
          u.pitch = 0.85; // 落ち着いた低めの声
          window.speechSynthesis.speak(u);
        }
      }, 450);
      try {
        if (notify && (notify.always || document.hidden) && "Notification" in window && Notification.permission === "granted") {
          new Notification(notify.title, { body: notify.body, tag: notify.tag });
        }
      } catch {
        /* 通知が使えない環境 */
      }
    },
    [cloudTts],
  );
  const announce = useCallback(
    (r: DueReminder, late: boolean) => {
      setReminder(r);
      const text = late ? `${r.label.split(" ")[1]}のお知らせです。${r.text}` : `お知らせです。${r.text}`;
      sayAloud(text, { title: "F.R.I.D.A.Y. リマインダー", body: `${r.label} ${r.text}`, tag: r.id, always: true });
    },
    [sayAloud],
  );
  useReminders(announce, agent.brain.configured);

  // 集中モードが終わったら：音楽を止め、声で知らせ、脳に記録する
  const focus = useFocus();
  useEffect(() => {
    const onEnd = (e: Event) => {
      const { state, completed, minutes } = (e as CustomEvent<FocusEnd>).detail;
      if (state.music) void runAmazonMusic({ action: "pause" }).catch(() => {});
      const text = completed
        ? `${state.minutes}分経ちました。お疲れさまでした。${state.minutes >= 40 ? "10分" : "5分"}ほど休憩を入れてください。`
        : `集中モードを止めました。${minutes}分でした。`;
      setReminder({ id: `focus-${state.startedAt}`, at: Date.now(), label: "", text, title: "FOCUS" });
      sayAloud(text, { title: "F.R.I.D.A.Y. 集中モード", body: text, tag: `focus-${state.startedAt}`, always: completed });
      void fetch("/api/focus", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ task: state.task, minutes, startedAt: state.startedAt, completed }),
      }).catch(() => {});
    };
    window.addEventListener(FOCUS_END, onEnd);
    return () => window.removeEventListener(FOCUS_END, onEnd);
  }, [sayAloud]);
  const [, tick] = useState(0);
  useEffect(() => {
    if (!focus) return;
    const id = window.setInterval(() => tick((n) => n + 1), 1000);
    return () => window.clearInterval(id);
  }, [focus]);
  // 先回りの声かけ（予定の 20 分前・今日 / 明日が期限の ToDo・雨の日の傘）。会話中は割り込まない
  const voiceStateNow = useRef(voice.state);
  voiceStateNow.current = voice.state;
  const phaseNow = useRef(chat.phase);
  phaseNow.current = chat.phase;
  useNudges(
    (text, n) => {
      setReminder({ id: n.id, at: Date.now(), label: "", text, title: "F.R.I.D.A.Y." });
      sayAloud(text, { title: "F.R.I.D.A.Y.", body: text, tag: n.id });
    },
    () => phaseNow.current !== "idle" || ["listening", "thinking", "speaking"].includes(voiceStateNow.current),
    agent.status === "online",
  );

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

  // 授業の文字起こしを始めたら、音声会話は止める（ブラウザの音声認識は同時に 1 つしか動かないため）
  const voiceStateRef = useRef(voice.state);
  voiceStateRef.current = voice.state;
  const voiceToggle = voice.toggle;
  const onLectureRecording = useCallback(
    (on: boolean) => {
      if (on && voiceStateRef.current !== "off") voiceToggle();
    },
    [voiceToggle],
  );
  const navigate = useCallback((v: View) => (v === "chat" ? openChat() : setView(v)), [openChat]);
  const backToHub = useCallback(() => setView("home"), []);

  const inChat = view === "chat";

  return (
    <div className="app" data-view={view}>
      {dropping && (
        <div className="drop-overlay" aria-hidden="true">
          <span>ここにドロップして添付（写真・PDF・Word / Excel / PowerPoint・テキスト）</span>
        </div>
      )}
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
      <ScreenFrame />

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
            onWake={voice.wake}
            onVoiceOff={voice.toggle}
          />
          <ProjectsPage hidden={view !== "projects"} />
          <TasksPage hidden={view !== "tasks"} />
          <CalendarPage hidden={view !== "calendar"} />
          <MemoryPage hidden={view !== "memory"} />
          <FilesPage hidden={view !== "files"} />
          <LecturePage hidden={view !== "lecture"} onRecording={onLectureRecording} />
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
              hologramLibrary: agent.hologramLibrary,
              spotify: agent.spotify,
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

        {focus && (
          <div className="focus-chip" role="timer" aria-label="集中モード">
            <b>FOCUS</b>
            <span className="focus-chip__time">{focusLeft(focus)}</span>
            {focus.task && <span className="focus-chip__task">{focus.task}</span>}
            <button type="button" className="ghost-btn" onClick={() => stopFocus()}>
              止める
            </button>
          </div>
        )}
        {reminder && (
          <div className="banner banner--reminder" role="alert">
            <b>{reminder.title ?? "REMINDER"}</b>
            <span>
              {reminder.label ? `${reminder.label}　` : ""}
              {reminder.text}
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
            <b>{calendarNotice.startsWith("Spotify") ? "SPOTIFY" : "CALENDAR"}</b>
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
          wakeWord={!phone}
          phase={chat.phase}
          disabled={false}
          onSend={send}
          onStop={stopAll}
          voiceState={voice.state}
          voiceInterim={voice.interim}
          onVoiceToggle={voice.toggle}
          screenOn={screen.on}
          onScreenToggle={toggleScreen}
          onTalk={voice.talkNow}
          onTyping={warm}
          cameraOn={camera.on}
          onCameraToggle={toggleCamera}
        />
        <CameraView />
      </main>

      {!narrow && view !== "home" && <RightPanel gmail={agent.calendar.connected ? Boolean(agent.calendar.gmail && agent.calendar.gmailDraft) : undefined} />}
    </div>
  );
}
