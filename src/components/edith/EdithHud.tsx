"use client";

/**
 * E.D.I.T.H.（Enhanced Data Integration & Tactical Horizon）の画面。F.R.I.D.A.Y. と同じ HUD の作りを、ネオンパープルで。
 *   上：ロゴ・ナビ（ホーム／情報検索／グローバル情報／分析／メッセージ／設定／F.R.I.D.A.Y. に戻る）・日時・接続・通信・電池
 *   左：GLOBAL INFORMATION（分野を選ぶと、中央の地図と右のニュースが切り替わる）
 *   中央：立体ホログラムの世界地図（ニュースの地域に印。AI の答えに出てきた国も光る）
 *   右：REAL-TIME NEWS（Google 検索で調べた実際の話題と出典）・GLOBAL TREND（取得した話題から数えた件数）・QUICK ACCESS
 *   下：GLOBAL COMMAND BAR（E.D.I.T.H. への指示。答えは情報ウィンドウに出る）
 * 測れないもの・取れなかったものは、取れたように見せない（「未取得」「取得不可」と出す）。
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { UiMessage } from "@/hooks/useChat";
import type { VoiceState } from "@/hooks/useVoice";
import { Markdown } from "../Markdown";
import { EdithGlobe, type GlobePoint } from "./EdithGlobe";
import { findPlaces } from "@/lib/edith-geo";
import { splitTables } from "@/lib/edith-text";
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
  home: <path d="M4 11l8-7 8 7v9h-5v-6H9v6H4z" />,
  folder: <path d="M4 6h6l2 2h8v11H4z" />,
  globe: <><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18" /></>,
  search: <><circle cx="11" cy="11" r="6" /><path d="M16 16l5 5" /></>,
  mail: <><rect x="3" y="6" width="18" height="12" rx="1" /><path d="M3 7l9 6 9-6" /></>,
  chip: <><rect x="7" y="7" width="10" height="10" /><path d="M9 3v4M15 3v4M9 17v4M15 17v4M3 9h4M3 15h4M17 9h4M17 15h4" /></>,
  gear: <><circle cx="12" cy="12" r="3" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1" /></>,
  back: <path d="M10 6l-6 6 6 6M4 12h16" />,
  doc: <><path d="M6 3h8l4 4v14H6z" /><path d="M9 11h6M9 15h6" /></>,
  chart: <path d="M4 20V10M10 20V4M16 20v-8M22 20H2" />,
  plane: <path d="M2 13l8-2 4-8 2 1-2 8 7 2-1 2-7-1-3 6-2-1 1-6-6 1z" />,
  image: <><rect x="3" y="5" width="18" height="14" /><path d="M3 16l5-5 4 4 3-3 6 6" /><circle cx="16" cy="9" r="1.5" /></>,
  cap: <path d="M2 9l10-5 10 5-10 5zM6 11v5c3 2 9 2 12 0v-5" />,
  dots: <><circle cx="6" cy="12" r="1.3" /><circle cx="12" cy="12" r="1.3" /><circle cx="18" cy="12" r="1.3" /></>,
  arrow: <path d="M9 6l6 6-6 6" />,
  reset: <path d="M4 12a8 8 0 1 0 3-6.2M4 4v4h4" />,
  rotate: <path d="M20 12a8 8 0 1 1-2.3-5.7M20 4v4h-4" />,
  translate: <path d="M3 5h10M8 3v2M5 5c1 4 4 7 7 8M11 5c-1 4-4 7-7 8M13 21l4-10 4 10M14.5 17h5" />,
  close: <path d="M6 6l12 12M18 6L6 18" />,
  send: <path d="M5 6l6 6-6 6M12 6l6 6-6 6" />,
  wifi: <path d="M2 9a15 15 0 0 1 20 0M5 12.5a10 10 0 0 1 14 0M8.5 16a5 5 0 0 1 7 0M12 19.5h.01" />,
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

const DOW = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
const two = (n: number) => String(n).padStart(2, "0");

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
}

export const EdithHud = memo(function EdithHud(props: Props) {
  const { messages, voiceState, voiceInterim, voiceError, onDismissVoiceError, onCommand, onMic, onBack, onOpenSettings, onOpenUrl } = props;
  const now = useNow();
  const sys = useSystemStatus();
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

  // リアルタイム会話のやりとり（声で話した内容と E.D.I.T.H. の返事）。最後の 1 往復を、コマンドバーの上に出す
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
    setPanel("none");
  };
  const openWin = (kind: "analysis" | "context") => setWins((w) => [...w.filter((x) => x.kind !== kind), { id: kind, kind }].slice(-4));
  const closeWin = (id: string) => setWins((w) => w.filter((x) => x.id !== id));
  const front = (id: string) => setWins((w) => [...w.filter((x) => x.id !== id), ...w.filter((x) => x.id === id)]);

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

  return (
    <div className="edith" role="application" aria-label="E.D.I.T.H. グローバルインテリジェンスシステム" data-panel={panel}>
      <div className="edith__grid" aria-hidden="true" />
      {/* ---------- ヘッダー ---------- */}
      <header className="ehead">
        <div className="ehead__brand">
          <span className="ehead__logo"><I n="logo" s={26} /></span>
          <span className="ehead__name">E.D.I.T.H.</span>
        </div>
        <nav className="ehead__nav" aria-label="E.D.I.T.H. のナビゲーション">
          <button type="button" title="ホーム（初期表示に戻す）" aria-label="ホーム" onClick={() => (chooseCat("news"), setResetKey((k) => k + 1), setWins([]))}><I n="home" /></button>
          <button type="button" title="情報検索（指示を入力）" aria-label="情報検索" onClick={() => cmdRef.current?.focus()}><I n="search" /></button>
          <button type="button" title="グローバル情報（地図を初期の向きに）" aria-label="グローバル情報" onClick={() => setResetKey((k) => k + 1)}><I n="globe" /></button>
          <button type="button" title="分析（取得した情報の集計）" aria-label="分析" onClick={() => openWin("analysis")}><I n="chart" /></button>
          <button type="button" title="メッセージ（最近の会話）" aria-label="メッセージ" onClick={() => openWin("context")}><I n="mail" /></button>
          <button type="button" title="システム設定" aria-label="システム設定" onClick={onOpenSettings}><I n="gear" /></button>
          <button type="button" className="ehead__back" title="F.R.I.D.A.Y. に戻る" aria-label="F.R.I.D.A.Y. に戻る" onClick={onBack}><I n="back" /><span>F.R.I.D.A.Y.</span></button>
        </nav>
        <div className="ehead__status">
          <span className="ehead__clock">
            {now ? (
              <>
                <span className="ehead__date">{`${now.getFullYear()}.${two(now.getMonth() + 1)}.${two(now.getDate())} ${DOW[now.getDay()]} `}</span>
                {`${two(now.getHours())}:${two(now.getMinutes())}:${two(now.getSeconds())}`}
              </>
            ) : (
              "—"
            )}
          </span>
          <span className="ehead__online" data-on={sys.online || undefined}>{sys.online ? "ONLINE" : "OFFLINE"} · Global</span>
          <span className="ehead__net" title={sys.net ? `通信：${sys.net}` : "通信の種類は取得できません"}><I n="wifi" s={16} />{sys.net ?? "—"}</span>
          <span className="ehead__bat" title={sys.battery === null ? "電池の残量は取得できません" : "電池の残量"}>
            <span className="ehead__batbar"><i style={{ width: `${Math.round((sys.battery ?? 0) * 100)}%` }} /></span>
            {sys.battery === null ? "—" : `${Math.round(sys.battery * 100)}%`}
          </span>
        </div>
        <div className="ehead__toggles">
          <button type="button" aria-label="情報の分野を開く" onClick={() => setPanel((p) => (p === "left" ? "none" : "left"))}>分野</button>
          <button type="button" aria-label="ニュースとツールを開く" onClick={() => setPanel((p) => (p === "right" ? "none" : "right"))}>情報</button>
        </div>
      </header>

      <div className="etabs" role="toolbar" aria-label="表示の切り替え">
        <button type="button" onClick={() => cmdRef.current?.focus()}>SEARCH</button>
        <button type="button" onClick={() => setPanel("left")}>INFORMATION</button>
        <button type="button" onClick={() => openWin("analysis")}>ANALYSIS</button>
        <button type="button" onClick={() => openWin("context")}>CONTEXT</button>
      </div>

      {/* ---------- 左：GLOBAL INFORMATION ---------- */}
      <aside className="epanel eleft" aria-label="GLOBAL INFORMATION">
        <h2 className="epanel__title"><I n="logo" s={16} />GLOBAL INFORMATION</h2>
        <ul className="ecats">
          {CATEGORIES.map((c) => (
            <li key={c.key}>
              <button type="button" className="ecat" data-on={cat === c.key || undefined} aria-pressed={cat === c.key} onClick={() => chooseCat(c.key)}>
                <span className="ecat__icon"><I n={c.icon} s={22} /></span>
                <span className="ecat__text">
                  <b>{c.label}</b>
                  <small>{c.desc}</small>
                </span>
                <span className="ecat__arrow"><I n="arrow" s={16} /></span>
              </button>
            </li>
          ))}
        </ul>
      </aside>

      {/* ---------- 中央：世界地図 ---------- */}
      <main className="ecenter" aria-label="世界地図">
        <div className="emap">
          <EdithGlobe points={points} selectedId={selected} onSelect={setSelected} autoRotate={autoRotate} resetKey={resetKey} onView={setView} />
          <span className="emap__dir emap__dir--n">N</span>
          <span className="emap__dir emap__dir--s">S</span>
          <span className="emap__dir emap__dir--w">W</span>
          <span className="emap__dir emap__dir--e">E</span>
          <div className="emap__tag"><I n="globe" s={22} /><span>GLOBAL<br />REAL-TIME<br />INFORMATION</span></div>
          <div className="emap__coord" aria-label="地図の中心の座標">
            {view ? (
              <>
                <span>{Math.abs(view.lat).toFixed(4)}° {view.lat >= 0 ? "N" : "S"}</span>
                <span>{Math.abs(view.lon).toFixed(4)}° {view.lon >= 0 ? "E" : "W"}</span>
              </>
            ) : (
              <span>—</span>
            )}
            <i className="emap__bars" aria-hidden="true"><b /><b /><b /><b /><b /><b /></i>
          </div>
          <div className="emap__legend">
            <span>● {CAT_LABEL[cat]}（{news.status === "ready" ? `${points.filter((p) => !p.hot).length} 地点` : news.status === "loading" ? "取得中" : "未取得"}）</span>
            {answerPlaces.length > 0 && <span className="emap__legend-ai">● AI の答えに出た地域</span>}
            <span className="emap__legend-home">● 東京（起点）</span>
          </div>
          <div className="emap__ctrl">
            <button type="button" onClick={() => setResetKey((k) => k + 1)} title="初期の視点に戻す" aria-label="初期の視点に戻す"><I n="reset" s={16} /></button>
            <button type="button" onClick={() => setAutoRotate((v) => !v)} aria-pressed={autoRotate} title={autoRotate ? "自動回転を止める" : "自動回転する"} aria-label="自動回転の切り替え"><I n="rotate" s={16} /></button>
          </div>
          {(selectedItem || selectedAi) && (
            <div className="epoint" role="dialog" aria-label="地点の詳細">
              <button type="button" className="epoint__close" onClick={() => setSelected(null)} aria-label="閉じる"><I n="close" s={14} /></button>
              {selectedItem ? (
                <>
                  <p className="epoint__meta">{selectedItem.place?.name ?? selectedItem.region} · {CAT_LABEL[cat]}</p>
                  <h3>{selectedItem.title}</h3>
                  <p>{selectedItem.summary}</p>
                  {news.status === "ready" && <p className="epoint__time">{ago(news.fetchedAt)}（地点は国・都市の代表地点）</p>}
                  <Sources sources={selectedItem.sources} />
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
        </div>

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
      </main>

      {/* ---------- 右：INTELLIGENCE PANELS ---------- */}
      <aside className="eright" aria-label="インテリジェンスパネル">
        <section className="epanel enews" aria-label="REAL-TIME NEWS">
          <h2 className="epanel__title"><I n="logo" s={16} />REAL-TIME NEWS<small>{CAT_LABEL[cat]}</small></h2>
          {news.status === "loading" && <p className="estate estate--scan">Google 検索で最新の話題を取得しています…</p>}
          {news.status === "error" && (
            <p className="estate estate--err">
              {news.error}
              <button type="button" className="ebtn" onClick={retry}>再試行</button>
            </p>
          )}
          {news.status === "ready" && items.length === 0 && <p className="estate">出典を確かめられる話題が見つかりませんでした。<button type="button" className="ebtn" onClick={retry}>再取得</button></p>}
          {news.status === "ready" && items.length > 0 && (
            <ul className="enews__list">
              {items.map((it, i) => (
                <li key={i}>
                  <button type="button" className="enews__item" data-on={selected === `${cat}-${i}` || undefined} onClick={() => setSelected(`${cat}-${i}`)}>
                    <span className="enews__thumb" aria-hidden="true"><I n={CATEGORIES.find((c) => c.key === cat)!.icon} s={22} /><small>{it.place?.name ?? it.region}</small></span>
                    <span className="enews__text">
                      <b>{it.title}</b>
                      <small>{it.summary}</small>
                      <em>{it.sources[0]?.title ?? ""} · {ago(news.fetchedAt)}</em>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="epanel etrend" aria-label="GLOBAL TREND">
          <h2 className="epanel__title"><I n="chart" s={16} />GLOBAL TREND</h2>
          {allNews.length === 0 ? (
            <p className="estate">データ未取得（ニュースを取得すると、分野ごとの関連件数を数えます）</p>
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
        </section>

        <section className="epanel equick" aria-label="QUICK ACCESS">
          <h2 className="epanel__title"><I n="logo" s={16} />QUICK ACCESS</h2>
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
                <I n={k === "web" ? "globe" : k === "image" ? "image" : k === "doc" ? "doc" : "translate"} s={24} />
                <span>{k === "web" ? "Web検索" : k === "image" ? "画像検索" : k === "doc" ? "資料作成" : "翻訳"}</span>
              </button>
            ))}
          </div>
        </section>
      </aside>

      {/* ---------- 下：GLOBAL COMMAND BAR ---------- */}
      <footer className="ecmd">
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
        <div className="ecmd__bar">
          <button type="button" className="ecmd__orb" data-state={voiceState} onClick={onMic} aria-label={listening ? "聞いています" : "声で指示する"} title="声で指示する">
            <span />
          </button>
          <form
            className="ecmd__form"
            onSubmit={(e) => {
              e.preventDefault();
              submit(cmd);
            }}
          >
            <input
              ref={cmdRef}
              value={cmd}
              onChange={(e) => setCmd(e.target.value)}
              placeholder={listening ? "聞いています…" : speaking ? "E.D.I.T.H. が話しています…" : "何を調べますか？"}
              aria-label="E.D.I.T.H. への指示"
              enterKeyHint="send"
            />
            <button type="submit" className="ecmd__send" aria-label="送信"><I n="send" s={22} /></button>
          </form>
        </div>
      </footer>
      <div className="edith__mark" aria-hidden="true"><span className="edith__markring" /><b>E.D.I.T.H.</b><small>Global Intelligence System</small></div>
      <div className="edith__more" aria-hidden="true">MORE INFORMATION<br />A WIDER WORLD</div>
    </div>
  );
});

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
