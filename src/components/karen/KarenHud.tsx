"use client";

/**
 * K.A.R.E.N.（クリエイティブ AI）の画面。F.R.I.D.A.Y. と同じ横長の HUD を、青と全面の方眼で。
 *   上：ロゴ・ナビ（待機／プロジェクト／ワークスペース／F.R.I.D.A.Y. に戻る／シーン設定）・日時・接続・電池
 *   左：SYSTEM STATUS（測れるものだけ）・CREATIVE TOOLS・現在地
 *   中央：待機中は球とリング。制作の指示を受けたら球が消え、方眼の上が制作ワークスペースになる
 *   右：HOLOGRAM PREVIEW（実際のシーン）・CREATIVE TASK（実際の制作の段階）・RECENT PROJECTS（保存したもの）
 *   下：指示の入力欄（マイク・送信）
 * 表示は karen-state（状態）と karen-scene（中身）だけを見る。数値は測れないものを測ったように出さない。
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { UiMessage } from "@/hooks/useChat";
import type { VoiceState } from "@/hooks/useVoice";
import type { CoreMode } from "../home/ParticleCore";
import { LocationMark, useDeviceMetrics } from "../home/readouts";
import { KarenCore } from "./KarenCore";
import { KarenWorkspace, type TransformMode } from "./KarenWorkspace";
import { busy, dispatchKaren, useKarenState, type JobStep, type KarenPhase } from "@/lib/karen-state";
import { selectObject, useScene } from "@/lib/karen-scene";
import { useProjects } from "@/lib/karen-projects";
import { answerExit, cancelCreation, exportGlb, openProject, renderPng, runKarenOp, saveCurrent, useExitAsk, workspaceThumbnail, type KarenIo } from "@/lib/karen-controller";
import type { Shape } from "@/lib/karen-intent";
import { useAiRoute } from "@/lib/ai-router";

/** 球が消えて制作の画面になるまでの演出の長さ */
const TRANSITION_MS = 1500;

const PHASE_LABEL: Record<KarenPhase, string> = {
  IDLE: "STANDBY",
  LISTENING: "LISTENING",
  UNDERSTANDING: "UNDERSTANDING",
  TRANSITIONING: "INITIATING",
  CREATING: "CREATING",
  PREVIEW: "PREVIEW",
  EDITING: "EDITING",
  COMPLETED: "COMPLETED",
  ERROR: "ERROR",
  CANCELLED: "CANCELLED",
};

const STEPS: { step: JobStep; label: string }[] = [
  { step: "find", label: "既存の 3D モデルを探す" },
  { step: "research", label: "見た目を調べる" },
  { step: "design", label: "部品で設計する" },
  { step: "build", label: "ワークスペースに組み立てる" },
];

const fmt2 = (n: number) => String(n).padStart(2, "0");
const DOW = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];

function useClock() {
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    setNow(new Date());
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  return now;
}

/** 電池（測れるブラウザだけ） */
function useBattery(): number | null {
  const [level, setLevel] = useState<number | null>(null);
  useEffect(() => {
    const nav = navigator as Navigator & { getBattery?: () => Promise<{ level: number; addEventListener: (t: string, f: () => void) => void }> };
    let alive = true;
    void nav.getBattery?.().then((b) => {
      if (!alive) return;
      const read = () => alive && setLevel(b.level);
      read();
      b.addEventListener("levelchange", read);
    });
    return () => {
      alive = false;
    };
  }, []);
  return level;
}

/** GPU の名前（WebGL が教えてくれる場合だけ）。使用率はブラウザから測れない */
function useGpuName(): string | null {
  const [name, setName] = useState<string | null>(null);
  useEffect(() => {
    try {
      const c = document.createElement("canvas");
      const gl = c.getContext("webgl");
      const ext = gl?.getExtension("WEBGL_debug_renderer_info");
      const raw = ext && gl ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : null;
      setName(raw ? raw.replace(/ANGLE \(|\)$|Direct3D.*$|vs_\d.*$/g, "").replace(/,.*$/, "").trim().slice(0, 28) : null);
      gl?.getExtension("WEBGL_lose_context")?.loseContext();
    } catch {
      setName(null);
    }
  }, []);
  return name;
}

