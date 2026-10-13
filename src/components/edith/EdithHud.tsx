"use client";

/**
 * E.D.I.T.H.（Enhanced Data Integration & Tactical Horizon）の画面。ネオンパープルの戦術 HUD。
 *   左上：ロゴ（NO PLACE LEFT BEHIND）・ナビ（AGENTS / NOTES / TASKS / CONTEXT）
 *   左：SYSTEM STATUS（この端末で実際に測れる値だけ）・CURRENT MODE（音声の状態）・AI（実際の接続状態）
 *   左下：現在地（東京）のレーダー・描画の速さ（実測の FPS）
 *   中央：GOD'S EYE VIEW のビューポート。EARTH（3D 地球儀・地震・人工衛星。EdithEarth）と
 *        LOCAL FEED（Web カメラ・画面共有。EdithFeed。この端末の中で映すだけ）を切り替える。
 *        映っていないときは円の待機画面、映っている間は横長（16:9。既定）か円（DISPLAY・映像の下の操作で切り替え）
 *        下に LOCATION ／ 声（AI AGENT）／ VISUAL PRESETS と、指示の入力
 *   右上：日時・接続・通信・電池／ACTIVE STYLE・視点の座標と太陽の高度（計算値）・時計
 *   右：DISPLAY（映像の表示設定）・NEWS（Google 検索で調べた実際の話題と出典）・TREND・TASKS（クイックアクセス）
 *   右下：メモリの推移・分野ごとの件数・映像の接続・ホログラムの地図
 * 測れないもの・取れなかったものは、取れたように見せない（「—」「未接続」と出す）。
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import type { UiMessage } from "@/hooks/useChat";
import type { VoiceState } from "@/hooks/useVoice";
import { Markdown } from "../Markdown";
import { EdithGlobe, type GlobePoint } from "./EdithGlobe";
import { EdithFeedBar, EdithFeedView, feedSummary } from "./EdithFeed";
import { useEdithFeed } from "@/lib/edith-feed";
import { EdithEarth, type EarthFlyTo, type ImageryKind } from "./EdithEarth";
import { gibsDate } from "@/lib/earth/imagery";
import type { BBox } from "@/lib/earth/aircraft";
import { TRAFFIC_MAX_VIEW_AREA, TRAFFIC_TILE_URL } from "@/lib/earth/transport";
import { findCity, nearestCity } from "@/lib/earth/places";
import { bboxArea, roundBBox } from "@/lib/earth/aircraft";
import { EarthDetail, EarthLayersPanel } from "./EarthPanel";
import { EdithCamWall, type WallItem } from "./EdithCamWall";
import { liveEmbedUrl, liveWatchUrl } from "@/lib/earth/livestreams";
import { EdithWeather, type WeatherCenter } from "./EdithWeather";
import { DEFAULT_WEATHER, parseWeatherSettings, WEATHER_SETTINGS_KEY, WINDY_OVERLAY_LABEL, WINDY_OVERLAYS, zoomForHeight, type WeatherSettings } from "@/lib/earth/windy-map";
import { distanceKm, WEBCAM_MAX_VIEW_HEIGHT_M, WEBCAM_RADIUS_DEFAULT, WEBCAM_RADIUS_MAX, webcamQuery } from "@/lib/earth/webcams";
import { aircraftPositionAt } from "@/lib/earth/aircraft";
import { LAYER_LABEL, setEdithCommandHandler, type EdithCommand, type TrackTarget } from "@/lib/edith-commands";
import { useEarthData } from "./useEarthData";
import { DEFAULT_EARTH, EARTH_SETTINGS_KEY, parseEarthSettings, type EarthSettings } from "@/lib/earth/settings";
import { findPlaces } from "@/lib/edith-geo";
import { splitTables } from "@/lib/edith-text";
import { applyPreset, DEFAULT_DISPLAY, EDITH_DISPLAY_KEY, nextPreset, parseDisplay, PRESETS, solarElevation, type DisplaySettings, type PresetKey } from "@/lib/edith-display";
import {
  ago,
  regionCounts,
  safeHref,
  trendCounts,
  useAllLoadedNews,
  useEdithNews,
  useNow,
  type EdithCategory,
  type EdithNewsItem,
} from "@/lib/edith-data";

/* ---------- アイコン（細い線） ---------- */
const P: Record<string, ReactNode> = {
  logo: <><circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="4.5" /><path d="M12 3v3M12 18v3M3 12h3M18 12h3" /></>,
  eye: <><path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12z" /><circle cx="12" cy="12" r="3.2" /><circle cx="12" cy="12" r="0.9" /></>,
  pin: <><path d="M12 21s-6.5-6.2-6.5-11a6.5 6.5 0 0 1 13 0c0 4.8-6.5 11-6.5 11z" /><circle cx="12" cy="10" r="2.3" /></>,
  mic: <><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3" /></>,
  link: <path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" />,
  cpu: <><rect x="7" y="7" width="10" height="10" /><rect x="10" y="10" width="4" height="4" /><path d="M9 3v4M15 3v4M9 17v4M15 17v4M3 9h4M3 15h4M17 9h4M17 15h4" /></>,
  mem: <><rect x="3" y="8" width="18" height="8" /><path d="M7 8v8M11 8v8M15 8v8M5 16v3M19 16v3" /></>,
  disk: <><rect x="3" y="5" width="18" height="14" rx="1" /><path d="M3 14h18M16 17h2" /></>,
  net: <path d="M4 18h3v-4H4zM10.5 18h3V9h-3zM17 18h3V5h-3z" />,
  globe: <><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18" /></>,
  search: <><circle cx="11" cy="11" r="6" /><path d="M16 16l5 5" /></>,
  chip: <><rect x="7" y="7" width="10" height="10" /><path d="M9 3v4M15 3v4M9 17v4M15 17v4M3 9h4M3 15h4M17 9h4M17 15h4" /></>,
  gear: <><circle cx="12" cy="12" r="3" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1" /></>,
  back: <path d="M10 6l-6 6 6 6M4 12h16" />,
  doc: <><path d="M6 3h8l4 4v14H6z" /><path d="M9 11h6M9 15h6" /></>,
  chart: <path d="M4 20V10M10 20V4M16 20v-8M22 20H2" />,
  plane: <path d="M2 13l8-2 4-8 2 1-2 8 7 2-1 2-7-1-3 6-2-1 1-6-6 1z" />,
  image: <><rect x="3" y="5" width="18" height="14" /><path d="M3 16l5-5 4 4 3-3 6 6" /><circle cx="16" cy="9" r="1.5" /></>,
  cap: <path d="M2 9l10-5 10 5-10 5zM6 11v5c3 2 9 2 12 0v-5" />,
  dots: <><circle cx="6" cy="12" r="1.3" /><circle cx="12" cy="12" r="1.3" /><circle cx="18" cy="12" r="1.3" /></>,
  play: <path d="M8 5l11 7-11 7z" />,
  reset: <path d="M4 12a8 8 0 1 0 3-6.2M4 4v4h4" />,
  rotate: <path d="M20 12a8 8 0 1 1-2.3-5.7M20 4v4h-4" />,
  translate: <path d="M3 5h10M8 3v2M5 5c1 4 4 7 7 8M11 5c-1 4-4 7-7 8M13 21l4-10 4 10M14.5 17h5" />,
  close: <path d="M6 6l12 12M18 6L6 18" />,
  send: <path d="M5 6l6 6-6 6M12 6l6 6-6 6" />,
  wifi: <path d="M2 9a15 15 0 0 1 20 0M5 12.5a10 10 0 0 1 14 0M8.5 16a5 5 0 0 1 7 0M12 19.5h.01" />,
  sparse: <><rect x="4" y="4" width="16" height="16" /><path d="M8 8h.01M16 8h.01M12 12h.01M8 16h.01M16 16h.01" /></>,
  moon: <path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z" />,
  sparkle: <path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM19 16l.7 1.8 1.8.7-1.8.7L19 21l-.7-1.8-1.8-.7 1.8-.7z" />,
  cube: <><path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z" /><path d="M4 7.5l8 4.5 8-4.5M12 12v9" /></>,
  frame: <path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5" />,
  layers: <path d="M12 3l9 5-9 5-9-5zM3 13l9 5 9-5" />,
  presets: <><rect x="3" y="5" width="18" height="14" /><path d="M3 15l5-4 4 3 3-2 6 4" /><circle cx="16" cy="9" r="1.4" /></>,
};
function I({ n, s = 18 }: { n: keyof typeof P; s?: number }) {
  return (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {P[n]}
    </svg>
  );
}

const CATEGORIES: { key: EdithCategory; label: string; desc: string; icon: keyof typeof P }[] = [
  { key: "news", label: "NEWS", desc: "世界の最新ニュースを取得", icon: "globe" },
  { key: "research", label: "RESEARCH", desc: "論文・学術情報を検索", icon: "doc" },
  { key: "market", label: "MARKET", desc: "経済・市場動向を分析", icon: "chart" },
  { key: "travel", label: "TRAVEL", desc: "世界のスポット・交通情報", icon: "plane" },
  { key: "culture", label: "CULTURE", desc: "文化・トレンド・エンタメ", icon: "image" },
  { key: "tech", label: "TECH", desc: "テクノロジー・イノベーション", icon: "chip" },
  { key: "education", label: "EDUCATION", desc: "教育・学習リソース", icon: "cap" },
  { key: "more", label: "MORE", desc: "その他の情報（環境・宇宙・健康）", icon: "dots" },
];
const CAT_LABEL = Object.fromEntries(CATEGORIES.map((c) => [c.key, c.label])) as Record<EdithCategory, string>;

type QuickKind = "web" | "image" | "doc" | "translate";
type Win = { id: string; kind: "answer"; msgId: string } | { id: string; kind: "analysis" } | { id: string; kind: "context" };
/** 右のパネルのページ */
type Page = "earth" | "display" | "news" | "trend" | "tasks";
const PAGES: { key: Page; label: string }[] = [
  { key: "earth", label: "EARTH" },
  { key: "display", label: "DISPLAY" },
  { key: "news", label: "NEWS" },
  { key: "trend", label: "TREND" },
  { key: "tasks", label: "TASKS" },
];

const DOW = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
const two = (n: number) => String(n).padStart(2, "0");

/** 起点（東京）。地図の「東京（起点）」と同じ場所 */
const HOME = { name: "TOKYO", lat: 35.6812, lon: 139.7671 };

const DISPLAY_KEY = EDITH_DISPLAY_KEY;
const PAGE_KEY = "friday.edith-page.v1";

/** 接続（オンラインか）・通信の種類・電池（取れるブラウザだけ） */
function useSystemStatus() {
  const [online, setOnline] = useState(true);
  const [net, setNet] = useState<string | null>(null);
  const [battery, setBattery] = useState<number | null>(null);
  useEffect(() => {
    const upd = () => setOnline(navigator.onLine);
    upd();
    window.addEventListener("online", upd);
    window.addEventListener("offline", upd);
    const conn = (navigator as Navigator & { connection?: { effectiveType?: string; addEventListener?: (t: string, f: () => void) => void } }).connection;
    const readNet = () => setNet(conn?.effectiveType ? conn.effectiveType.toUpperCase() : null);
    readNet();
    conn?.addEventListener?.("change", readNet);
    let alive = true;
    const nav = navigator as Navigator & { getBattery?: () => Promise<{ level: number; addEventListener: (t: string, f: () => void) => void }> };
    void nav.getBattery?.().then((b) => {
      const read = () => alive && setBattery(b.level);
      read();
      b.addEventListener("levelchange", read);
    });
    return () => {
      alive = false;
      window.removeEventListener("online", upd);
      window.removeEventListener("offline", upd);
    };
  }, []);
  return { online, net, battery };
}

