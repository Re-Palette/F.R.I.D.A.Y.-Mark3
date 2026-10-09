"use client";

/**
 * F.R.I.D.A.Y. Mark3 メイン画面。
 * HUB（Core + Agent カード）と CHAT（会話ログ）を中央ステージで切り替える。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { StatusResponse } from "@/core/types";
import { CALENDAR_CHANGED, STATUS_CHANGED, useChat, type SendOptions, type UiMessage } from "@/hooks/useChat";
import { REMINDERS_CHANGED, useReminders, type DueReminder } from "@/hooks/useReminders";
import { useVoice, type LiveTurn } from "@/hooks/useVoice";
import { useBargeIn } from "@/hooks/useBargeIn";
import { useClapWake } from "@/hooks/useClapWake";
import { withReadings } from "@/lib/reading";
import { chime, pickJapaneseVoice, setOfflineVoice } from "@/lib/speech";
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
import { wakeExtension, bringToFront, hasExtension, openTabNow, syncKeepOpen, TAB_BLOCKED, type TabNotice } from "@/lib/tabs";
import { setHoloExplain, useHoloState } from "@/lib/hologram-model";
import { asksToLook, captureFrame, getCameraState, openCamera, toggleCamera, useCameraState } from "@/lib/camera";
import { CameraView } from "./CameraView";
import { recentAudio, setClapHandler, setVoiceCapture, startVoiceLevel, stopVoiceLevel, trackSpeech, voiceLevel } from "@/lib/voice-level";
import { currentVoiceprint, isOwnerVoice, loadVoiceprintModel } from "@/lib/voiceprint";
import { useVoiceprint } from "@/hooks/useVoiceprint";
import { probeRoute, startAiRouter, useAiRoute } from "@/lib/ai-router";
import { registerOfflineShell } from "@/lib/offline-shell";
import { duckMusic, runAmazonMusic } from "@/lib/amazon-music";
import { useNudges } from "@/hooks/useNudges";
import { PHONE_QUERY, useMedia } from "@/hooks/useMedia";
import { FOCUS_END, focusLeft, stopFocus, useFocus, type FocusEnd } from "@/lib/focus";
import { addFiles, saveOriginals, takeAttachments } from "@/lib/attachments";
import { asksAboutScreen, captureScreen, getScreenState, toggleScreen, useScreenState } from "@/lib/screen";
import { refreshCalendarCache } from "@/lib/calendar-cache";
import { detectModeCommand, getAiMode, setAiMode, useAiMode } from "@/lib/ai-mode";
import { autoSwitchToRecorded, useLiveVoice, useVoiceInput } from "@/lib/voice-input";
import { calendarForChat } from "@/lib/calendar-cache";
import { stripWake } from "@/lib/speech";
import { handleKarenText, requestExit, type KarenIo } from "@/lib/karen-controller";
import { busy as karenBusy, dispatchKaren, getKarenState, subscribeKaren } from "@/lib/karen-state";
import { getScene } from "@/lib/karen-scene";
import { EDITH_TOOL, FRIDAY_TOOL, KAREN_TOOL, STALE_CLIENT } from "@/lib/live-voice";
import { ACTION_TIMEOUT_MS, summarizeAction } from "@/lib/live-actions";
import { KarenHud } from "./karen/KarenHud";
import { EdithHud } from "./edith/EdithHud";

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
  // AI Router：Gemini（オンライン）とローカル AI＝Ollama（短い会話・オフライン）のどちらで答えるかを、自分で確かめて切り替える
  useEffect(() => {
    startAiRouter();
    registerOfflineShell(); // ネットが切れても画面を開けるように（Service Worker）
  }, []);
  const aiRoute = useAiRoute();
  const offlineAi = aiRoute.route === "offline" || aiRoute.route === "unavailable";
  useEffect(() => setOfflineVoice(offlineAi), [offlineAi]);
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
  const [clapWake] = useClapWake();
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
  const sendToAi = useCallback(
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

  /* ---- F.R.I.D.A.Y. と K.A.R.E.N.（クリエイティブ AI）の切り替え ---- */
  const aiMode = useAiMode();
  /** 会話とは別に一言話す（音声会話の間だけ。下で定義する sayAloud を使う） */
  const sayRef = useRef<(text: string) => void>(() => {});
  const karenIo = useMemo<KarenIo>(
    () => ({
      speak: (text) => {
        if (voiceRef.current && voiceRef.current.state !== "off") sayRef.current(text);
      },
    }),
    [],
  );
  /**
   * 声・文字の発言の入り口。AI の切り替えの言葉はこの端末で見分け、K.A.R.E.N. の間は制作の指示として受け取る
   * （制作・編集でない発言は、K.A.R.E.N. の人格で AI に渡す。会話の履歴は F.R.I.D.A.Y. と共有）。
   */
  const send = useCallback(
    (text: string, opts: SendOptions = {}) => {
      const cmd = detectModeCommand(text);
      const mode = getAiMode();
      // 声の指示を AI に渡さずに片付けたら、聞き取りに戻す（考え中のまま止まらないように）
      const settle = () => {
        if (opts.voice) window.setTimeout(() => voiceRef.current?.replyFinished(), 0);
      };
      // いまのモードを「開いて」と言われたら、何もしない（制作の指示・質問として送らない）
      // （F.R.I.D.A.Y. の間の「終了」などは、ほかの意味（タイマーの終了など）もあるので、これまでどおり AI に渡す）
      if ((cmd === "to-edith" && mode === "edith") || (cmd === "to-karen" && mode === "karen") || (cmd === "to-friday" && mode === "friday" && /開|ひら/.test(text))) {
        settle();
        return true;
      }
      if (cmd === "to-edith" && mode !== "edith") {
        setAiMode("edith");
        karenIo.speak?.("グローバルインテリジェンスモードを起動します。");
        settle();
        return true;
      }
      if (cmd === "to-friday" && mode === "edith") {
        setAiMode("friday");
        karenIo.speak?.("通常モードに戻ります。");
        settle();
        return true;
      }
      if (cmd === "to-karen" && mode !== "karen") {
        setAiMode("karen");
        // 名前（カレン・フライデー）は言わない：直後にその名前で呼ぶと、自分の声の聞き返しと間違えて無視してしまうため
        karenIo.speak?.("クリエイティブモードを起動します。");
        settle();
        return true;
      }
      if (cmd === "to-friday" && mode === "karen") {
        if (requestExit(karenIo)) karenIo.speak?.("通常モードに戻ります。");
        settle();
        return true;
      }
      if (mode === "karen") {
        let chatted = false;
        void handleKarenText(text, {
          ...karenIo,
          chat: (t) => {
            chatted = true;
            sendToAi(t, opts);
          },
        });
        if (!chatted) settle();
        return true;
      }
      return sendToAi(text, opts);
    },
    [sendToAi, karenIo],
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
    void refreshCalendarCache(); // 送る前に、予定の控えも新しくしておく（1 分に 1 回まで）
  }, [agent.status]);

  // 予定の控え（今日から 7 日分）：開いたとき・画面に戻ったとき・5 分ごと・予定が変わったときに読み直す。
  // 会話と一緒に送り、サーバーが Google から間に合わなかったときの予備にする
  useEffect(() => {
    void refreshCalendarCache(true);
    const onFocus = () => void refreshCalendarCache();
    const onVisible = () => document.visibilityState === "visible" && void refreshCalendarCache();
    const onChanged = () => void refreshCalendarCache(true);
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener(CALENDAR_CHANGED, onChanged);
    const timer = setInterval(onFocus, 5 * 60_000);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener(CALENDAR_CHANGED, onChanged);
      clearInterval(timer);
    };
  }, []);

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
  // スマホ：録った声をそのまま会話に送る（サーバーが文字にして返答まで続ける。何も聞き取れなければ聞き取りに戻る）
  const onVoiceAudio = useCallback(
    (audio: { mimeType: string; data: string }) =>
      void chatSendRaw("", { voice: true, audio, onNoSpeech: () => voiceRef.current.replyFinished() }),
    [chatSendRaw],
  );
  const phone = useMedia(PHONE_QUERY);
  // 声紋認証：オンなら、登録した声（陽大）のときだけ音声に反応する（文字の入力はこれまでどおり）
  const voiceprint = useVoiceprint();
  const ownerOnly = Boolean(voiceprint?.enabled && voiceprint.embedding.length);
  const verifyVoice = useCallback(async (utterance: Float32Array | null) => {
    const print = currentVoiceprint();
    if (!print?.enabled) return true;
    const audio = utterance ?? recentAudio(4000);
    if (!audio) return true; // マイクの声を取れない環境では確かめられないので通す
    return (await isOwnerVoice(audio, print)).ok;
  }, []);
  useEffect(() => {
    // パソコンは直近の声を画面の中に少しだけ取っておいて確かめる（スマホは録った 1 発言で確かめる）
    setVoiceCapture(ownerOnly && !phone);
    if (ownerOnly) void loadVoiceprintModel().catch(() => {});
  }, [ownerOnly, phone]);
  // 声の聞き取りの方式（Chrome の音声認識／録音してサーバーで文字にする）
  const voiceInput = useVoiceInput();
  // リアルタイム音声会話（声のまま直接やりとりして、すぐ返事をする）
  const liveSetting = useLiveVoice();
  const { upsertLive } = chat;
  const onLiveTurn = useCallback(
    (turn: LiveTurn) => {
      upsertLive(turn);
      // 「カレン、起動」などの切り替えは、これまでどおり画面で処理する
      if (turn.role === "user" && turn.done && detectModeCommand(stripWake(turn.text))) {
        voiceRef.current?.endLive();
        send(turn.text, { voice: true });
      }
    },
    [upsertLive, send],
  );
  const liveContext = useCallback(
    () => ({
      recent: chat.messages
        .filter((m) => (m.status === "done" || m.status === "stopped") && m.content.trim())
        .slice(-8)
        .map((m) => ({ role: m.role, content: m.content })),
      calendar: calendarForChat(),
      persona: getAiMode() === "friday" ? undefined : getAiMode() === "karen" ? ("karen" as const) : ("edith" as const),
    }),
    [chat.messages],
  );
  // K.A.R.E.N. のリアルタイム会話：AI が頼んできた制作・編集を、制作ワークスペースで実行して結果を返す
  // F.R.I.D.A.Y. のリアルタイム会話：頼まれた操作（予定・メールの下書き・アプリを開くなど）を、これまでの会話の仕組みで実行して結果を返す
  const chatMessagesRef = useRef(chat.messages);
  chatMessagesRef.current = chat.messages;
  const runFridayAction = useCallback(
    async (request: string): Promise<Record<string, unknown>> => {
      const reply = await new Promise<UiMessage | null>((resolve) => {
        const timer = window.setTimeout(() => resolve(null), ACTION_TIMEOUT_MS);
        const sent = chatSendRaw(request, {
          onDone: (m) => {
            clearTimeout(timer);
            resolve(m);
          },
        });
        if (!sent) {
          clearTimeout(timer);
          resolve(null);
        }
      });
      if (!reply) return { ok: false, error: "時間内に終わりませんでした。画面で結果を確かめてください。" };
      // ページやアプリを開いた結果はあとから届くので、少し待ってから最新の状態で伝える
      await new Promise((r) => window.setTimeout(r, 600));
      return summarizeAction(chatMessagesRef.current.find((m) => m.id === reply.id) ?? reply);
    },
    [chatSendRaw],
  );
  const onLiveTool = useCallback(async (name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const raw = typeof args.request === "string" ? args.request : typeof args.query === "string" ? args.query : "";
    const request = raw.trim();
    if (!request) return { ok: false, error: "頼みの内容が空です。" };
    // E.D.I.T.H. の調べもの：これまでの会話の仕組み（E.D.I.T.H. の人格・Google 検索）で調べる。返答は画面の情報ウィンドウに出る
    if (name === FRIDAY_TOOL || name === EDITH_TOOL) return runFridayAction(request);
    if (name !== KAREN_TOOL || getAiMode() !== "karen") return { ok: false, error: "いまは K.A.R.E.N. のモードではありません。" };
    const notices: string[] = [];
    let chatOnly = false;
    const run = handleKarenText(request, { speak: (t) => notices.push(t), chat: () => (chatOnly = true) });
    // 時間のかかる制作（3D モデル）は始まったところで返す（返事を待たせない。進み具合は画面に出る）
    const finished = await Promise.race([run.then(() => true), new Promise<boolean>((r) => window.setTimeout(() => r(false), 1500))]);
    if (chatOnly) return { ok: true, status: "not-creative", note: "制作・編集の指示ではなかった。会話として答える。", scene: sceneSummary() };
    return { ok: true, status: finished ? "done" : "started", notices, phase: getKarenState().phase, scene: sceneSummary() };
  }, [runFridayAction]);
  const voice = useVoice({
    onCommand: onVoiceCommand,
    onBargeIn: chatStop, // 返答の途中で話し始めたら、生成を止めてそちらを聞く
    // オフラインの間は ElevenLabs に届かないので、最初からブラウザ・OS の声で読み上げる
    cloudVoice: agent.tts.provider === "elevenlabs" && !offlineAi,
    speed: agent.voiceSpeed,
    // スマホは話している間マイクを止める（スピーカーの声を拾う・iPhone で再生と聞き取りがぶつかるのを防ぐ）
    bargeIn: bargeIn && !phone,
    wakeWord: !phone,
    // スマホ・録音方式を選んだパソコンは、録った音声をサーバーで文字にする（ブラウザの音声認識が声を拾わないことがあるため）
    recorded: phone || voiceInput.recorded,
    // 録った声をそのまま会話に送るのはスマホだけ（パソコンは文字にして「フライデー」の呼びかけ・K.A.R.E.N. の指示を見分ける）
    onAudio: phone ? onVoiceAudio : undefined,
    onStall: () => {
      if (!autoSwitchToRecorded()) return;
      setReminder({
        id: `voice-input-${Date.now()}`,
        at: Date.now(),
        label: "",
        title: "VOICE",
        text: "Chrome の音声認識がこの PC の声を聞き取れていないので、録音してサーバーで文字にする方式（ChatGPT などと同じ）に切り替えました。もう一度話しかけてください。SETTINGS → VOICE で戻せます。",
      });
    },
    verifyVoice: ownerOnly ? verifyVoice : undefined,
    // 声の会話はすべてリアルタイム会話（パソコン・スマホ・K.A.R.E.N.）。オフラインのときだけこれまでの方式
    live: liveSetting && !offlineAi,
    onLiveTurn,
    liveContext,
    onLiveTool,
    onWoke: (why) => {
      // 声の呼びかけで裏から前に出たときだけ、何と聞こえたかを知らせる（呼んでいないのに起動したときに原因が分かるように）。
      // 拍手 2 回は自分で起動したと分かるので、知らせない
      if (why.kind === "voice" && typeof document !== "undefined" && (document.hidden || !document.hasFocus())) {
        setReminder({
          id: `woke-${Date.now()}`,
          at: Date.now(),
          label: "",
          title: "WAKE",
          text: `「${why.text.slice(0, 40)}」と聞こえたので起動しました。話しかけていないのに起動したときは、この画面を教えてください。`,
        });
      }
      return bringToFront();
    }, // 裏のタブで呼ばれたら前に出す（拡張機能があるとき） // スマホは「フライデー」で起動しない（中央のコアをタップして話す）
  });
  const { speak, cancelSpeech, replyFinished } = voice;

  // K.A.R.E.N. の制作の進み具合をリアルタイム会話に伝える：
  // 制作中は会話を閉じない。終わったら（完成・失敗）K.A.R.E.N. に知らせて、声で伝えて次の提案をしてもらう
  useEffect(() => {
    let wasBusy = karenBusy(getKarenState());
    return subscribeKaren(() => {
      const s = getKarenState();
      const nowBusy = karenBusy(s);
      if (nowBusy) voiceRef.current?.liveKeepAlive();
      if (wasBusy && !nowBusy && getAiMode() === "karen") {
        const what = s.job?.title ?? "制作";
        const text =
          s.phase === "COMPLETED"
            ? `${what}が完成しました。いまのシーン：${JSON.stringify(sceneSummary())}`
            : s.phase === "ERROR"
              ? `${what}がうまくいきませんでした（${s.error ?? "理由不明"}）。`
              : s.phase === "CANCELLED"
                ? `${what}を止めました。`
                : "";
        // 会話中なら K.A.R.E.N. が自分の言葉で伝える。会話が閉じていれば、これまでの声で短く知らせる
        if (text && !voiceRef.current?.liveNotify(text) && s.phase === "COMPLETED") karenIo.speak?.(`${what}が完成しました。`);
      }
      wasBusy = nowBusy;
    });
  }, [karenIo]);

  // 裏で開きっぱなしの古い版の画面だと分かったら、手が空いたとき（返事が終わって呼びかけ待ち）に読み込み直す
  const [stale, setStale] = useState(false);
  useEffect(() => {
    const on = () => setStale(true);
    window.addEventListener(STALE_CLIENT, on);
    return () => window.removeEventListener(STALE_CLIENT, on);
  }, []);
  useEffect(() => {
    if (!stale || chat.phase !== "idle" || (voice.state !== "standby" && voice.state !== "off")) return;
    const t = window.setTimeout(() => window.location.reload(), 1500);
    return () => clearTimeout(t);
  }, [stale, chat.phase, voice.state]);
  const voiceRef = useRef(voice);
  voiceRef.current = voice;

  // 拍手 2 回で全システム起動（パソコン。マイクを開いている音声モードの間だけ聞く。「フライデー」の呼びかけもそのまま使える）
  useEffect(() => {
    // 1 回目の拍手で拡張機能を起こしておき、2 回目のあとすぐタブを前に出す
    setClapHandler(clapWake && !phone ? () => voiceRef.current.boot() : null, clapWake && !phone ? wakeExtension : null);
    return () => setClapHandler(null);
  }, [clapWake, phone]);

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
  // 拍手 2 回の起動がオンなら、音声モードを使いたい間は聞き取りが止まっていても（オフラインなど）マイクを開いておく
  const clapListen = clapWake && !phone && voice.wanted;
  useEffect(() => {
    if (voice.state === "off" && !clapListen) stopVoiceLevel();
    else void startVoiceLevel();
    voiceLevel.speaking = voice.state === "speaking";
  }, [voice.state, clapListen]);

  // 聞いている・考えている・話している間は、Amazon Music の音を小さくする（呼びかけた瞬間から）
  const duck = voice.state === "listening" || voice.state === "thinking" || voice.state === "speaking" || voice.interim === "…";
  useEffect(() => {
    void duckMusic(duck);
  }, [duck]);
  useEffect(() => () => stopVoiceLevel(), []);
  // 「Chrome を開いたら F.R.I.D.A.Y. を裏で開いておく」の設定を拡張機能に伝えておく（パソコン）
  useEffect(() => {
    if (!phone) void syncKeepOpen();
  }, [phone]);

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
        // 読み上げている間は HOME のコアも話しているように動かす
        if (cloudTts) {
          const audio = new Audio(`/api/tts?text=${encodeURIComponent(text)}`);
          const release = trackSpeech(audio);
          audio.onended = audio.onerror = release;
          audio.play().catch(release);
        } else if ("speechSynthesis" in window) {
          const u = new SpeechSynthesisUtterance(withReadings(text));
          const release = trackSpeech(null);
          u.onend = u.onerror = release;
          window.setTimeout(release, 4000 + text.length * 300); // 終わりの合図が来ない環境の保険
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
  sayRef.current = (text: string) => sayAloud(text);
  // F.R.I.D.A.Y. ⇄ K.A.R.E.N. を切り替えたら、前もってつないでおく会話もその AI に合わせる（切り替えてすぐ話せるように）
  useEffect(() => {
    voiceRef.current?.rewarmLive();
  }, [aiMode]);
  // K.A.R.E.N. の間は、声を聞いている状態を画面（状態）に伝える
  useEffect(() => {
    if (aiMode !== "karen") return;
    dispatchKaren({ type: voice.state === "listening" ? "LISTEN_START" : "LISTEN_END" });
  }, [aiMode, voice.state]);
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
    // E.D.I.T.H. の間に設定などを開いたら、その画面を見せる（ホームに戻ると E.D.I.T.H. に戻る）
    <div className="app" data-view={view} data-ai={aiMode === "edith" && view !== "home" ? "friday" : aiMode}>
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
      {/* 呼ばれて前に出たとき、声を出せるようにするための「何も起きない」クリックの的（拡張機能が使う） */}
      <div className="activation-spot" data-activation-spot aria-hidden="true" />

      <Header />
      {/* K.A.R.E.N.（クリエイティブ AI）の画面。F.R.I.D.A.Y. の画面は裏でそのまま（戻ったら続きから） */}
      {aiMode === "edith" && view === "home" && (
        <EdithHud
          messages={chat.messages}
          voiceState={voice.state}
          voiceInterim={voice.diag || voice.interim}
          voiceError={voice.error}
          onDismissVoiceError={voice.dismissError}
          onCommand={(t) => void send(t)}
          onMic={() => voice.talkNow()}
          onBack={() => void send("FRIDAYに戻して")}
          onOpenSettings={() => setView("settings")}
          onOpenUrl={(url) => openTabNow(url)}
        />
      )}
      {aiMode === "karen" && (
        <KarenHud
          active
          messages={chat.messages}
          voiceState={voice.state}
          voiceInterim={voice.diag || voice.interim}
          voiceError={voice.error}
          onDismissVoiceError={voice.dismissError}
          onCommand={(t) => void send(t)}
          // マイクはいつも「いま聞く」（押して音声がオフになってしまわないように）。読み上げ中なら止めて聞く
          onMic={() => voice.talkNow()}
          onBack={() => void send("FRIDAYに戻して")}
          io={karenIo}
        />
      )}

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
            hidden={view !== "home" || aiMode === "karen"}
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

        {aiRoute.route === "unavailable" && (
          <div className="banner" role="alert">
            <b>AI UNAVAILABLE</b>
            <span>
              {aiRoute.why === "gemini" ? "Gemini が使えず" : "インターネットに接続できず"}、ローカル AI（Ollama）にも接続できません。Ollama を起動し、SETTINGS → LOCAL AI の「接続テスト」で確かめてください。
            </span>
            <button type="button" className="ghost-btn" onClick={() => void probeRoute()}>
              再確認
            </button>
          </div>
        )}
        {agent.status === "offline" && !offlineAi && aiRoute.route !== "switching" && (
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

        {/* 文字起こし：聞こえた言葉と、聞き取りの様子（結果が返らないときにどこで止まっているか） */}
        {voice.state !== "off" && aiMode === "friday" && (voice.diag || voice.interim || voice.state === "listening") && (
          <p className="vcap" aria-live="polite" data-diag={voice.diag ? "" : undefined}>
            {voice.diag || (voice.interim === "…" ? "呼びかけを聞き取りました…" : voice.interim) || "聞いています…"}
          </p>
        )}

        <Composer
          ref={composerRef}
          wakeWord={!phone}
          phase={chat.phase}
          disabled={false}
          onSend={send}
          onStop={stopAll}
          voiceState={voice.state}
          // 聞き取った言葉（字幕）は出さず、「聞いています」「登録した声ではない」などの短い案内だけ出す
          voiceInterim={/^(聞いています|登録した声|聞き取りが止まって)/.test(voice.interim) ? voice.interim : ""}
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


/** K.A.R.E.N. に伝える、いまの制作シーンのようす（何がいくつあるか・選んでいるもの） */
function sceneSummary(): Record<string, unknown> {
  const scene = getScene();
  return {
    count: scene.objects.length,
    objects: scene.objects.slice(-8).map((o) => ({ name: o.name, color: o.color ?? null, selected: o.id === scene.selectedId })),
    turntable: scene.turntable,
    project: scene.projectName,
  };
}