const Icon = {
  hex: (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 2l8.66 5v10L12 22l-8.66-5V7z" />
      <path d="M12 7l4.33 2.5v5L12 17l-4.33-2.5v-5z" />
    </svg>
  ),
  home: (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M3 11l9-7 9 7v9h-6v-6H9v6H3z" />
    </svg>
  ),
  folder: (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M3 6h7l2 2h9v11H3z" />
    </svg>
  ),
  cube: (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 2l9 5v10l-9 5-9-5V7z" />
      <path d="M3 7l9 5 9-5M12 12v10" />
    </svg>
  ),
  spark: (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 2c.6 4.6 2.4 7.4 8 10-5.6 2.6-7.4 5.4-8 10-.6-4.6-2.4-7.4-8-10 5.6-2.6 7.4-5.4 8-10z" />
    </svg>
  ),
  gear: (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="3.2" />
      <path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1" />
    </svg>
  ),
  mic: (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
    </svg>
  ),
  send: (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M3 11l18-8-8 18-2-8z" />
    </svg>
  ),
};

export interface KarenHudProps {
  active: boolean;
  messages: UiMessage[];
  voiceState: VoiceState;
  /** 声の聞き取りの途中経過（聞こえた言葉・「登録した声ではない」など） */
  voiceInterim?: string;
  /** 声の聞き取りのエラー（マイクの許可・サービスに届かないなど） */
  voiceError?: string | null;
  onDismissVoiceError?: () => void;
  /** K.A.R.E.N. への指示（声・文字と同じ入り口） */
  onCommand: (text: string) => void;
  /** マイク（いま聞く） */
  onMic: () => void;
  /** F.R.I.D.A.Y. に戻る（制作中なら確かめる） */
  onBack: () => void;
  /** 状況を声で返す */
  io: KarenIo;
}