interface DeviceMetrics {
  /** CPU のコア数（使用率はブラウザから測れない） */
  cores: number | null;
  /** この画面が使っているメモリ（JS ヒープ。Chrome 系だけ） */
  memory: { usedMb: number; ratio: number } | null;
  /** このアプリが端末に保存している量（ブラウザの見積もり） */
  storage: { usedMb: number; ratio: number } | null;
  /** 回線の速さの目安（Chrome 系だけ） */
  downlink: number | null;
  /** メモリの使用率の推移（5 秒ごと・新しいものが最後） */
  memHistory: number[];
}

/** SYSTEM STATUS：この端末で実際に測れる値だけ（測れないものは null のまま「—」と出す） */
function useDeviceMetrics(): DeviceMetrics {
  const [m, setM] = useState<DeviceMetrics>({ cores: null, memory: null, storage: null, downlink: null, memHistory: [] });
  useEffect(() => {
    let alive = true;
    const read = async () => {
      const perf = performance as Performance & { memory?: { usedJSHeapSize: number; jsHeapSizeLimit: number } };
      const conn = (navigator as Navigator & { connection?: { downlink?: number } }).connection;
      let storage: DeviceMetrics["storage"] = null;
      try {
        const est = await navigator.storage?.estimate?.();
        if (est && typeof est.usage === "number" && est.quota) storage = { usedMb: est.usage / 1048576, ratio: est.usage / est.quota };
      } catch {
        storage = null;
      }
      if (!alive) return;
      const memory = perf.memory?.jsHeapSizeLimit ? { usedMb: perf.memory.usedJSHeapSize / 1048576, ratio: perf.memory.usedJSHeapSize / perf.memory.jsHeapSizeLimit } : null;
      setM((prev) => ({
        cores: typeof navigator.hardwareConcurrency === "number" && navigator.hardwareConcurrency > 0 ? navigator.hardwareConcurrency : null,
        memory,
        storage,
        downlink: typeof conn?.downlink === "number" ? conn.downlink : null,
        memHistory: memory ? [...prev.memHistory.slice(-23), memory.usedMb] : prev.memHistory,
      }));
    };
    void read();
    const t = setInterval(() => void read(), 5000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);
  return m;
}

/** 画面の描画の速さ（1 秒ごとに実際に数えた FPS。隠れている間は数えない） */
function useFrameRate(len = 36): number[] {
  const [hist, setHist] = useState<number[]>([]);
  useEffect(() => {
    let frames = 0;
    let raf = 0;
    let last = performance.now();
    const loop = () => {
      frames++;
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    const iv = setInterval(() => {
      const t = performance.now();
      if (document.hidden) {
        frames = 0;
        last = t;
        return;
      }
      const fps = Math.round((frames * 1000) / Math.max(1, t - last));
      frames = 0;
      last = t;
      setHist((h) => [...h.slice(-(len - 1)), fps]);
    }, 1000);
    return () => {
      cancelAnimationFrame(raf);
      clearInterval(iv);
    };
  }, [len]);
  return hist;
}

/** 端末に保存する小さな設定（保存できない環境でも動く） */
function useStored<T>(key: string, parse: (raw: unknown) => T, initial: T): [T, (f: (v: T) => T) => void] {
  const [v, setV] = useState<T>(initial);
  useEffect(() => {
    try {
      const raw = localStorage.getItem(key);
      if (raw) setV(parse(JSON.parse(raw)));
    } catch {
      /* 読めなければ既定のまま */
    }
  }, [key, parse]);
  const update = useCallback(
    (f: (v: T) => T) =>
      setV((prev) => {
        const next = f(prev);
        try {
          localStorage.setItem(key, JSON.stringify(next));
        } catch {
          /* 保存できなくても表示は変える */
        }
        return next;
      }),
    [key],
  );
  return [v, update];
}
/** データが無いときの空の一覧（毎回新しい配列を渡すと、地球儀が描き直しを繰り返して重くなるので、いつも同じものを渡す） */
const NONE: never[] = [];

const TRACK_LABEL: Record<TrackTarget, string> = { aircraft: "飛行機", ship: "船", bus: "バス" };

const parsePage = (raw: unknown): Page => (PAGES.some((p) => p.key === raw) ? (raw as Page) : "display");
const parsePreset = (raw: unknown): PresetKey => (PRESETS.some((p) => p.key === raw) ? (raw as PresetKey) : "tactical");

const MODE_LABEL: Record<VoiceState, string> = { off: "VOICE OFF", standby: "STANDBY", listening: "LISTENING", thinking: "THINKING", speaking: "SPEAKING" };
const MODE_HINT: Record<VoiceState, string> = {
  off: "音声はオフです（押すと声で指示できます）",
  standby: "呼びかけを待っています",
  listening: "聞いています",
  thinking: "考えています",
  speaking: "話しています",
};

type Link = "online" | "offline" | "checking";

interface Props {
  messages: UiMessage[];
  voiceState: VoiceState;
  voiceInterim: string;
  voiceError: string | null;
  onDismissVoiceError: () => void;
  /** E.D.I.T.H. への指示（答えは情報ウィンドウに出る） */
  onCommand: (text: string) => void;
  /** 声で話しかける（中央下の丸いアイコン） */
  onMic: () => void;
  /** F.R.I.D.A.Y. に戻る */
  onBack: () => void;
  /** 設定を開く */
  onOpenSettings: () => void;
  /** 画面のリンクを開く（新しいタブ） */
  onOpenUrl: (url: string) => void;
  /** AI（Gemini）が応答できるか（/api/status の結果） */
  aiStatus?: Link;
  /** 使っている AI のモデル名（表示用） */
  model?: string;
  /** 脳（Obsidian）の接続 */
  brain?: { configured: boolean; connected: boolean };
  /** Google カレンダーの接続 */
  calendar?: { configured: boolean; connected: boolean };
  /** 会話の記憶の上限（メッセージ数） */
  maxContext?: number;
}

export const EdithHud = memo(function EdithHud(props: Props) {
  const { messages, voiceState, voiceInterim, voiceError, onDismissVoiceError, onCommand, onMic, onBack, onOpenSettings, onOpenUrl } = props;
  const { aiStatus = "checking", model, brain, calendar, maxContext = 24 } = props;
  const now = useNow();
  const sys = useSystemStatus();
  const metrics = useDeviceMetrics();
  const fps = useFrameRate();
  const [display, setDisplay] = useStored<DisplaySettings>(DISPLAY_KEY, parseDisplay, DEFAULT_DISPLAY);
  // 中央の映像（映っている・つないでいる・切れた間は、選んだ形の枠。それ以外は円の待機画面）
  const feed = useEdithFeed();
  const feedSum = feedSummary(feed);
  const feedOn = feed.status === "live" || feed.status === "connecting" || feed.status === "ended";
  // GOD'S EYE VIEW に映すもの：EARTH（3D 地球儀。円の枠）か LOCAL FEED。LOCAL FEED の映像は EARTH の間も止めない（隠すだけ）
  const gevMode = display.gevMode;
  const earthActive = gevMode === "earth";
  const weatherActive = gevMode === "weather";
  // LIVE：ピックアップした場所のライブカメラを、GOD'S EYE VIEW いっぱいに並べる
  const camsActive = gevMode === "cams";
  const feedActive = gevMode === "feed";
  // WEATHER は横長の枠（Windy の地図の操作・時間の帯が円で切れないように）
  const shape = weatherActive || camsActive ? "wide" : feedActive && feedOn ? display.feedShape : "circle";
  const [earth, setEarth] = useStored<EarthSettings>(EARTH_SETTINGS_KEY, parseEarthSettings, DEFAULT_EARTH);
  // 地球儀は、初めて EARTH を開いたときに作り、その後は LOCAL FEED にしても作り直さない（隠して描画を止める）
  const [earthMounted, setEarthMounted] = useState(earthActive);
  // WEATHER（Windy の天気の地図）：初めて開いたときに作り、その後は外さない（Windy の地図はページの中で 1 回しか作れない）
  const [weatherMounted, setWeatherMounted] = useState(weatherActive);
  useEffect(() => {
    if (weatherActive) setWeatherMounted(true);
  }, [weatherActive]);
  const [weather, setWeather] = useStored<WeatherSettings>(WEATHER_SETTINGS_KEY, parseWeatherSettings, DEFAULT_WEATHER);
  const [weatherCenter, setWeatherCenter] = useState<WeatherCenter | null>(null);
  useEffect(() => {
    if (earthActive) setEarthMounted(true);
  }, [earthActive]);
  // 見ている範囲（地球儀を動かし終わるたび）。飛行機などは、この範囲だけ取りに行く
  const [viewBox, setViewBox] = useState<BBox | null>(null);
  const [viewHeight, setViewHeight] = useState<number | null>(null);
  // ライブカメラを探す場所：ピックアップした場所（声・文字の指示）。無ければ、寄って見ている所の中心
  const [camFocus, setCamFocus] = useState<{ name: string; lat: number; lon: number; radiusKm: number; traffic: boolean } | null>(null);
  // 声・文字の指示を受けたときの一言（数秒で消す）
  const [cmdNote, setCmdNote] = useState<{ text: string; key: number } | null>(null);
  // ピックアップした場所の近くの飛行機などを、データが届いたら選んで追う
  const [pendingTrack, setPendingTrack] = useState<{ target: TrackTarget; lat: number; lon: number; until: number } | null>(null);
  const viewCenter = viewBox ? { lat: (viewBox.lamin + viewBox.lamax) / 2, lon: (viewBox.lomin + viewBox.lomax) / 2 } : null;
  const passiveCams =
    viewBox && viewCenter && viewHeight !== null && viewHeight <= WEBCAM_MAX_VIEW_HEIGHT_M
      ? webcamQuery(viewCenter.lat, viewCenter.lon, Math.min(WEBCAM_RADIUS_MAX, distanceKm(viewBox.lamin, viewBox.lomin, viewBox.lamax, viewBox.lomax) / 2))
      : null;
  /** 地球儀で見ている所（天気の地図を開く場所）。地球全体を見ているときは決めない（既定の場所で開く） */
  const weatherAtView = viewBox && viewCenter && viewBox.lomax - viewBox.lomin <= 120 ? { ...viewCenter, zoom: zoomForHeight(viewHeight) } : null;
  const camQuery = earth.webcams ? (camFocus ? webcamQuery(camFocus.lat, camFocus.lon, camFocus.radiusKm) : passiveCams) : null;
  const camTraffic = camFocus?.traffic ?? false;
  const streamPlace = useMemo(() => {
    const at = camFocus ?? (camsActive && camQuery ? { name: "この辺り", lat: camQuery.lat, lon: camQuery.lon, traffic: false } : null);
    if (!at) return null;
    const name = at.name !== "この辺り" ? at.name : (nearestCity(at.lat, at.lon)?.name ?? null);
    return name ? { place: name, lat: at.lat, lon: at.lon, traffic: at.traffic } : null;
  }, [camFocus, camsActive, camQuery?.lat, camQuery?.lon]); // eslint-disable-line react-hooks/exhaustive-deps
  const [city3d, setCity3d] = useState<{ state: "off" | "loading" | "ready" | "error"; message?: string }>({ state: "off" });
  const earthData = useEarthData({
    active: earthActive,
    quakes: earth.quakes,
    sats: earth.sats,
    satGroup: earth.satGroup,
    radar: earth.radar,
    aircraft: earth.aircraft,
    buses: earth.buses,
    ships: earth.ships,
    viewBox,
    webcams: camQuery ? { ...camQuery, traffic: camTraffic } : null,
    // ライブ配信（YouTube）：LIVE を見ている間（またはピックアップした場所があるとき）。場所の名前が無ければ、いちばん近い街の名前で探す
    livestreams: streamPlace,
    needConfig: weatherActive || camsActive,
  });
  // 渋滞：寄って見ているときだけ、見ている範囲（0.5 度刻みに広げたもの）の画像だけ取りに行く
  const trafficRect = viewBox && bboxArea(viewBox) <= TRAFFIC_MAX_VIEW_AREA ? roundBBox(viewBox) : null;
  const trafficUrl = earth.traffic && earthData.config?.services.tomtom && trafficRect ? TRAFFIC_TILE_URL : null;
  const busItems = earth.buses && earthData.busesInView ? (earthData.buses.data?.items ?? NONE) : NONE;
  const shipItems = earth.ships && earthData.shipsInView ? (earthData.ships.data?.items ?? NONE) : NONE;
  const city3dKey = earth.city3d ? (earthData.config?.google3dKey ?? null) : null;
  // 今日の地球（NASA GIBS）に使う日：UTC の前日（日付が変わったら変わる）
  const cloudsDate = gibsDate(earthData.now);
  const radarUrl = earth.radar ? (earthData.radar.data?.items[0]?.url ?? null) : null;
  const [imageryErrors, setImageryErrors] = useState<Partial<Record<ImageryKind, boolean>>>({});
  // 画像の種類を切り替えた・日付やレーダーの画像が変わったら、読み込みの失敗の表示を消して確かめ直す
  useEffect(() => setImageryErrors({}), [earth.detail, earth.clouds, cloudsDate, radarUrl]);
  const [earthSel, setEarthSel] = useState<string | null>(null);
  const [earthTrack, setEarthTrack] = useState<string | null>(null);
  const [earthFly, setEarthFly] = useState<EarthFlyTo | null>(null);
  const [earthReset, setEarthReset] = useState(0);
  const [earthView, setEarthView] = useState("LOADING");
  const quakeItems = earthData.quakes.data?.items ?? NONE;
  const satElements = earthData.sats.data?.elements ?? NONE;
  const selQuake = earthSel?.startsWith("quake:") ? quakeItems.find((q) => `quake:${q.id}` === earthSel) : undefined;
  const selSat = earthSel?.startsWith("sat:") ? satElements.find((e) => `sat:${e.id}` === earthSel) : undefined;
  const aircraftItems = earthData.aircraft.data?.items ?? NONE;
  const selAir = earthSel?.startsWith("air:") ? aircraftItems.find((a) => `air:${a.icao24}` === earthSel) : undefined;
  const selBus = earthSel?.startsWith("bus:") ? busItems.find((b) => `bus:${b.id}` === earthSel) : undefined;
  const selShip = earthSel?.startsWith("ship:") ? shipItems.find((x) => `ship:${x.mmsi}` === earthSel) : undefined;
  const camItems = earth.webcams && camQuery ? (earthData.webcams.data?.items ?? NONE) : NONE;
  const selCam = earthSel?.startsWith("cam:") ? camItems.find((c) => `cam:${c.id}` === earthSel) : undefined;
  // LIVE の一覧：ライブ配信（YouTube。いま配信中の動画）を先に、続いて公開カメラ（Windy）
  const streamItems = streamPlace ? (earthData.livestreams.data?.items ?? NONE) : NONE;
  const wallItems = useMemo<WallItem[]>(
    () => [
      ...streamItems.map((x) => ({
        key: `yt:${x.id}`,
        kind: "stream" as const,
        title: x.title,
        sub: x.channel,
        lat: null,
        lon: null,
        thumbnail: x.thumbnail,
        still: null,
        player: liveEmbedUrl(x.id),
        detail: liveWatchUrl(x.id),
        at: x.startedAt,
        viewers: x.viewers,
        traffic: false,
      })),
      ...camItems.map((c) => ({
        key: `cam:${c.id}`,
        kind: "cam" as const,
        title: c.title,
        sub: [c.city, c.country].filter(Boolean).join(" · ") || null,
        lat: c.lat,
        lon: c.lon,
        thumbnail: c.thumbnail,
        still: c.preview,
        player: c.player,
        detail: c.detail,
        at: c.updatedAt,
        viewers: null,
        traffic: c.traffic,
      })),
    ],
    [streamItems, camItems],
  );
  const wallFetchedAt = [earthData.livestreams.data?.fetchedAt, earthData.webcams.data?.fetchedAt].filter((x): x is string => Boolean(x)).sort().pop();
  const flyTo = (lat: number, lon: number, height?: number) => setEarthFly((f) => ({ lat, lon, height, key: (f?.key ?? 0) + 1 }));

  /* ---------- 声・文字の指示（「渋谷をピックアップ」「雨雲を出して」など。src/lib/edith-commands.ts） ---------- */
  /** 近くの飛行機・船・バスのうち一番近いもの（maxKm より遠ければ無し） */
  const nearestMover = (target: TrackTarget, at: { lat: number; lon: number }, maxKm = Infinity): { id: string; label: string } | null => {
    let best: { id: string; label: string; d: number } | null = null;
    const consider = (id: string, label: string, lat: number, lon: number) => {
      const d = distanceKm(at.lat, at.lon, lat, lon);
      if (d <= maxKm && (!best || d < best.d)) best = { id, label, d };
    };
    if (target === "aircraft") for (const a of aircraftItems) {
      const pos = aircraftPositionAt(a, earthData.now);
      consider(`air:${a.icao24}`, a.callsign ?? a.icao24.toUpperCase(), pos.lat, pos.lon);
    }
    else if (target === "ship") for (const x of shipItems) consider(`ship:${x.mmsi}`, x.name ?? `MMSI ${x.mmsi}`, x.lat, x.lon);
    else for (const b of busItems) consider(`bus:${b.id}`, b.route ?? "都営バス", b.lat, b.lon);
    const found = best as { id: string; label: string; d: number } | null;
    return found ? { id: found.id, label: found.label } : null;
  };
  const note = (text: string) => setCmdNote({ text, key: Date.now() });
  const runCmdRef = useRef<(c: EdithCommand) => string>(() => "");
  runCmdRef.current = (c) => {
    const cfg = earthData.config;
    if (c.kind === "weather") {
      setD("gevMode", "weather");
      if (c.overlay) setWeather((w) => ({ ...w, overlay: c.overlay! }));
      const at = c.place ? { lat: c.place.lat, lon: c.place.lon, zoom: zoomForHeight(c.place.height) } : weatherAtView;
      if (at) setWeatherCenter((w) => ({ ...at, key: (w?.key ?? 0) + 1 }));
      const label = WINDY_OVERLAY_LABEL[c.overlay ?? weather.overlay];
      note(`WEATHER: ${label}${c.place ? ` · ${c.place.name}` : ""}`);
      const missing = cfg && !cfg.windyMapKey ? "Windy の天気の地図はキーが未設定のため表示できません。" : "";
      return missing || `${c.place ? `${c.place.name}の` : ""}${label}を表示します。`;
    }
    if (!earthActive) setD("gevMode", "earth");
    const keyMissing = (layer: string) => {
      if (!cfg) return "";
      if (layer === "traffic" && !cfg.services.tomtom) return "渋滞はキーが未設定のため表示できません。";
      if (layer === "buses" && !cfg.services.odpt) return "都営バスはキーが未設定のため表示できません。";
      if (layer === "ships" && !cfg.services.ais) return "船はキーが未設定のため表示できません。";
      if (layer === "webcams" && !cfg.services.webcams) return "ライブカメラはキーが未設定のため表示できません。";
      if (layer === "city3d" && !cfg.google3dKey) return "3D の街はキーが未設定のため表示できません。";
      return "";
    };
    switch (c.kind) {
      case "pickup": {
        const { name, lat, lon } = c.place;
        setEarthTrack(null);
        setEarthSel(null);
        setPendingTrack(null);
        let reply: string;
        if (c.city3d && !c.country) {
          setEarth((s) => ({ ...s, city3d: true }));
          setEarthFly((f) => ({ lat, lon, height: 1_600, pitch: -32, key: (f?.key ?? 0) + 1 }));
          reply = cfg && !cfg.google3dKey ? `${name}に寄ります。3D の街はキーが未設定のため、衛星写真で表示します。` : `${name}を3Dで表示します。`;
        } else {
          flyTo(lat, lon, c.place.height);
          reply = c.city3d ? `国全体は3Dでは表示できないため、${name}を上から表示します。` : `${name}をピックアップします。`;
        }
        if (c.cams) {
          setEarth((s) => ({ ...s, webcams: true }));
          setCamFocus({ name, lat, lon, radiusKm: c.country ? WEBCAM_RADIUS_MAX : WEBCAM_RADIUS_DEFAULT, traffic: c.traffic });
          setD("gevMode", "cams");
          reply +=
            cfg && !cfg.services.webcams && !cfg.services.youtube
              ? "カメラ映像はキーが未設定のため表示できません。"
              : c.traffic
                ? "近くの公開されている道路カメラとライブ配信を探します。"
                : "近くのライブ配信とライブカメラを探します。";
        }
        if (c.track) {
          const layer = c.track === "aircraft" ? "aircraft" : c.track === "ship" ? "ships" : "buses";
          setEarth((s) => ({ ...s, [layer]: true }));
          setPendingTrack({ target: c.track, lat, lon, until: Date.now() + 90_000 });
          reply += keyMissing(layer) || `近くの${TRACK_LABEL[c.track]}を探して追跡します。`;
        }
        note(`PICKUP: ${name}${c.city3d && !c.country ? " · 3D" : ""}${c.cams ? (c.traffic ? " · 道路カメラ" : " · LIVE CAMS") : ""}${c.track ? ` · ${TRACK_LABEL[c.track]}を追跡` : ""}`);
        return reply;
      }
      case "cams": {
        if (!viewCenter || viewHeight === null || viewHeight > WEBCAM_MAX_VIEW_HEIGHT_M) {
          note("LIVE CAMS: もっと寄ってください");
          return "もう少し寄るか、「渋谷をピックアップ」のように場所を言ってください。";
        }
        setEarth((s) => ({ ...s, webcams: true }));
        setCamFocus({ name: "この辺り", lat: viewCenter.lat, lon: viewCenter.lon, radiusKm: passiveCams?.radiusKm ?? WEBCAM_RADIUS_DEFAULT, traffic: c.traffic });
        setD("gevMode", "cams");
        note(c.traffic ? "LIVE CAMS: この辺りの道路カメラ" : "LIVE CAMS: この辺り");
        return keyMissing("webcams") || (c.traffic ? "この辺りの公開されている道路カメラを探します。" : "この辺りのライブカメラを探します。");
      }
      case "track": {
        const layer = c.target === "aircraft" ? "aircraft" : c.target === "ship" ? "ships" : "buses";
        setEarth((s) => ({ ...s, [layer]: true }));
        const missing = keyMissing(layer);
        if (missing) return missing;
        const at = viewCenter;
        const found = at ? nearestMover(c.target, at) : null;
        if (found) {
          setEarthSel(found.id);
          setEarthTrack(found.id);
          note(`TRACKING: ${found.label}`);
          return `${TRACK_LABEL[c.target]}「${found.label}」を追跡します。`;
        }
        if (at && viewHeight !== null && viewHeight <= WEBCAM_MAX_VIEW_HEIGHT_M) {
          setPendingTrack({ target: c.target, lat: at.lat, lon: at.lon, until: Date.now() + 90_000 });
          note(`TRACKING: ${TRACK_LABEL[c.target]}を探しています`);
          return `近くの${TRACK_LABEL[c.target]}を探しています。見つかったら追跡します。`;
        }
        note(`TRACKING: もっと寄ってください`);
        return `もう少し寄ると、${TRACK_LABEL[c.target]}を探せます。`;
      }
      case "untrack":
        setEarthTrack(null);
        setPendingTrack(null);
        note("TRACKING: 解除");
        return "追跡を解除しました。";
      case "layer": {
        setEarth((s) => ({ ...s, [c.layer]: c.on }));
        if (c.layer === "webcams" && !c.on) {
          setCamFocus(null);
        }
        note(`${LAYER_LABEL[c.layer]}: ${c.on ? "ON" : "OFF"}`);
        return `${LAYER_LABEL[c.layer]}を${c.on ? "表示します" : "消します"}。${c.on ? keyMissing(c.layer) : ""}`;
      }
      case "reset":
        setEarthTrack(null);
        setEarthSel(null);
        setPendingTrack(null);
        setCamFocus(null);
        setEarthReset((k) => k + 1);
        note("VIEW: 地球全体");
        return "地球全体に戻します。";
    }
  };
  useEffect(() => setEdithCommandHandler((c) => runCmdRef.current(c)), []);
  // 一言は数秒で消す
  useEffect(() => {
    if (!cmdNote) return;
    const t = window.setTimeout(() => setCmdNote(null), 5000);
    return () => clearTimeout(t);
  }, [cmdNote]);
  // ピックアップした場所の近くの飛行機などを、データが届いたら選んで追う（90 秒たっても見つからなければやめる）
  useEffect(() => {
    if (!pendingTrack) return;
    if (Date.now() > pendingTrack.until) {
      setPendingTrack(null);
      return;
    }
    const found = nearestMover(pendingTrack.target, pendingTrack, 150);
    if (!found) return;
    setPendingTrack(null);
    setEarthSel(found.id);
    setEarthTrack(found.id);
    note(`TRACKING: ${found.label}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingTrack, aircraftItems, shipItems, busItems]);
  // ピックアップした場所から大きく離れたら、その場所のカメラの一覧は片付ける（寄って見ている所のカメラに戻る）
  useEffect(() => {
    if (!camFocus || !viewCenter) return;
    if (distanceKm(camFocus.lat, camFocus.lon, viewCenter.lat, viewCenter.lon) > Math.max(40, camFocus.radiusKm * 3)) {
      setCamFocus(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewBox]);
  const earthSummary = `地震 ${earth.quakes ? earthData.quakes.status : "OFF"} · 衛星 ${earth.sats ? earthData.sats.status : "OFF"}${earthTrack ? " · TRACKING" : ""}`;
  const [page, setPage] = useStored<Page>(PAGE_KEY, parsePage, "display");
  const [preset, setPreset] = useStored<PresetKey>(`${DISPLAY_KEY}.preset`, parsePreset, "tactical");
  const [cat, setCat] = useState<EdithCategory>("news");
  const { state: news, retry } = useEdithNews(cat);
  const allNews = useAllLoadedNews();
  const [selected, setSelected] = useState<string | null>(null);
  const [autoRotate, setAutoRotate] = useState(true);
  const [resetKey, setResetKey] = useState(0);
  const [view, setView] = useState<{ lat: number; lon: number } | null>(null);
  const [wins, setWins] = useState<Win[]>([]);
  const [panel, setPanel] = useState<"none" | "left" | "right">("none");
  const [quick, setQuick] = useState<QuickKind | null>(null);
  const [quickText, setQuickText] = useState("");
  const [cmd, setCmd] = useState("");
  const cmdRef = useRef<HTMLInputElement>(null);
  const quickRef = useRef<HTMLInputElement>(null);

  // E.D.I.T.H. を開いたあとの返答を、情報ウィンドウとして開く（リアルタイム会話の文字起こしは除く）
  const openedAt = useRef(Date.now());
  const known = useRef(new Set<string>());
  useEffect(() => {
    const fresh = messages.filter((m) => m.role === "assistant" && m.createdAt >= openedAt.current - 500 && !m.id.startsWith("live-") && !known.current.has(m.id));
    if (!fresh.length) return;
    for (const m of fresh) known.current.add(m.id);
    setWins((w) => {
      const next: Win[] = [...w, ...fresh.map((m) => ({ id: m.id, kind: "answer" as const, msgId: m.id }))];
      // 答えのウィンドウは新しい 3 つまで（古いものから閉じる。会話の記録には残る）
      while (next.filter((x) => x.kind === "answer").length > 3) next.splice(next.findIndex((x) => x.kind === "answer"), 1);
      return next;
    });
  }, [messages]);

  // CLEAN UI のときは Esc で元に戻す
  useEffect(() => {
    if (!display.clean) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setDisplay((d) => ({ ...d, clean: false }));
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [display.clean, setDisplay]);

  // リアルタイム会話のやりとり（声で話した内容と E.D.I.T.H. の返事）。最後の 1 往復を、操作バーの上に出す
  const liveLines = useMemo(() => messages.filter((m) => m.id.startsWith("live-") && m.createdAt >= openedAt.current - 500 && m.content.trim()).slice(-2), [messages]);
  const lastLiveAt = liveLines.length ? Math.max(...liveLines.map((m) => m.createdAt)) : 0;
  const showLive = liveLines.length > 0 && voiceState !== "off" && (voiceState !== "standby" || (now ? now.getTime() - lastLiveAt < 25_000 : true));

  const items: EdithNewsItem[] = news.status === "ready" ? news.items : [];
  // AI の答え（開いている情報ウィンドウ）に出てきた国・都市
  const answerPlaces = useMemo(() => {
    const texts = wins.flatMap((w) => (w.kind === "answer" ? [messages.find((m) => m.id === w.msgId)?.content ?? ""] : []));
    return findPlaces(texts.join("\n"), 6);
  }, [wins, messages]);
  const points: GlobePoint[] = useMemo(
    () => [
      ...items.flatMap((it, i) => (it.place ? [{ id: `${cat}-${i}`, lat: it.place.lat, lon: it.place.lon, label: it.place.name }] : [])),
      ...answerPlaces.map((p) => ({ id: `ai-${p.name}`, lat: p.lat, lon: p.lon, label: p.name, hot: true })),
    ],
    [items, cat, answerPlaces],
  );
  const selectedItem = selected?.startsWith(`${cat}-`) ? items[Number(selected.slice(cat.length + 1))] : undefined;
  const selectedAi = selected?.startsWith("ai-") ? answerPlaces.find((p) => `ai-${p.name}` === selected) : undefined;

  const chooseCat = (c: EdithCategory) => {
    setCat(c);
    setSelected(null);
  };
  const showPage = (p: Page) => {
    setPage(() => p);
    setPanel("right");
  };
  const openWin = (kind: "analysis" | "context") => {
    setWins((w) => [...w.filter((x) => x.kind !== kind), { id: kind, kind }].slice(-4));
    setPanel("none");
  };
  const closeWin = (id: string) => setWins((w) => w.filter((x) => x.id !== id));
  const front = (id: string) => setWins((w) => [...w.filter((x) => x.id !== id), ...w.filter((x) => x.id === id)]);
  const setD = <K extends keyof DisplaySettings>(k: K, v: DisplaySettings[K]) => setDisplay((d) => ({ ...d, [k]: v }));
  const cyclePreset = () => {
    const next = nextPreset(preset);
    setPreset(() => next);
    setDisplay((d) => applyPreset(next, d));
  };

  const submit = useCallback(
    (text: string) => {
      const t = text.trim();
      if (!t) return;
      onCommand(t);
      setCmd("");
    },
    [onCommand],
  );

  /** QUICK ACCESS：入力された言葉で、それぞれの機能を実行する */
  const runQuick = (kind: QuickKind, raw: string) => {
    const q = raw.trim();
    if (!q) {
      setQuick(kind);
      quickRef.current?.focus();
      return;
    }
    if (kind === "image") onOpenUrl(`https://www.google.com/search?tbm=isch&q=${encodeURIComponent(q)}`);
    else if (kind === "web") onCommand(`「${q}」について Web で検索して、要点をまとめて`);
    else if (kind === "doc") onCommand(`「${q}」について資料を作って`);
    else onCommand(`次の文章を翻訳して（日本語なら英語に、それ以外なら日本語に）：\n${q}`);
    setQuick(null);
    setQuickText("");
  };

  const trend = useMemo(() => trendCounts(allNews), [allNews]);
  const regions = useMemo(() => regionCounts(allNews), [allNews]);
  const trendMax = Math.max(1, ...trend.map((t) => t.count));
  const listening = voiceState === "listening";
  const speaking = voiceState === "speaking";

  // 左の「AI」：実際の接続状態（/api/status と音声の状態）
  const contextCount = Math.min(messages.filter((m) => m.content.trim()).length, maxContext);
  const aiRows: { key: string; label: string; on: boolean | null; value?: string; ratio?: number; hint: string }[] = [
    { key: "brain", label: "BRAIN", on: brain ? brain.connected : null, hint: brain?.configured ? (brain.connected ? "脳（Obsidian）に接続しています" : "脳（Obsidian）に接続できていません") : "脳（Obsidian）は未設定です" },
    { key: "calendar", label: "CALENDAR", on: calendar ? calendar.connected : null, hint: calendar?.connected ? "Google カレンダーに接続しています" : "Google カレンダーは未接続です" },
    { key: "voice", label: "VOICE", on: voiceState !== "off", hint: voiceState !== "off" ? "音声で話しかけられます" : "音声はオフです" },
    { key: "response", label: "RESPONSE", on: aiStatus === "checking" ? null : aiStatus === "online", hint: aiStatus === "online" ? `AI が応答できます${model ? `（${model}）` : ""}` : aiStatus === "offline" ? "AI に接続できていません" : "AI の状態を確認しています" },
    { key: "context", label: "CONTEXT", on: true, value: `${contextCount}/${maxContext}`, ratio: maxContext ? contextCount / maxContext : 0, hint: `会話の記憶：${contextCount} / ${maxContext} 件` },
  ];

  const mb = (v: number) => (v >= 1024 ? `${(v / 1024).toFixed(1)}GB` : `${v < 10 ? v.toFixed(1) : Math.round(v)}MB`);
  const sysRows: { key: string; label: string; icon: keyof typeof P; value: string; ratio: number | null; hint: string }[] = [
    { key: "cpu", label: "CPU", icon: "cpu", value: metrics.cores ? `${metrics.cores} CORES` : "—", ratio: null, hint: metrics.cores ? `CPU のコア数（使用率はブラウザからは測れません）` : "CPU の情報は取得できません" },
    { key: "memory", label: "MEMORY", icon: "mem", value: metrics.memory ? `${Math.round(metrics.memory.ratio * 100)}%` : "—", ratio: metrics.memory?.ratio ?? null, hint: metrics.memory ? `この画面が使っているメモリ ${mb(metrics.memory.usedMb)}（JS ヒープ）` : "このブラウザではメモリの使用量を取得できません" },
    { key: "storage", label: "STORAGE", icon: "disk", value: metrics.storage ? mb(metrics.storage.usedMb) : "—", ratio: metrics.storage?.ratio ?? null, hint: metrics.storage ? "このアプリが端末に保存している量（ブラウザの見積もり）" : "保存量は取得できません" },
    { key: "network", label: "NETWORK", icon: "net", value: metrics.downlink !== null ? `${metrics.downlink}Mbps` : sys.online ? "ONLINE" : "OFFLINE", ratio: metrics.downlink !== null ? Math.min(1, metrics.downlink / 10) : null, hint: metrics.downlink !== null ? "回線の速さの目安（ブラウザの推定）" : "回線の速さは取得できません" },
  ];

  const viewLat = view?.lat ?? HOME.lat;
  const viewLon = view?.lon ?? HOME.lon;
  const latStr = (v: number) => `${Math.abs(v).toFixed(4)}° ${v >= 0 ? "N" : "S"}`;
  const lonStr = (v: number) => `${Math.abs(v).toFixed(4)}° ${v >= 0 ? "E" : "W"}`;
  const jst = now ? new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", hour: "2-digit", minute: "2-digit", hour12: false }).format(now) : "—";
  const sun = now ? solarElevation(now, viewLat, viewLon) : null;
  const sunStr = sun === null ? "—" : `${sun >= 0 ? "" : "-"}${Math.abs(sun).toFixed(1)}° EL`;
  const utc = now ? now.toISOString().slice(0, 19).replace("T", " ") + "Z" : "—";
  const fpsNow = fps.length ? fps[fps.length - 1] : null;
  const presetLabel = PRESETS.find((p) => p.key === preset)?.label ?? "TACTICAL";

  // GOD'S EYE VIEW の映像に渡す表示設定
  const viewStyle = {
    "--fade": display.fade / 100,
    "--outside": display.outside / 100,
    "--sharp": display.sharpen ? 1 + (display.sharpenAmt / 100) * 0.5 : 1,
  } as CSSProperties;

  return (
    <div
      className="edith"
      role="application"
      aria-label="E.D.I.T.H. グローバルインテリジェンスシステム"
      data-panel={panel}
      data-clean={display.clean || undefined}
      data-layout={display.layout}
      data-hud={display.hud || undefined}
      data-feed={feed.status}
      data-gev={gevMode}
    >
      <div className="edith__grid" aria-hidden="true" />
      {display.celestial && <div className="edith__stars" aria-hidden="true" />}
      <Frame />

      {/* ---------- 右上：日時・接続 ---------- */}
      <header className="estatus">
        <span className="estatus__clock">
          {now ? (
            <>
              <span className="estatus__date">{`${now.getFullYear()}.${two(now.getMonth() + 1)}.${two(now.getDate())}  ${DOW[now.getDay()]}  `}</span>
              {`${two(now.getHours())}:${two(now.getMinutes())}:${two(now.getSeconds())}`}
            </>
          ) : (
            "—"
          )}
        </span>
        <span className="estatus__online" data-on={sys.online || undefined}>{sys.online ? "ONLINE" : "OFFLINE"} · Gemini</span>
        <span className="estatus__net" title={sys.net ? `通信：${sys.net}` : "通信の種類は取得できません"}><I n="wifi" s={15} /></span>
        <span className="estatus__bat" title={sys.battery === null ? "電池の残量は取得できません" : "電池の残量"}>
          <span className="estatus__batbar"><i style={{ width: `${Math.round((sys.battery ?? 0) * 100)}%` }} /></span>
          {sys.battery === null ? "—" : `${Math.round(sys.battery * 100)}%`}
        </span>
        <button type="button" className="estatus__btn" title="システム設定" aria-label="システム設定" onClick={onOpenSettings}><I n="gear" s={15} /></button>
        <button type="button" className="estatus__btn estatus__back" title="F.R.I.D.A.Y. に戻る" aria-label="F.R.I.D.A.Y. に戻る" onClick={onBack}><I n="back" s={15} /><span>F.R.I.D.A.Y.</span></button>
      </header>
      <div className="etoggles">
        <button type="button" aria-label="システムを開く" aria-pressed={panel === "left"} onClick={() => setPanel((p) => (p === "left" ? "none" : "left"))}>システム</button>
        <button type="button" aria-label="表示設定とニュースを開く" aria-pressed={panel === "right"} onClick={() => setPanel((p) => (p === "right" ? "none" : "right"))}>情報</button>
      </div>

      {/* ---------- 左：ロゴ・ナビ・システム・AI・現在地 ---------- */}
      <aside className="eleft" aria-label="システム">
        <div className="ebrand">
          <span className="ebrand__logo"><I n="eye" s={34} /></span>
          <span className="ebrand__titles">
            <span className="ebrand__name">EDITH</span>
            <span className="ebrand__motto">NO PLACE LEFT BEHIND</span>
          </span>
        </div>
        <nav className="enav" aria-label="E.D.I.T.H. のナビゲーション">
          <button type="button" title="情報を集める（分野ごとのニュース）" onClick={() => showPage("news")}>AGENTS</button>
          <button type="button" title="取得した情報の集計" onClick={() => openWin("analysis")}>NOTES</button>
          <button type="button" title="クイックアクセス（Web 検索・画像検索・資料作成・翻訳）" onClick={() => (showPage("tasks"), setTimeout(() => quickRef.current?.focus(), 50))}>TASKS</button>
          <button type="button" title="最近の会話" onClick={() => openWin("context")}>CONTEXT</button>
        </nav>

        <section className="ebox esys" aria-label="SYSTEM STATUS">
          <h2 className="ebox__title"><span className="edot" />SYSTEM STATUS<span className="ebox__dash" /></h2>
          <ul className="esys__list">
            {sysRows.map((r) => (
              <li key={r.key} title={r.hint}>
                <span className="esys__icon"><I n={r.icon} s={20} /></span>
                <span className="esys__label">{r.label}</span>
                <span className="esys__bar" data-empty={r.ratio === null || undefined}><i style={{ width: `${Math.round((r.ratio ?? 0) * 100)}%` }} /></span>
                <span className="esys__value">{r.value}</span>
              </li>
            ))}
          </ul>
          <h3 className="ebox__sub"><span className="edot" />CURRENT MODE<span className="ebox__dash" /></h3>
          <button type="button" className="emode" data-state={voiceState} title={MODE_HINT[voiceState]} onClick={onMic}>
            <I n="logo" s={17} />
            <span>{MODE_LABEL[voiceState]}</span>
          </button>
          <h3 className="ebox__sub ebox__sub--ai"><I n="logo" s={12} />AI</h3>
          <ul className="eai">
            {aiRows.map((r) => (
              <li key={r.key} title={r.hint}>
                <span className="eai__label">{r.label}</span>
                <span className="eai__bar" data-on={r.on || undefined}><i style={{ width: `${r.ratio !== undefined ? Math.round(r.ratio * 100) : r.on ? 70 : 0}%` }} /></span>
                <span className="eai__value" data-on={r.on || undefined}>{r.value ?? (r.on === null ? "—" : r.on ? "ON" : "OFF")}</span>
              </li>
            ))}
          </ul>
        </section>

        <section className="eloc" aria-label="現在地">
          <Radar />
          <div className="eloc__text">
            <b><I n="pin" s={14} />{HOME.name}</b>
            <span>{`${latStr(HOME.lat)}  ${lonStr(HOME.lon)}`}</span>
            <small>{jst}  JST</small>
          </div>
        </section>

        <section className="ebox echart edeco" aria-label="描画の速さ" title="この画面の描画の速さ（1 秒ごとに実測）">
          <p className="echart__head"><span>RENDER</span><b>{fpsNow === null ? "—" : `${fpsNow} FPS`}</b></p>
          <Bars values={fps} max={Math.max(60, ...fps)} />
        </section>

        <footer className="efoot">
          <span className="efoot__brand"><I n="eye" s={18} />EDITH</span>
          <span className="efoot__attr">MAP DATA: Natural Earth</span>
        </footer>
      </aside>

      {/* ---------- 中央：GOD'S EYE VIEW（リアルタイム映像。既存のビューポートに映す） ---------- */}
      <main className="ecenter" aria-label="ビューポート">
        <div className="eview" style={viewStyle} data-shape={shape} data-gev={gevMode} data-feed={feed.status} data-bloom={display.bloom || undefined} data-3d={display.threeD || undefined}>
          <Bezel />
          <Gauges />
          {/* 横長の枠の角飾り（横長のときだけ見える） */}
          <span className="eview__corners" aria-hidden="true"><i /><i /><i /><i /></span>
          {/* GOD'S EYE VIEW の映像を入れる場所（Web カメラ・画面共有）。表示設定は data 属性と CSS 変数で渡す */}
          <div
            className="eview__slot"
            data-gev-slot=""
            data-sparse={display.sparse || undefined}
            data-density={display.density}
            data-allocation={display.allocation}
            data-outside={display.outside}
            role="region"
            aria-label={earthActive ? `God's Eye View の 3D 地球儀（${earthSummary}）` : camsActive ? `God's Eye View のライブカメラ（${camFocus?.name ?? "この辺り"}）` : weatherActive ? `God's Eye View の天気の地図（${WINDY_OVERLAY_LABEL[weather.overlay]}）` : `God's Eye View の映像（${feedSum.status}）`}
          >
            {/* LOCAL FEED：EARTH の間も外さない（カメラ・画面共有を止めない。見えないようにするだけ） */}
            <div className="egev-feed" hidden={!feedActive}>
              <EdithFeedView shape={shape} />
            </div>
            {earthMounted && (
              <div className="egev-earth" hidden={!earthActive}>
                <EdithEarth
                  active={earthActive}
                  quakes={quakeItems}
                  showQuakes={earth.quakes}
                  sats={satElements}
                  showSats={earth.sats}
                  satLimit={earth.satLimit}
                  selectedId={earthSel}
                  onSelect={setEarthSel}
                  trackedId={earthTrack}
                  onTrackLost={() => setEarthTrack(null)}
                  autoRotate={earth.autoRotate}
                  flyTo={earthFly}
                  resetKey={earthReset}
                  onStatus={(s) => setEarthView(s.toUpperCase())}
                  imagery={{ detail: earth.detail, clouds: earth.clouds, cloudsDate, radarUrl, trafficUrl, trafficRect }}
                  onImageryError={(k) => setImageryErrors((e) => (e[k] ? e : { ...e, [k]: true }))}
                  city3dKey={city3dKey}
                  onCity3d={(state, message) => setCity3d({ state, message })}
                  aircraft={aircraftItems}
                  showAircraft={earth.aircraft}
                  onView={(b, h) => {
                    setViewBox(b);
                    setViewHeight(h);
                  }}
                  buses={busItems}
                  ships={shipItems}
                  webcams={camItems}
                />
              </div>
            )}
            {camsActive && (
              <div className="egev-cams">
                <EdithCamWall
                  place={camFocus?.name ?? "この辺り"}
                  items={wallItems}
                  counts={{ streams: streamItems.length, cams: camItems.length }}
                  fetchedAt={wallFetchedAt}
                  now={earthData.now}
                  traffic={camTraffic}
                  note={
                    earthData.config && !earthData.config.services.youtube
                      ? "ライブ配信は YOUTUBE_API_KEY が未設定"
                      : earthData.config && !earthData.config.services.webcams
                        ? "公開カメラは WINDY_WEBCAMS_KEY が未設定"
                        : earthData.livestreams.fetch.lastError && !earthData.livestreams.data
                          ? earthData.livestreams.fetch.lastError
                          : null
                  }
                  emptyText={
                    earthData.config && !earthData.config.services.webcams && !earthData.config.services.youtube
                      ? "カメラ映像のキーが未設定です（Vercel の環境変数 YOUTUBE_API_KEY・WINDY_WEBCAMS_KEY）"
                      : !camQuery
                        ? "「渋谷をピックアップ」のように場所を言うか、地球儀で街に寄ってから開いてください"
                        : earthData.webcams.fetch.lastError && !earthData.webcams.data && !earthData.livestreams.data
                          ? earthData.webcams.fetch.lastError
                          : earthData.webcams.data || earthData.livestreams.data
                            ? "近くに公開されているカメラ映像が見つかりませんでした"
                            : "近くのカメラ映像を探しています…"
                  }
                  onShowOnEarth={(it) => {
                    setD("gevMode", "earth");
                    setEarthTrack(null);
                    if (it.kind === "cam" && it.lat !== null && it.lon !== null) {
                      setEarthSel(it.key);
                      flyTo(it.lat, it.lon, 3_000);
                    } else if (camFocus) flyTo(camFocus.lat, camFocus.lon, 20_000);
                  }}
                />
              </div>
            )}
            {weatherMounted && (
              <div className="egev-weather" hidden={!weatherActive}>
                <EdithWeather active={weatherActive} apiKey={earthData.config?.windyMapKey ?? null} configLoading={!earthData.config} overlay={weather.overlay} center={weatherCenter} />
              </div>
            )}
          </div>
          {/* EARTH / WEATHER / LOCAL FEED の切り替え */}
          <div className="egev-mode" role="tablist" aria-label="GOD'S EYE VIEW に映すもの">
            <button type="button" role="tab" aria-selected={camsActive} data-on={camsActive || undefined} onClick={() => setD("gevMode", "cams")} title="ピックアップした場所のライブカメラ（運営者が公開しているもの）">
              LIVE
            </button>
            <button type="button" role="tab" aria-selected={earthActive} data-on={earthActive || undefined} onClick={() => setD("gevMode", "earth")}>
              EARTH
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={weatherActive}
              data-on={weatherActive || undefined}
              onClick={() => {
                // 地球儀で見ていた場所の天気の地図を開く
                if (!weatherActive && weatherAtView) setWeatherCenter((w) => ({ ...weatherAtView, key: (w?.key ?? 0) + 1 }));
                setD("gevMode", "weather");
              }}
              title="Windy の天気の地図（風・雨・気温・雲・気圧・波）"
            >
              WEATHER
            </button>
            <button type="button" role="tab" aria-selected={feedActive} data-on={feedActive || undefined} onClick={() => setD("gevMode", "feed")} title={feed.status === "live" ? "LOCAL FEED は接続中です（EARTH の間も止めていません）" : "Web カメラ・画面共有"}>
              {feed.status === "live" && <i className="egev-mode__rec" aria-label="接続中" />}
              LOCAL FEED
            </button>
          </div>
          <span className="eview__link" aria-hidden="true"><I n="link" s={20} /></span>
          {earthActive ? (
            <span className="eview__live" data-on={earthData.quakes.status === "LIVE" || earthData.sats.status === "LIVE" || undefined}>EARTH &gt; GOD&apos;S EYE VIEW : {earthSummary}</span>
          ) : camsActive ? (
            <span className="eview__live" data-on={wallItems.length > 0 || undefined}>LIVE &gt; GOD&apos;S EYE VIEW : PICKUP {camFocus?.name ?? "この辺り"}（{wallItems.length} 件）</span>
          ) : weatherActive ? (
            <span className="eview__live" data-on={Boolean(earthData.config?.windyMapKey) || undefined}>WEATHER &gt; GOD&apos;S EYE VIEW : {WINDY_OVERLAY_LABEL[weather.overlay]}（Windy）</span>
          ) : (
            <span className="eview__live" data-on={feed.status === "live" || undefined}>LIVE &gt; GOD&apos;S EYE VIEW : {feedSum.status}</span>
          )}
          {weatherActive && (
            <div className="eweather-bar" role="toolbar" aria-label="天気の地図に出すもの">
              {WINDY_OVERLAYS.map((o) => (
                <button key={o.key} type="button" aria-pressed={weather.overlay === o.key} data-on={weather.overlay === o.key || undefined} onClick={() => setWeather((w) => ({ ...w, overlay: o.key }))} title={o.label}>
                  {o.short}
                </button>
              ))}
            </div>
          )}
          {feedActive && <EdithFeedBar shape={display.feedShape} onShape={(v) => setD("feedShape", v)} focus={display.clean} onFocus={(v) => setD("clean", v)} />}
        </div>

        {(earthActive || weatherActive || camsActive) && cmdNote && (
          <p key={cmdNote.key} className="ecmd-note" role="status">
            {cmdNote.text}
          </p>
        )}
        {earthActive && (selQuake || selSat || selAir || selBus || selShip || selCam) && (
          <EarthDetail
            key={earthSel ?? ""}
            cam={selCam}
            camsFetchedAt={earthData.webcams.data?.fetchedAt}
            quake={selQuake}
            quakesFetchedAt={earthData.quakes.data?.fetchedAt}
            sat={selSat}
            aircraft={selAir}
            bus={selBus}
            busesFetchedAt={earthData.buses.data?.fetchedAt}
            ship={selShip}
            shipsFetchedAt={earthData.ships.data?.fetchedAt}
            aircraftFetchedAt={earthData.aircraft.data?.fetchedAt}
            satsFetchedAt={earthData.sats.data?.fetchedAt}
            now={earthData.now}
            tracked={earthTrack === earthSel}
            onTrack={() => setEarthTrack(earthSel)}
            onUntrack={() => setEarthTrack(null)}
            onFly={(lat, lon) => {
              setEarthTrack(null);
              flyTo(lat, lon);
            }}
            onClose={() => {
              setEarthSel(null);
              setEarthTrack(null);
            }}
          />
        )}
        {(selectedItem || selectedAi) && (
          <div className="epoint" role="dialog" aria-label="地点の詳細">
            <button type="button" className="epoint__close" onClick={() => setSelected(null)} aria-label="閉じる"><I n="close" s={14} /></button>
            {selectedItem ? (
              <>
                <p className="epoint__meta">{selectedItem.place?.name ?? selectedItem.region} · {CAT_LABEL[cat]}</p>
                <h3>{selectedItem.title}</h3>
                <p>{selectedItem.summary}</p>
                {news.status === "ready" && <p className="epoint__time">{ago(news.fetchedAt)}（地点は国・都市の代表地点）</p>}
                <Sources sources={selectedItem.sources.length ? selectedItem.sources : news.status === "ready" ? news.refs : []} />
                {!selectedItem.sources.length && <p className="epoint__time">（この話題だけの出典は特定できなかったため、一覧を作るのに参照したページを出しています）</p>}
                <button type="button" className="ebtn" onClick={() => submit(`「${selectedItem.title}」について詳しく調べて`)}>詳しく調べる</button>
              </>
            ) : (
              <>
                <p className="epoint__meta">{selectedAi!.name} · AI の答え</p>
                <p>情報ウィンドウの答えに出てきた地域です。</p>
                <button type="button" className="ebtn" onClick={() => submit(`${selectedAi!.name}の最新の動向を調べて`)}>この地域の最新動向を調べる</button>
              </>
            )}
          </div>
        )}

        {/* 情報ウィンドウ（AI の答え・分析・会話） */}
        <div className="ewins">
          {wins.map((w, i) => (
            <InfoWindow key={w.id} index={i} onClose={() => closeWin(w.id)} onFront={() => front(w.id)}>
              {w.kind === "answer" ? (
                <AnswerBody msg={messages.find((m) => m.id === w.msgId)} theme={themeOf(messages, w.msgId)} />
              ) : w.kind === "analysis" ? (
                <AnalysisBody trend={trend} regions={regions} total={allNews.length} />
              ) : (
                <ContextBody messages={messages} />
              )}
            </InfoWindow>
          ))}
        </div>

        {/* ---------- 下：指示の入力と、LOCATION ／ 声 ／ VISUAL PRESETS ---------- */}
        <div className="ecmd">
          {showLive && (
            <div className="elive" aria-live="polite" aria-label="リアルタイム会話">
              {liveLines.map((m) => (
                <p key={m.id} data-role={m.role} data-streaming={m.status === "streaming" || undefined}>
                  <b>{m.role === "user" ? "YOU" : "E.D.I.T.H."}</b>
                  <span>{m.content}</span>
                </p>
              ))}
            </div>
          )}
          {(voiceInterim || voiceError) && !(showLive && !voiceError && voiceState !== "listening") && (
            <p className="ecmd__caption" role="status">
              {voiceError ?? voiceInterim}
              {voiceError && <button type="button" onClick={onDismissVoiceError} aria-label="閉じる"><I n="close" s={12} /></button>}
            </p>
          )}
          <form
            className="ecmd__form"
            onSubmit={(e) => {
              e.preventDefault();
              submit(cmd);
            }}
          >
            <span className="ecmd__prompt" aria-hidden="true">&gt;</span>
            <input
              ref={cmdRef}
              value={cmd}
              onChange={(e) => setCmd(e.target.value)}
              placeholder={listening ? "聞いています…" : speaking ? "E.D.I.T.H. が話しています…" : "何を調べますか？"}
              aria-label="E.D.I.T.H. への指示"
              enterKeyHint="send"
            />
            <button type="submit" className="ecmd__send" aria-label="送信"><I n="send" s={18} /></button>
          </form>
        </div>
        <div className="edock">
          <button type="button" className="edock__side" onClick={() => setResetKey((k) => k + 1)} title="地図を東京（起点）に戻す">
            <I n="pin" s={20} />LOCATION
          </button>
          <div className="edock__mic">
            <small>{voiceState === "off" ? "AI AGENT OFF" : "AI AGENT ON"}</small>
            <button type="button" className="edock__orb" data-state={voiceState} onClick={onMic} aria-label={listening ? "聞いています" : "声で指示する"} title="声で指示する（ON/OFF）">
              <I n="mic" s={22} />
              <span />
            </button>
            <small className="edock__onoff">ON/OFF</small>
            <span className="edock__voice">
              <span className="edock__eq" data-active={listening || speaking || undefined} aria-hidden="true">
                {Array.from({ length: 9 }, (_, i) => <i key={i} style={{ ["--k" as string]: i }} />)}
              </span>
              VOICE {MODE_LABEL[voiceState].replace("VOICE ", "")}
            </span>
          </div>
          <button type="button" className="edock__side" onClick={cyclePreset} title={`表示のプリセットを切り替える（今：${presetLabel}）`}>
            <I n="presets" s={20} />
            <span className="edock__label">VISUAL PRESETS<small>{presetLabel}</small></span>
          </button>
        </div>
      </main>

      {/* ---------- 右：スタイル・表示設定／ニュース・計器 ---------- */}
      <aside className="eright" aria-label="インテリジェンスパネル">
        <section className="estyle" aria-label="ACTIVE STYLE">
          <div className="estyle__text">
            <small>ACTIVE STYLE</small>
            <b>EDITH</b>
          </div>
          <p className="estyle__coord" title="地図の視点の中心と、そこでの太陽の高度（日時と位置からの計算値）">
            <I n="pin" s={18} />
            <span>
              LAT {latStr(viewLat)}
              <br />
              LON {lonStr(viewLon)}
              <br />
              ALT —
              <br />
              SUN {sunStr}
            </span>
          </p>
          <Dial now={now} />
        </section>

        <section className="ebox ectl" aria-label="表示設定とインテリジェンス">
          <header className="ectl__rec">
            <p><span className="ectl__dot" />UTC {utc}</p>
            {earthActive ? (
              <p>SRC: GOD&apos;S EYE VIEW (EARTH)  FEED: {earthSummary}</p>
            ) : camsActive ? (
              <p>SRC: GOD&apos;S EYE VIEW (LIVE CAMS)  FEED: {camFocus?.name ?? "この辺り"} · ライブ {streamItems.length} · カメラ {camItems.length}</p>
            ) : weatherActive ? (
              <p>SRC: GOD&apos;S EYE VIEW (WEATHER)  FEED: {WINDY_OVERLAY_LABEL[weather.overlay]}（Windy）</p>
            ) : (
              <p>SRC: GOD&apos;S EYE VIEW{feed.kind && feed.status !== "idle" ? ` (${feedSum.src})` : ""}  FEED: {feedSum.status}</p>
            )}
          </header>
          <div className="ectl__tabs" role="tablist" aria-label="パネルの切り替え">
            {PAGES.map((p) => (
              <button key={p.key} type="button" role="tab" aria-selected={page === p.key} data-on={page === p.key || undefined} onClick={() => setPage(() => p.key)}>
                {p.label}
                {page === p.key && <I n="play" s={10} />}
              </button>
            ))}
          </div>

          <div className="ectl__body">
            {page === "earth" && (
              <EarthLayersPanel
                settings={earth}
                onSettings={setEarth}
                quakes={earthData.quakes}
                sats={earthData.sats}
                now={earthData.now}
                onSearch={(text) => {
                  // 都市・主な地点なら、その街が見える高さまで寄る。無ければ国の中心へ
                  const city = findCity(text);
                  const place = city ?? findPlaces(text, 1)[0];
                  if (!place) return false;
                  if (!earthActive) setD("gevMode", "earth");
                  setEarthTrack(null);
                  flyTo(place.lat, place.lon, city?.height);
                  return true;
                }}
                onReset={() => {
                  setEarthTrack(null);
                  setEarthReset((k) => k + 1);
                }}
                viewStatus={earthActive ? `VIEW: ${earthView}` : weatherActive ? "VIEW: WEATHER 表示中" : camsActive ? "VIEW: LIVE CAMS 表示中" : "VIEW: LOCAL FEED 表示中"}
                radar={earthData.radar}
                aircraft={earthData.aircraft}
                aircraftTooWide={earthData.aircraftTooWide}
                buses={earthData.buses}
                busesInView={earthData.busesInView}
                ships={earthData.ships}
                shipsInView={earthData.shipsInView}
                webcams={earthData.webcams}
                webcamsInView={Boolean(camQuery)}
                onOpenCams={() => setD("gevMode", "cams")}
                config={earthData.config}
                city3d={city3d}
                onCityView={() => {
                  if (!earthActive) setD("gevMode", "earth");
                  setEarthTrack(null);
                  setEarthFly((f) => ({ lat: 35.6812, lon: 139.7671, height: 1_600, pitch: -32, key: (f?.key ?? 0) + 1 }));
                }}
                cloudsDate={cloudsDate}
                imageryErrors={imageryErrors}
                selectedId={earthSel}
                onSelect={(id) => {
                  if (!earthActive) setD("gevMode", "earth");
                  setEarthSel(id);
                  setEarthTrack(null);
                  const q = quakeItems.find((x) => `quake:${x.id}` === id);
                  if (q) flyTo(q.lat, q.lon);
                }}
              />
            )}
            {page === "display" && (
              <div className="edisp">
                <Toggle icon="eye" label="HUD" on={display.hud} onChange={(v) => setD("hud", v)} hint="円のまわりの計器を表示する" />
                <label className="edisp__row edisp__select">
                  <span>LAYOUT</span>
                  <select value={display.layout} onChange={(e) => setD("layout", e.target.value === "minimal" ? "minimal" : "tactical")}>
                    <option value="tactical">Tactical</option>
                    <option value="minimal">Minimal</option>
                  </select>
                </label>
                <Toggle icon="sparse" label="SPARSE" on={display.sparse} onChange={(v) => setD("sparse", v)} hint="映像の上の目印を間引く（映像の接続後に使います）" />
                <Slider label="DENSITY" value={display.density} onChange={(v) => setD("density", v)} hint="目印の密度（映像の接続後に使います）" />
                <div className="edisp__row edisp__seg" role="radiogroup" aria-label="ALLOCATION" title="目印の配置（映像の接続後に使います）">
                  <span>ALLOCATION</span>
                  {(["elastic", "weighted"] as const).map((a) => (
                    <button key={a} type="button" role="radio" aria-checked={display.allocation === a} data-on={display.allocation === a || undefined} onClick={() => setD("allocation", a)}>
                      {a.toUpperCase()}
                    </button>
                  ))}
                </div>
                <Slider label="FADE" value={display.fade} onChange={(v) => setD("fade", v)} hint="円のふちを暗くぼかす" />
                <Slider label="OUTSIDE" value={display.outside} onChange={(v) => setD("outside", v)} hint="円の外側の光" />
                <Toggle icon="moon" label="CELESTIAL" on={display.celestial} onChange={(v) => setD("celestial", v)} hint="背景に星を出す" />
                <Toggle icon="sparkle" label="BLOOM" on={display.bloom} onChange={(v) => setD("bloom", v)} hint="映像を明るく光らせる" />
                <Toggle icon="search" label="SHARPEN" on={display.sharpen} onChange={(v) => setD("sharpen", v)} hint="映像をくっきりさせる" />
                {display.sharpen && <Slider label="" value={display.sharpenAmt} onChange={(v) => setD("sharpenAmt", v)} hint="くっきりさせる量" />}
                <Toggle icon="cube" label="3D" on={display.threeD} onChange={(v) => setD("threeD", v)} hint="映像を斜めに傾けて立体的に見せる" />
                <Toggle icon="frame" label="CLEAN UI" on={display.clean} onChange={(v) => setD("clean", v)} hint="左右のパネルを隠す（Esc で戻す）" />
                <div className="edisp__row edisp__seg" role="radiogroup" aria-label="FEED SHAPE" title="映像が映っているときの枠の形">
                  <span>FEED SHAPE</span>
                  {(["wide", "circle"] as const).map((v) => (
                    <button key={v} type="button" role="radio" aria-checked={display.feedShape === v} data-on={display.feedShape === v || undefined} onClick={() => setD("feedShape", v)}>
                      {v === "wide" ? "16:9" : "CIRCLE"}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {page === "news" && (
              <div className="enews">
                <label className="edisp__row edisp__select">
                  <span>CATEGORY</span>
                  <select value={cat} onChange={(e) => chooseCat(e.target.value as EdithCategory)} title={CATEGORIES.find((c) => c.key === cat)?.desc}>
                    {CATEGORIES.map((c) => (
                      <option key={c.key} value={c.key}>{c.label}</option>
                    ))}
                  </select>
                </label>
                {news.status === "loading" && <p className="estate estate--scan">Google 検索で最新の話題を取得しています…</p>}
                {news.status === "error" && (
                  <p className="estate estate--err">
                    {news.error}
                    <button type="button" className="ebtn" onClick={retry}>再試行</button>
                  </p>
                )}
                {news.status === "ready" && items.length === 0 && (
                  <p className="estate">
                    Google 検索で、出典を確かめられる話題を取得できませんでした。
                    <button type="button" className="ebtn" onClick={retry}>再取得</button>
                  </p>
                )}
                {news.status === "ready" && items.length > 0 && (
                  <ul className="enews__list">
                    {items.map((it, i) => (
                      <li key={i}>
                        <button type="button" className="enews__item" data-on={selected === `${cat}-${i}` || undefined} onClick={() => setSelected(`${cat}-${i}`)}>
                          <span className="enews__text">
                            <b>{it.title}</b>
                            <small>{it.summary}</small>
                            <em>{it.place?.name ?? it.region} · {it.sources[0]?.title ?? "出典は下の参照ページ"} · {ago(news.fetchedAt)}</em>
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                {news.status === "ready" && items.length > 0 && news.refs.length > 0 && (
                  <div className="enews__refs">
                    <p>この一覧を作るのに Google 検索で参照したページ（話題ごとの出典は特定できませんでした）</p>
                    <Sources sources={news.refs} />
                  </div>
                )}
              </div>
            )}

            {page === "trend" && (
              <div className="etrend">
                {allNews.length === 0 ? (
                  <p className="estate">データ未取得（NEWS で話題を取得すると、分野ごとの関連件数を数えます）</p>
                ) : (
                  <>
                    <ol className="etrend__list">
                      {trend.map((t, i) => (
                        <li key={t.key}>
                          <span className="etrend__rank">{i + 1}</span>
                          <span className="etrend__name">{t.label}</span>
                          <span className="etrend__bar"><i style={{ width: `${(t.count / trendMax) * 100}%` }} /></span>
                          <span className="etrend__num">{t.count}件</span>
                        </li>
                      ))}
                    </ol>
                    <p className="etrend__note">取得した話題 {allNews.length} 件のうち関連する件数。推移・前期間との比較はデータ未取得。</p>
                  </>
                )}
              </div>
            )}

            {page === "tasks" && (
              <div className="equick">
                <form
                  className="equick__search"
                  onSubmit={(e) => {
                    e.preventDefault();
                    runQuick(quick ?? "web", quickText);
                  }}
                >
                  <I n="search" s={16} />
                  <input
                    ref={quickRef}
                    value={quickText}
                    onChange={(e) => setQuickText(e.target.value)}
                    placeholder={quick ? QUICK_HINT[quick] : "知りたいことを入力してください…"}
                    aria-label="クイックアクセスの入力"
                  />
                  <button type="submit" aria-label="実行"><I n="search" s={16} /></button>
                </form>
                <div className="equick__cards">
                  {(["web", "image", "doc", "translate"] as const).map((k) => (
                    <button key={k} type="button" className="equick__card" data-on={quick === k || undefined} onClick={() => runQuick(k, quickText)}>
                      <I n={k === "web" ? "globe" : k === "image" ? "image" : k === "doc" ? "doc" : "translate"} s={20} />
                      <span>{k === "web" ? "Web検索" : k === "image" ? "画像検索" : k === "doc" ? "資料作成" : "翻訳"}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        </section>
        <p className="ectl__foot" title="ALT：映像の高度（未接続）／SUN：視点の中心での太陽の高度（計算値）／AIS：船舶の情報（未接続）">
          <span>ALT: —  SUN: {sunStr}</span>
          <span>AIS: —</span>
        </p>

        <section className="erdock" aria-label="計器と地図">
          <div className="ebox erdock__box edeco" title="この画面が使っているメモリの推移（5 秒ごと・Chrome 系だけ）">
            <p className="echart__head"><span>MEMORY</span><b>{metrics.memory ? mb(metrics.memory.usedMb) : "—"}</b></p>
            <Bars values={metrics.memHistory} max={Math.max(1, ...metrics.memHistory)} />
          </div>
          <div className="ebox erdock__box edeco" title="取得した話題の、分野ごとの関連件数">
            <p className="echart__head"><span>INTEL</span><b>{allNews.length ? `${allNews.length} 件` : "—"}</b></p>
            <Bars values={trend.map((t) => t.count)} max={trendMax} wide />
          </div>
          <div className="ebox erdock__box erdock__link">
            <p className="echart__head"><span>GEV LINK</span></p>
            {earthActive ? (
              <b data-on={earthData.quakes.status === "LIVE" || earthData.sats.status === "LIVE" || undefined}>EARTH</b>
            ) : camsActive ? (
              <b data-on={wallItems.length > 0 || undefined}>LIVE CAMS</b>
            ) : weatherActive ? (
              <b data-on={Boolean(earthData.config?.windyMapKey) || undefined}>WEATHER</b>
            ) : (
              <b data-on={feed.status === "live" || undefined}>{feed.status === "live" ? feedSum.src : feedSum.status}</b>
            )}
            <span className="erdock__flat" aria-hidden="true" />
          </div>
          <div className="emap" title="ホログラムの地図（ドラッグで回す・ダブルクリックで寄る）">
            <EdithGlobe points={points} selectedId={selected} onSelect={setSelected} autoRotate={autoRotate} resetKey={resetKey} onView={setView} />
            <span className="emap__ctrl">
              <button type="button" onClick={() => setResetKey((k) => k + 1)} title="初期の視点（東京）に戻す" aria-label="初期の視点に戻す"><I n="reset" s={12} /></button>
              <button type="button" onClick={() => setAutoRotate((v) => !v)} aria-pressed={autoRotate} title={autoRotate ? "自動回転を止める" : "自動回転する"} aria-label="自動回転の切り替え"><I n="rotate" s={12} /></button>
            </span>
            <span className="emap__legend">{news.status === "ready" ? `${points.filter((p) => !p.hot).length} PTS` : news.status === "loading" ? "SCAN" : "—"}</span>
          </div>
        </section>
      </aside>

      {display.clean && (
        <button type="button" className="eunclean" onClick={() => setD("clean", false)} title="左右のパネルを戻す（Esc）">
          <I n="frame" s={14} />UI を戻す
        </button>
      )}
    </div>
  );
});

function Toggle({ icon, label, on, onChange, hint }: { icon: keyof typeof P; label: string; on: boolean; onChange: (v: boolean) => void; hint: string }) {
  return (
    <button type="button" className="edisp__row edisp__toggle" role="switch" aria-checked={on} data-on={on || undefined} onClick={() => onChange(!on)} title={hint}>
      <I n={icon} s={15} />
      <span>{label}</span>
    </button>
  );
}

function Slider({ label, value, onChange, hint }: { label: string; value: number; onChange: (v: number) => void; hint: string }) {
  return (
    <label className="edisp__row edisp__slider" title={hint} style={{ ["--v" as string]: `${value}%` }}>
      <span>{label}</span>
      <input type="range" min={0} max={100} value={value} onChange={(e) => onChange(Number(e.target.value))} aria-label={label || hint} />
      <b>{value}%</b>
    </label>
  );
}

/** 小さな棒グラフ（実際の値だけ。値が無ければ空の枠） */
function Bars({ values, max, wide = false }: { values: number[]; max: number; wide?: boolean }) {
  const n = wide ? Math.max(values.length, 5) : 36;
  const w = 100 / n;
  return (
    <svg className="ebars" viewBox="0 0 100 30" preserveAspectRatio="none" aria-hidden="true">
      <line x1="0" y1="29.5" x2="100" y2="29.5" className="ebars__base" />
      {values.slice(-n).map((v, i, a) => {
        const h = Math.max(0.8, (v / (max || 1)) * 27);
        const x = (n - a.length + i) * w;
        return <rect key={i} x={x + w * 0.18} y={29.5 - h} width={w * 0.64} height={h} />;
      })}
    </svg>
  );
}

/** 画面のふち（角を切った光る枠と飾り。位置は 1600×900 を基準に伸び縮み） */
function Frame() {
  return (
    <svg className="edith__frame" viewBox="0 0 1600 900" preserveAspectRatio="none" aria-hidden="true">
      <path className="ef-line" d="M30 8 H560 L578 24 H1022 L1040 8 H1570 L1592 30 V870 L1570 892 H1040 L1022 876 H578 L560 892 H30 L8 870 V30 Z" />
      <path className="ef-dim" d="M18 40 V300 M18 600 V860 M1582 40 V300 M1582 600 V860" />
      <path className="ef-glow" d="M600 24 H760 M840 24 H1000 M600 876 H760 M840 876 H1000" />
      <path className="ef-stripe" d="M470 14 l10 -8 M482 14 l10 -8 M494 14 l10 -8 M506 14 l10 -8 M518 14 l10 -8 M1082 14 l10 -8 M1094 14 l10 -8 M1106 14 l10 -8" />
      <path className="ef-corner" d="M8 70 V30 L30 8 H70 M1530 8 H1570 L1592 30 V70 M1592 830 V870 L1570 892 H1530 M70 892 H30 L8 870 V830" />
    </svg>
  );
}

/** 円のふち（暗い縁・光る切れ目・目盛り） */
function Bezel() {
  const ticks = Array.from({ length: 120 }, (_, i) => {
    const a = (i * 3 * Math.PI) / 180;
    const long = i % 10 === 0;
    const r1 = long ? 88 : 90;
    return <line key={i} x1={100 + Math.cos(a) * r1} y1={100 + Math.sin(a) * r1} x2={100 + Math.cos(a) * 91.6} y2={100 + Math.sin(a) * 91.6} className={long ? "eb-tick eb-tick--long" : "eb-tick"} />;
  });
  return (
    <svg className="eview__bezel" viewBox="0 0 200 200" aria-hidden="true">
      <defs>
        <filter id="edith-glow" x="-10%" y="-10%" width="120%" height="120%">
          <feGaussianBlur stdDeviation="1.1" result="b" />
          <feMerge>
            <feMergeNode in="b" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>
      <circle cx="100" cy="100" r="98.6" className="eb-outer" />
      <circle cx="100" cy="100" r="95.6" className="eb-band" />
      <g filter="url(#edith-glow)">
        <circle cx="100" cy="100" r="95.6" className="eb-lit" />
        <circle cx="100" cy="100" r="95.6" className="eb-lit eb-lit--b" />
        <circle cx="100" cy="100" r="92.4" className="eb-inner" />
      </g>
      <g className="eb-ticks">{ticks}</g>
      <g className="eb-spin">
        <circle cx="100" cy="100" r="86.5" className="eb-arc" />
      </g>
    </svg>
  );
}

/** 円の左右の計器（飾り。数字は出さない） */
function Gauges() {
  return (
    <>
      <span className="egauge egauge--l edeco" aria-hidden="true">
        {Array.from({ length: 22 }, (_, i) => <i key={i} />)}
      </span>
      <span className="egauge egauge--r edeco" aria-hidden="true">
        <span className="egauge__diamond" />
        {Array.from({ length: 16 }, (_, i) => <i key={i} />)}
      </span>
    </>
  );
}

/** 左下のレーダー（現在地＝東京の目印。回る走査線は飾り） */
function Radar() {
  return (
    <svg className="eradar" viewBox="0 0 100 100" aria-hidden="true">
      <circle cx="50" cy="50" r="47" className="er-ring" />
      <circle cx="50" cy="50" r="34" className="er-ring er-ring--dim" />
      <circle cx="50" cy="50" r="20" className="er-ring" />
      <path d="M50 3V14M50 86V97M3 50H14M86 50H97" className="er-ring" />
      <g className="er-sweep">
        <path d="M50 50 L50 3 A47 47 0 0 1 83 17 Z" />
      </g>
      <circle cx="50" cy="50" r="5" className="er-dot" />
    </svg>
  );
}

/** 右上の計器（実際の時刻を指すアナログ表示。照準のような輪は飾り） */
function Dial({ now }: { now: Date | null }) {
  const h = now ? ((now.getHours() % 12) + now.getMinutes() / 60) * 30 : 0;
  const m = now ? (now.getMinutes() + now.getSeconds() / 60) * 6 : 0;
  const s = now ? now.getSeconds() * 6 : 0;
  return (
    <svg className="edial" viewBox="0 0 140 140" role="img" aria-label={now ? `時刻 ${two(now.getHours())}:${two(now.getMinutes())}` : "時刻"}>
      <circle cx="70" cy="70" r="67" className="edial__outer" />
      <circle cx="70" cy="70" r="60" className="edial__band" />
      <circle cx="70" cy="70" r="46" className="edial__inner" />
      <circle cx="70" cy="70" r="28" className="edial__inner" />
      <path d="M70 2V14M70 126V138M2 70H14M126 70H138" className="edial__major" />
      {Array.from({ length: 60 }, (_, i) => {
        const a = (i * 6 * Math.PI) / 180;
        const r1 = i % 5 === 0 ? 50 : 54;
        return <line key={i} x1={70 + Math.sin(a) * r1} y1={70 - Math.cos(a) * r1} x2={70 + Math.sin(a) * 57} y2={70 - Math.cos(a) * 57} className={i % 5 === 0 ? "edial__major" : "edial__minor"} />;
      })}
      <line x1="70" y1="70" x2="70" y2="42" className="edial__hour" transform={`rotate(${h} 70 70)`} />
      <line x1="70" y1="70" x2="70" y2="26" className="edial__min" transform={`rotate(${m} 70 70)`} />
      <line x1="70" y1="78" x2="70" y2="20" className="edial__sec" transform={`rotate(${s} 70 70)`} />
      <circle cx="70" cy="70" r="3.5" className="edial__hub" />
    </svg>
  );
}

const QUICK_HINT: Record<QuickKind, string> = {
  web: "Web で調べる言葉を入力…",
  image: "画像を探す言葉を入力…",
  doc: "資料のテーマを入力…",
  translate: "翻訳する文章を入力…",
};

/** その返答の直前の発言（検索テーマ） */
function themeOf(messages: UiMessage[], id: string): string {
  const i = messages.findIndex((m) => m.id === id);
  for (let j = i - 1; j >= 0; j--) if (messages[j].role === "user") return messages[j].content;
  return "";
}

function Sources({ sources }: { sources: { uri: string; title: string }[] }) {
  if (!sources.length) return null;
  return (
    <ul className="esrc" aria-label="出典">
      {sources.map((s, i) => {
        const href = safeHref(s.uri);
        return (
          <li key={i}>
            {href ? (
              <a href={href} target="_blank" rel="noopener noreferrer">{s.title}</a>
            ) : (
              <span>{s.title}</span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** Markdown の表（| a | b |）を表として出し、ほかは共通の Markdown 表示に任せる */
function RichText({ text }: { text: string }) {
  const blocks = splitTables(text);
  return (
    <>
      {blocks.map((b, i) =>
        b.kind === "table" ? (
          <div key={i} className="ewin__table">
            <table>
              <thead>
                <tr>{b.head.map((h, j) => <th key={j}>{h}</th>)}</tr>
              </thead>
              <tbody>
                {b.rows.map((r, j) => (
                  <tr key={j}>{r.map((c, k) => <td key={k}>{c}</td>)}</tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Markdown key={i} text={b.text} />
        ),
      )}
    </>
  );
}

function InfoWindow({ index, onClose, onFront, children }: { index: number; onClose: () => void; onFront: () => void; children: ReactNode }) {
  return (
    <section className="ewin" style={{ ["--i" as string]: index }} onPointerDown={onFront} aria-label="情報ウィンドウ">
      <button type="button" className="ewin__close" onClick={onClose} aria-label="ウィンドウを閉じる"><I n="close" s={14} /></button>
      {children}
    </section>
  );
}

function AnswerBody({ msg, theme }: { msg: UiMessage | undefined; theme: string }) {
  if (!msg) return <p className="estate">この情報は閉じられました。</p>;
  const time = new Date(msg.createdAt).toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
  return (
    <>
      <p className="ewin__kicker">SEARCH THEME</p>
      <h3 className="ewin__title">{theme || "E.D.I.T.H. の回答"}</h3>
      {msg.status === "streaming" && !msg.content && <p className="estate estate--scan">情報を取得・分析しています…</p>}
      {msg.status === "error" && <p className="estate estate--err">{msg.error?.message ?? "回答を取得できませんでした。"}</p>}
      {msg.content && (
        <div className="ewin__body">
          <RichText text={msg.content} />
        </div>
      )}
      {msg.status === "done" &&
        (msg.sources?.length ? (
          <>
            <p className="ewin__kicker">SOURCES · {time} 取得</p>
            <Sources sources={msg.sources} />
          </>
        ) : (
          <p className="ewin__note">{time} · この回答では Web 検索の出典はありません（検索結果に基づかない内容を含む可能性があります）。</p>
        ))}
    </>
  );
}

function AnalysisBody({ trend, regions, total }: { trend: { label: string; count: number }[]; regions: { name: string; count: number }[]; total: number }) {
  return (
    <>
      <p className="ewin__kicker">ANALYSIS</p>
      <h3 className="ewin__title">取得した情報の集計</h3>
      {total === 0 ? (
        <p className="estate">データ未取得。左の分野を選ぶと、Google 検索で調べた話題を集計します。</p>
      ) : (
        <>
          <p>取得した話題：{total} 件（各分野の話題を開くたびに増えます）</p>
          <h4>分野ごとの関連件数</h4>
          <ul>{trend.map((t) => <li key={t.label}>{t.label}：{t.count} 件</li>)}</ul>
          <h4>地域ごとの件数</h4>
          {regions.length ? <ul>{regions.slice(0, 8).map((r) => <li key={r.name}>{r.name}：{r.count} 件</li>)}</ul> : <p>地域を特定できた話題はありません。</p>}
          <p className="ewin__note">数字は取得した見出し・要約から数えたもので、市場データや成長率ではありません。</p>
        </>
      )}
    </>
  );
}

function ContextBody({ messages }: { messages: UiMessage[] }) {
  const recent = messages.filter((m) => m.content.trim()).slice(-8);
  return (
    <>
      <p className="ewin__kicker">CONTEXT</p>
      <h3 className="ewin__title">最近の会話</h3>
      {recent.length ? (
        <ul className="ectx">
          {recent.map((m) => (
            <li key={m.id} data-role={m.role}>
              <b>{m.role === "user" ? "あなた" : "AI"}</b>
              <span>{m.content.slice(0, 160)}{m.content.length > 160 ? "…" : ""}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="estate">まだ会話はありません。</p>
      )}
    </>
  );
}