export const KarenHud = memo(function KarenHud({ active, messages, voiceState, voiceInterim, voiceError, onDismissVoiceError, onCommand, onMic, onBack, io }: KarenHudProps) {
  const st = useKarenState();
  const scene = useScene();
  const projects = useProjects();
  const exitAsk = useExitAsk();
  const route = useAiRoute();
  const now = useClock();
  const battery = useBattery();
  const gpu = useGpuName();
  const metrics = useDeviceMetrics(active);
  const [text, setText] = useState("");
  const [mode, setMode] = useState<TransformMode>("translate");
  const [panel, setPanel] = useState<null | "projects" | "scene" | "add">(null);
  const [entering, setEntering] = useState(true);
  const inputRef = useRef<HTMLInputElement>(null);

  // 呼び出されたときの青い走査線の演出
  useEffect(() => {
    if (!active) return;
    setEntering(true);
    const t = setTimeout(() => setEntering(false), 1100);
    return () => clearTimeout(t);
  }, [active]);

  // 球が消える演出が終わったら、制作の画面へ
  useEffect(() => {
    if (st.phase !== "TRANSITIONING") return;
    const t = setTimeout(() => dispatchKaren({ type: "TRANSITION_DONE" }), TRANSITION_MS);
    return () => clearTimeout(t);
  }, [st.phase]);

  // 案内は少ししたら消す（聞き返し・エラーは長めに）
  useEffect(() => {
    if (!st.notice) return;
    const t = setTimeout(() => dispatchKaren({ type: "CLEAR_NOTICE" }), st.notice.tone === "info" ? 6000 : 12000);
    return () => clearTimeout(t);
  }, [st.notice]);

  const hasObjects = scene.objects.length > 0;

  const send = useCallback(
    (value: string) => {
      const v = value.trim();
      if (!v) return;
      onCommand(v);
      setText("");
    },
    [onCommand],
  );

  const lastReply = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.role === "assistant" && m.content.trim()) return m.content.replace(/\s+/g, " ").slice(0, 160);
    }
    return "";
  }, [messages]);

  const coreMode: CoreMode =
    voiceState === "listening" || st.phase === "LISTENING" ? "listening" : voiceState === "speaking" ? "speaking" : voiceState === "thinking" || st.phase === "UNDERSTANDING" ? "think" : "idle";
  const showCore = !st.workspace || st.phase === "TRANSITIONING";
  const working = busy(st);
  const online = route.route === "online" || route.route === "checking";
  const statusRows = [
    { label: "GPU", value: "N/A", ratio: null, title: gpu ? `${gpu}（使用率はブラウザから測れません）` : "GPU の使用率はブラウザから測れません" },
    { label: "MEMORY", value: metrics.memText, ratio: metrics.mem, title: "この画面のメモリの使用率" },
    { label: "STORAGE", value: metrics.storageText, ratio: metrics.storage, title: "この端末に保存しているデータ" },
    { label: "NETWORK", value: metrics.netText, ratio: metrics.net, title: "通信の状態" },
  ];

  const addShape = (shape: Shape) => {
    setPanel(null);
    runKarenOp({ kind: "add-primitive", shape }, io);
  };

  const tools: { key: string; label: string; icon: React.ReactNode; on: () => void; disabled?: boolean; title: string; current?: boolean }[] = [
    { key: "creative", label: "CREATIVE", icon: Icon.cube, on: () => inputRef.current?.focus(), title: "作りたいものを入力・話しかける", current: true },
    {
      key: "holo",
      label: "3D HOLOGRAM",
      icon: Icon.hex,
      on: () => {
        setText("の3Dホログラムを作って");
        requestAnimationFrame(() => {
          inputRef.current?.focus();
          inputRef.current?.setSelectionRange(0, 0);
        });
      },
      title: "〇〇の 3D ホログラムを作る（先頭に作りたいものを入れて送信）",
    },
    {
      key: "edit",
      label: "MODEL EDIT",
      icon: Icon.spark,
      on: () => {
        const last = scene.objects[scene.objects.length - 1];
        if (last && !scene.selectedId) selectObject(last.id);
        setMode((m) => (m === "translate" ? "rotate" : m === "rotate" ? "scale" : "translate"));
      },
      disabled: !hasObjects,
      title: "選んだオブジェクトを動かす（押すたびに 移動 → 回転 → 拡大縮小）",
    },
    { key: "render", label: "RENDER", icon: Icon.cube, on: () => void renderPng(io), disabled: !hasObjects, title: "いまの画面を PNG 画像に書き出す" },
    {
      key: "anim",
      label: "ANIMATION",
      icon: Icon.gear,
      on: () => runKarenOp({ kind: "turntable", on: !scene.turntable }, io),
      disabled: !hasObjects,
      title: "回転アニメーション（ターンテーブル）の開始・停止",
    },
    { key: "scene", label: "SCENE SETUP", icon: Icon.folder, on: () => setPanel((p) => (p === "scene" ? null : "scene")), title: "視点・シーン・保存・書き出し" },
  ];

  const stepState = (s: JobStep) => {
    if (!st.job) return "todo";
    if (st.job.done.includes(s)) return "done";
    if (st.job.step === s && working) return "now";
    // 既存の 3D モデルが見つかったので、調べる・設計するは要らなかった
    if ((s === "research" || s === "design") && (st.job.step === "build" || st.job.done.includes("build"))) return "skip";
    return "todo";
  };

  return (
    <div className="karen" data-phase={st.phase} data-workspace={st.workspace || undefined} data-entering={entering || undefined} aria-hidden={!active}>
      <div className="karen__grid" aria-hidden="true" />
      <svg className="karen__frame" viewBox="0 0 1600 900" preserveAspectRatio="none" aria-hidden="true">
        <path d="M14 40 L40 14 H560 L590 40 H1010 L1040 14 H1560 L1586 40 V860 L1560 886 H1040 L1010 860 H590 L560 886 H40 L14 860 Z" />
        <path className="karen__frame-in" d="M600 70 H1000" />
      </svg>
      {entering && <div className="karen__scan" aria-hidden="true" />}

      {/* ---------- 上 ---------- */}
      <header className="khead">
        <div className="khead__brand">
          <span className="khead__logo">{Icon.hex}</span>
          <b>K.A.R.E.N.</b>
          <i>3D HOLOGRAM CREATOR / AI ASSISTANT</i>
        </div>
        <nav className="khead__nav" aria-label="K.A.R.E.N.">
          <button type="button" title="待機（中央の球）に戻る" aria-current={!st.workspace} onClick={() => runKarenOp({ kind: "idle" }, io)}>
            {Icon.home}
          </button>
          <button type="button" title="保存したプロジェクト" aria-pressed={panel === "projects"} onClick={() => setPanel((p) => (p === "projects" ? null : "projects"))}>
            {Icon.folder}
          </button>
          <button type="button" title="形を足す（球体・立方体など）" aria-pressed={panel === "add"} onClick={() => setPanel((p) => (p === "add" ? null : "add"))}>
            {Icon.cube}
          </button>
          <button type="button" title="F.R.I.D.A.Y. に戻る" onClick={onBack}>
            {Icon.spark}
          </button>
          <button type="button" title="シーン設定" aria-pressed={panel === "scene"} onClick={() => setPanel((p) => (p === "scene" ? null : "scene"))}>
            {Icon.gear}
          </button>
        </nav>
        <div className="khead__right">
          {/* タップで F.R.I.D.A.Y. に戻る（声なら「FRIDAYに戻して」「カレン終了」） */}
          <button type="button" className="kback" onClick={onBack} title="F.R.I.D.A.Y. に戻る（声：「FRIDAYに戻して」）">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M15 5l-7 7 7 7" />
            </svg>
            F.R.I.D.A.Y.
          </button>
          {now && (
            <span className="khead__time">
              {now.getFullYear()}.{fmt2(now.getMonth() + 1)}.{fmt2(now.getDate())} <em>{DOW[now.getDay()]}</em> {fmt2(now.getHours())}:{fmt2(now.getMinutes())}:{fmt2(now.getSeconds())}
            </span>
          )}
          <span className="khead__link" data-on={online || undefined}>
            <i />
            <span>
              KAREN
              <small>{online ? "CONNECTED" : route.route === "offline" ? "LOCAL AI" : "OFFLINE"}</small>
            </span>
          </span>
          {battery !== null && (
            <span className="khead__battery" title="電池">
              <i style={{ width: `${Math.round(battery * 100)}%` }} />
              <b>{Math.round(battery * 100)}%</b>
            </span>
          )}
        </div>
      </header>

      {/* ---------- 左 ---------- */}
      <aside className="kleft">
        <div className="kid">
          <span className="kid__logo">{Icon.hex}</span>
          <div>
            <b>K.A.R.E.N.</b>
            <small>AI 3D HOLOGRAM CREATOR</small>
          </div>
        </div>
        <section className="kpanel">
          <h3 className="kpanel__title">SYSTEM STATUS</h3>
          <ul className="kstat">
            {statusRows.map((r) => (
              <li key={r.label} title={r.title}>
                <span>{r.label}</span>
                <b>{r.value}</b>
                <i className="kbar">
                  <em style={{ transform: `scaleX(${r.ratio === null ? 0 : Math.max(0.02, Math.min(1, r.ratio))})` }} />
                </i>
              </li>
            ))}
          </ul>
        </section>
        <section className="kpanel">
          <h3 className="kpanel__title kpanel__title--diamond">CREATIVE TOOLS</h3>
          <ul className="ktools">
            {tools.map((t) => (
              <li key={t.key}>
                <button type="button" className="ktool" data-current={t.current || undefined} disabled={t.disabled} title={t.title} onClick={t.on}>
                  <span className="ktool__icon">{t.icon}</span>
                  {t.label}
                  {t.key === "edit" && hasObjects && <small>{mode === "translate" ? "MOVE" : mode === "rotate" ? "ROTATE" : "SCALE"}</small>}
                  {t.key === "anim" && scene.turntable && <small>ON</small>}
                  {t.current && <span className="ktool__chev">›</span>}
                </button>
              </li>
            ))}
          </ul>
        </section>
        <div className="kloc">
          <LocationMark />
        </div>
      </aside>

      {/* ---------- 中央 ---------- */}
      <main className="kcenter">
        {st.workspace && <KarenWorkspace active={active} mode={mode} />}
        {showCore && <KarenCore mode={coreMode} active={active} leaving={st.phase === "TRANSITIONING"} />}

        {st.phase === "TRANSITIONING" && (
          <div className="kinit" role="status">
            <b>CREATIVE SEQUENCE INITIATED</b>
            {st.request && <span>{st.request}</span>}
          </div>
        )}

        {st.workspace && st.phase !== "TRANSITIONING" && (
          <div className="ktoolbar" role="toolbar" aria-label="ワークスペースの操作">
            {(["translate", "rotate", "scale"] as const).map((m) => (
              <button key={m} type="button" aria-pressed={mode === m} disabled={!hasObjects} onClick={() => setMode(m)} title={{ translate: "移動", rotate: "回転", scale: "拡大縮小" }[m]}>
                {{ translate: "MOVE", rotate: "ROTATE", scale: "SCALE" }[m]}
              </button>
            ))}
            <span className="ktoolbar__sep" />
            <button type="button" onClick={() => setPanel((p) => (p === "add" ? null : "add"))} aria-pressed={panel === "add"} title="形を足す">
              ADD
            </button>
            <button type="button" disabled={!hasObjects} onClick={() => runKarenOp({ kind: "delete" }, io)} title="選んだオブジェクトを削除">
              DELETE
            </button>
            <button type="button" onClick={() => runKarenOp({ kind: "reset-view" }, io)} title="視点を元に戻す">
              RESET VIEW
            </button>
            <span className="ktoolbar__sep" />
            <button type="button" disabled={!hasObjects} onClick={() => void saveCurrent(io)} title="この端末に保存">
              SAVE
            </button>
            <button type="button" disabled={!hasObjects} onClick={() => void exportGlb(io)} title="GLB ファイルに書き出す">
              EXPORT GLB
            </button>
          </div>
        )}

        {st.workspace && working && (
          <div className="kbusy" role="status">
            <i className="kbusy__spin" />
            <span>{STEPS.find((s) => s.step === st.job?.step)?.label ?? "制作中"}…</span>
            <button type="button" onClick={() => cancelCreation(io)}>
              CANCEL
            </button>
          </div>
        )}
        {st.phase === "ERROR" && st.error && (
          <div className="kerror" role="alert">
            <b>ERROR</b>
            <span>{st.error}</span>
          </div>
        )}
        {st.workspace && !hasObjects && !working && st.phase !== "TRANSITIONING" && st.phase !== "ERROR" && (
          <p className="kempty">シーンは空です。作りたいものを話しかけるか、ADD から形を足してください。</p>
        )}

        {panel === "add" && (
          <div className="kpop kpop--add" role="dialog" aria-label="形を足す">
            {(["sphere", "box", "cylinder", "cone", "torus"] as const).map((s) => (
              <button key={s} type="button" onClick={() => addShape(s)}>
                {{ sphere: "球体", box: "立方体", cylinder: "円柱", cone: "円錐", torus: "トーラス" }[s]}
              </button>
            ))}
          </div>
        )}
        {panel === "scene" && (
          <div className="kpop kpop--scene" role="dialog" aria-label="シーン設定">
            <button type="button" onClick={() => runKarenOp({ kind: "reset-view" }, io)}>視点をリセット</button>
            <button type="button" disabled={!hasObjects} onClick={() => runKarenOp({ kind: "turntable", on: !scene.turntable }, io)}>
              回転アニメーション：{scene.turntable ? "ON" : "OFF"}
            </button>
            <button type="button" disabled={!hasObjects} onClick={() => void saveCurrent(io)}>保存</button>
            <button type="button" disabled={!hasObjects} onClick={() => void exportGlb(io)}>GLB で書き出す</button>
            <button type="button" disabled={!hasObjects} onClick={() => void renderPng(io)}>PNG で書き出す</button>
            <button type="button" disabled={!hasObjects} onClick={() => runKarenOp({ kind: "clear" }, io)}>シーンを空にする</button>
            <button type="button" onClick={() => runKarenOp({ kind: "idle" }, io)}>待機に戻る</button>
          </div>
        )}
        {panel === "projects" && (
          <div className="kpop kpop--projects" role="dialog" aria-label="保存したプロジェクト">
            {!projects?.length ? (
              <p>保存したプロジェクトはまだありません。</p>
            ) : (
              projects.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => {
                    setPanel(null);
                    void openProject(p, io);
                  }}
                >
                  {p.name}
                  <small>{new Date(p.savedAt).toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}</small>
                </button>
              ))
            )}
          </div>
        )}

        {exitAsk && (
          <div className="kconfirm" role="alertdialog" aria-label="F.R.I.D.A.Y. に戻る">
            <b>制作の途中です</b>
            <span>制作を続けたまま F.R.I.D.A.Y. に戻りますか？</span>
            <div>
              <button type="button" onClick={() => answerExit("continue", io)}>続けたまま戻る</button>
              <button type="button" onClick={() => answerExit("stop", io)}>止めて戻る</button>
              <button type="button" onClick={() => answerExit("stay", io)}>戻らない</button>
            </div>
          </div>
        )}

        {/* 認識した指示・案内・K.A.R.E.N. の返事 */}
        <div className="kline" aria-live="polite">
          {voiceError ? (
            <span data-tone="error" className="kline__voice-error">
              {voiceError}
              {onDismissVoiceError && (
                <button type="button" onClick={onDismissVoiceError}>
                  閉じる
                </button>
              )}
            </span>
          ) : voiceInterim && voiceInterim !== "…" ? (
            <span data-tone={voiceInterim.startsWith("登録した声") ? "warn" : "info"}>{voiceInterim.replace(/^聞こえた：/, "聞こえた：")}</span>
          ) : st.notice ? (
            <span data-tone={st.notice.tone}>{st.notice.text}</span>
          ) : st.heard && (st.phase === "UNDERSTANDING" || st.phase === "LISTENING" || st.phase === "TRANSITIONING") ? (
            <span>「{st.heard}」</span>
          ) : lastReply ? (
            <span className="kline__reply">{lastReply}</span>
          ) : null}
        </div>
      </main>

      {/* ---------- 右 ---------- */}
      <aside className="kright">
        <section className="kpanel kpreview">
          <h3 className="kpanel__title">
            HOLOGRAM PREVIEW <span className="klive" data-on={hasObjects || undefined}>{hasObjects ? "LIVE" : "EMPTY"}</span>
          </h3>
          <PreviewBox active={active && hasObjects} version={scene.objects} />
        </section>
        <section className="kpanel ktask">
          <h3 className="kpanel__title">
            CREATIVE TASK <span className="ktask__phase">{PHASE_LABEL[st.phase]}</span>
          </h3>
          {st.job ? (
            <>
              <p className="ktask__title">{st.job.title}</p>
              <i className="kbar kbar--task" data-busy={working || undefined}>
                <em style={{ transform: `scaleX(${working ? 0.3 : st.phase === "COMPLETED" ? 1 : 0})` }} />
              </i>
              <ul className="ktask__steps">
                {STEPS.map((s) => {
                  const state = stepState(s.step);
                  return (
                    <li key={s.step} data-state={state}>
                      <i />
                      {s.label}
                      {state === "skip" && <small>（既存のモデルを使用）</small>}
                    </li>
                  );
                })}
              </ul>
            </>
          ) : (
            <p className="ktask__idle">{st.phase === "CANCELLED" ? "キャンセルしました。" : "進行中の制作はありません。"}</p>
          )}
        </section>
        <section className="kpanel kprojects">
          <h3 className="kpanel__title">
            RECENT PROJECTS
            <button type="button" className="kpanel__more" title="すべて表示" onClick={() => setPanel((p) => (p === "projects" ? null : "projects"))}>
              ›
            </button>
          </h3>
          {!projects?.length ? (
            <p className="kprojects__empty">保存したプロジェクトはまだありません。制作したら SAVE で保存できます。</p>
          ) : (
            <ul>
              {projects.slice(0, 3).map((p) => (
                <li key={p.id}>
                  <button type="button" onClick={() => void openProject(p, io)}>
                    <span className="kprojects__thumb">{p.thumb ? <img src={p.thumb} alt="" /> : Icon.cube}</span>
                    <span>
                      <b>{p.name}</b>
                      <small>
                        {new Date(p.savedAt).toLocaleString("ja-JP", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })}
                      </small>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          <p className="kprojects__tag">CREATE SOMETHING AMAZING</p>
        </section>
      </aside>

      {/* ---------- 下 ---------- */}
      <form
        className="kcmd"
        onSubmit={(e) => {
          e.preventDefault();
          send(text);
        }}
      >
        <button type="button" className="kcmd__mic" data-voice={voiceState} aria-pressed={voiceState !== "off"} title="声で指示する" onClick={onMic}>
          {Icon.mic}
        </button>
        <input ref={inputRef} value={text} onChange={(e) => setText(e.target.value)} placeholder={voiceState === "listening" ? "どうぞ、話してください…（聞いています）" : "K.A.R.E.N.に指示を入力してください…"}
          data-listening={voiceState === "listening" || undefined} aria-label="K.A.R.E.N. への指示" />
        <button type="submit" className="kcmd__send" title="送信" disabled={!text.trim()}>
          {Icon.send}
        </button>
      </form>
      <footer className="kfoot">
        K.A.R.E.N. <span>//</span> CREATIVE MODE <span>//</span> <b data-on={online || undefined}>{online ? "ONLINE" : "OFFLINE"}</b>
        <i />
      </footer>
    </div>
  );
});

/** 右上のプレビュー：実際の 3D ビューの小さな画像（1.5 秒ごと） */
function PreviewBox({ active, version }: { active: boolean; version: unknown }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    if (!active) {
      setSrc(null);
      return;
    }
    let alive = true;
    const shot = () => {
      if (alive) setSrc(workspaceThumbnail() ?? null);
    };
    const first = setTimeout(shot, 400);
    const t = setInterval(shot, 1500);
    return () => {
      alive = false;
      clearTimeout(first);
      clearInterval(t);
    };
  }, [active, version]);
  return (
    <div className="kpreview__box">
      {src ? <img src={src} alt="いまのシーン" /> : <span className="kpreview__floor" aria-hidden="true" />}
      <i className="kpreview__c kpreview__c--tl" />
      <i className="kpreview__c kpreview__c--tr" />
      <i className="kpreview__c kpreview__c--bl" />
      <i className="kpreview__c kpreview__c--br" />
    </div>
  );
}
