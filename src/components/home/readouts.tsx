"use client";

/**
 * ミニマル HUD の表示部品。どれも「短い名前 + 数字」だけを出し、数字はすべて実データ（取れないものは「—」）。
 *   上のタブ（AGENTS / NOTES / TASKS / CONTEXT）／SYSTEM STATUS（この端末の負荷）／CURRENT MODE／接続の短いバー
 *   左下の現在地／VOICE ACTIVITY（波形）／NOTIFICATIONS／ACTIVITY LIVE（会話の量）
 */
import { memo, useEffect, useRef, useState } from "react";
import type { StatusResponse } from "@/core/types";
import { AGENT_CARDS } from "@/data/agents";
import { TASKS_CHANGED, type ChatPhase, type LastRunStats, type UiMessage } from "@/hooks/useChat";
import type { VoiceState } from "@/hooks/useVoice";
import type { WeatherReport } from "@/integrations/weather";
import { voiceLevel } from "@/lib/voice-level";
import { Icon } from "../icons";
import type { CoreMode } from "./ParticleCore";
import { agentOnline, useIncoming, useJson, type ChatAgentStatus } from "./panels";

const clamp = (n: number) => Math.max(0, Math.min(1, n));

/** 細い横バー（中身は 0〜1） */
function Bar({ ratio, live }: { ratio: number | null; live?: boolean }) {
  return (
    <i className="hbar" data-live={live || undefined} data-empty={ratio === null || undefined}>
      <em style={{ transform: `scaleX(${ratio === null ? 0 : Math.max(0.03, clamp(ratio))})` }} />
    </i>
  );
}

/* ---------- 上のタブ ---------- */

export type HomeTab = "agents" | "notes" | "tasks" | "context";

export const TopTabs = memo(function TopTabs({
  chatStatus,
  brain,
  lastRun,
  maxContext,
  open,
  onTab,
}: {
  chatStatus: ChatAgentStatus;
  brain?: StatusResponse["brain"];
  lastRun: LastRunStats;
  maxContext: number;
  open: HomeTab | null;
  onTab: (t: HomeTab) => void;
}) {
  const tasks = useJson<{ configured: boolean; todos: unknown[] }>("/api/projects", [TASKS_CHANGED]);
  const agents = AGENT_CARDS.filter((a) => agentOnline(a.key, a.phase, chatStatus, brain)).length;
  const notes = brain?.connected ? (brain.notes ?? 0) : null;
  const todo = tasks?.configured ? tasks.todos.length : null;
  const ctx = lastRun.contextMessages ?? 0;
  const tabs: { key: HomeTab; label: string; title: string }[] = [
    { key: "agents", label: "AGENTS", title: `動いているエージェント ${agents}/${AGENT_CARDS.length}（一覧を開く）` },
    { key: "notes", label: "NOTES", title: `脳のノート ${notes ?? "—"}（MEMORY を開く）` },
    { key: "tasks", label: "TASKS", title: `未完了の ToDo ${todo ?? "—"}（TASKS を開く）` },
    { key: "context", label: "CONTEXT", title: `会話の文脈 ${ctx}/${maxContext}（CHAT を開く）` },
  ];
  return (
    <nav className="htabs" aria-label="HOME のタブ">
      {tabs.map((t) => (
        <button key={t.key} type="button" className="htab" data-open={open === t.key || undefined} onClick={() => onTab(t.key)} title={t.title}>
          {t.label}
        </button>
      ))}
    </nav>
  );
});

/* ---------- SYSTEM STATUS：この端末の CPU（画面の処理の重さ）・メモリ・保存領域・通信 ---------- */

interface Metrics {
  cpu: number | null;
  mem: number | null;
  memText: string;
  storage: number | null;
  storageText: string;
  net: number | null;
  netText: string;
}

const mb = (bytes: number) => (bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)}GB` : `${Math.max(0.1, bytes / 1024 ** 2).toFixed(bytes < 10 * 1024 ** 2 ? 1 : 0)}MB`);

export function useDeviceMetrics(active: boolean): Metrics {
  const [m, setM] = useState<Metrics>({ cpu: null, mem: null, memText: "—", storage: null, storageText: "—", net: null, netText: "—" });
  useEffect(() => {
    if (!active) return;
    // CPU：タイマーの遅れと長い処理（long task）から、この画面がどれだけ忙しいかを測る
    let busy = 0;
    let lastTick = performance.now();
    let longMs = 0;
    let po: PerformanceObserver | undefined;
    try {
      po = new PerformanceObserver((list) => list.getEntries().forEach((e) => (longMs += e.duration)));
      po.observe({ type: "longtask", buffered: false });
    } catch {
      /* long task を測れないブラウザ */
    }
    let storage: Pick<Metrics, "storage" | "storageText"> = { storage: null, storageText: "—" };
    const readStorage = () =>
      navigator.storage
        ?.estimate?.()
        .then(({ usage = 0, quota = 0 }) => {
          storage = { storage: quota ? usage / quota : null, storageText: mb(usage) };
        })
        .catch(() => {});
    void readStorage();

    const INTERVAL = 1000;
    let n = 0;
    const t = setInterval(() => {
      const now = performance.now();
      const lag = Math.max(0, now - lastTick - INTERVAL);
      lastTick = now;
      const load = clamp((lag + longMs) / INTERVAL);
      longMs = 0;
      busy = busy * 0.6 + load * 0.4;
      const perf = performance as Performance & { memory?: { usedJSHeapSize: number; totalJSHeapSize: number } };
      const heap = perf.memory;
      const conn = (navigator as Navigator & { connection?: { downlink?: number; rtt?: number } }).connection;
      const online = navigator.onLine;
      if (++n % 30 === 0) void readStorage();
      setM({
        cpu: busy,
        mem: heap ? heap.usedJSHeapSize / Math.max(1, heap.totalJSHeapSize) : null,
        memText: heap ? `${Math.round((heap.usedJSHeapSize / Math.max(1, heap.totalJSHeapSize)) * 100)}%` : "—",
        ...storage,
        net: !online ? 0 : conn?.downlink ? clamp(conn.downlink / 10) : 1,
        netText: !online ? "OFFLINE" : conn?.downlink ? `${conn.downlink}Mbps` : "ONLINE",
      });
    }, INTERVAL);
    return () => {
      clearInterval(t);
      po?.disconnect();
    };
  }, [active]);
  return m;
}

export const SystemBars = memo(function SystemBars({ active }: { active: boolean }) {
  const m = useDeviceMetrics(active);
  const pct = (r: number | null) => (r === null ? "—" : `${Math.round(r * 100)}%`);
  const rows = [
    { label: "CPU", value: pct(m.cpu), ratio: m.cpu, title: "この画面の処理の重さ" },
    { label: "MEMORY", value: m.memText, ratio: m.mem, title: "この画面のメモリの使用率" },
    { label: "STORAGE", value: m.storageText, ratio: m.storage, title: "この端末に保存しているデータ" },
    { label: "NETWORK", value: m.netText, ratio: m.net, title: "通信の状態" },
  ];
  return (
    <section className="hblock">
      <h3 className="hblock__title">SYSTEM STATUS</h3>
      <ul className="hrows">
        {rows.map((r) => (
          <li key={r.label} title={r.title}>
            <span>{r.label}</span>
            <Bar ratio={r.ratio} />
            <b>{r.value}</b>
          </li>
        ))}
      </ul>
    </section>
  );
});

/* ---------- CURRENT MODE ---------- */

export const MODE_LABEL: Record<CoreMode, string> = {
  idle: "STANDBY",
  listening: "LISTENING",
  connect: "PROCESSING",
  think: "THINKING",
  search: "SEARCHING",
  create: "RESPONDING",
  speaking: "RESPONDING",
};

export const CurrentMode = memo(function CurrentMode({ mode, hint }: { mode: CoreMode; hint: string }) {
  return (
    <section className="hblock hmode" data-mode={mode}>
      <h3 className="hblock__title">CURRENT MODE</h3>
      <b className="hmode__value" title={hint}>
        <i />
        {MODE_LABEL[mode]}
      </b>
    </section>
  );
});

/* ---------- 接続の短いバー（印・名前・バー・値） ---------- */

export const LinkBars = memo(function LinkBars({
  chatStatus,
  phase,
  brain,
  calendar,
  voiceState,
  lastRun,
  maxContext,
}: {
  chatStatus: ChatAgentStatus;
  phase: ChatPhase;
  brain?: StatusResponse["brain"];
  calendar?: StatusResponse["calendar"];
  voiceState: VoiceState;
  lastRun: LastRunStats;
  maxContext: number;
}) {
  const link = (s?: { configured: boolean; connected: boolean }) => (!s?.configured ? "—" : s.connected ? "ON" : "OFF");
  const ttft = lastRun.ttftMs;
  const ctx = lastRun.contextMessages ?? 0;
  const rows = [
    { label: "AI", value: chatStatus === "online" ? (phase === "idle" ? "ON" : "BUSY") : chatStatus === "offline" ? "OFF" : "…", ratio: chatStatus === "online" ? 1 : 0, live: phase !== "idle" },
    { label: "BRAIN", value: link(brain), ratio: brain?.connected ? 1 : brain?.configured ? 0 : null },
    { label: "CALENDAR", value: link(calendar), ratio: calendar?.connected ? 1 : calendar?.configured ? 0 : null },
    { label: "VOICE", value: voiceState === "off" ? "IDLE" : "ON", ratio: voiceState === "off" ? 0 : 1, live: voiceState === "listening" || voiceState === "speaking" },
    { label: "RESPONSE", value: ttft === undefined ? "—" : `${(ttft / 1000).toFixed(1)}s`, ratio: ttft === undefined ? null : 1 - ttft / 6000 },
    { label: "CONTEXT", value: `${ctx}/${maxContext}`, ratio: ctx / Math.max(1, maxContext) },
  ];
  return (
    <ul className="hrows hrows--short">
      {rows.map((r) => (
        <li key={r.label} data-off={r.value === "OFF" || undefined}>
          <i className="hrows__mark" />
          <span>{r.label}</span>
          <Bar ratio={r.ratio} live={r.live} />
          <b>{r.value}</b>
        </li>
      ))}
    </ul>
  );
});

/* ---------- 左下の現在地 ---------- */

export const LocationMark = memo(function LocationMark() {
  const w = useJson<{ ok: boolean; weather?: WeatherReport }>("/api/weather", [], 15 * 60_000);
  const wx = w?.ok ? w.weather : undefined;
  return (
    <div className="hloc">
      <svg viewBox="0 0 64 64" aria-hidden="true" className="hloc__cross">
        <circle cx="32" cy="32" r="22" />
        <circle cx="32" cy="32" r="11" />
        <circle cx="32" cy="32" r="4" className="hloc__dot" />
        <path d="M32 2v16M32 46v16M2 32h16M46 32h16" />
      </svg>
      <div className="hloc__text">
        <i className="hloc__rule" />
        <b>
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path d="M8 15s5-4.6 5-8.5a5 5 0 1 0-10 0C3 10.4 8 15 8 15z" />
            <circle cx="8" cy="6.5" r="1.8" />
          </svg>
          {wx ? wx.city.toUpperCase() : "—"}
        </b>
        <span>{wx ? `${Math.round(wx.now)}° ${wx.label}` : ""}</span>
        <i className="hloc__rule hloc__rule--long" />
      </div>
    </div>
  );
});

/* ---------- VOICE ACTIVITY：直近 1 分のうち、聞く・考える・話すをしていた割合 ---------- */

function useVoiceActivity(state: VoiceState): number | null {
  const log = useRef<{ at: number; on: boolean }[]>([]);
  const [ratio, setRatio] = useState<number | null>(null);
  const on = state === "listening" || state === "thinking" || state === "speaking";
  useEffect(() => {
    log.current.push({ at: Date.now(), on });
  }, [on]);
  const off = state === "off";
  useEffect(() => {
    if (off) {
      setRatio(null);
      return;
    }
    const WINDOW = 60_000;
    const calc = () => {
      const now = Date.now();
      const from = now - WINDOW;
      const l = log.current;
      while (l.length > 1 && l[1].at <= from) l.shift();
      let active = 0;
      for (let i = 0; i < l.length; i++) {
        const start = Math.max(from, l[i].at);
        const end = i + 1 < l.length ? l[i + 1].at : now;
        if (l[i].on && end > start) active += end - start;
      }
      setRatio(active / WINDOW);
    };
    calc();
    const t = setInterval(calc, 1000);
    return () => clearInterval(t);
  }, [off]);
  return ratio;
}

/** 流れる波の形（2 周期ぶん。左へ半分ずらすとつながって見える） */
function wavePath(amp: number, phase: number) {
  const top: string[] = [];
  const bottom: string[] = [];
  for (let x = 0; x <= 400; x += 5) {
    const y = amp * (0.55 + 0.45 * Math.sin((x / 400) * Math.PI * 8 + phase)) * Math.abs(Math.sin((x / 400) * Math.PI * 4 + phase * 0.5) * 0.6 + 0.4);
    top.push(`${x} ${(20 - y).toFixed(1)}`);
    bottom.unshift(`${x} ${(20 + y).toFixed(1)}`);
  }
  return `M${top.join("L")}L${bottom.join("L")}Z`;
}
const WAVE_A = wavePath(15, 0);
const WAVE_B = wavePath(10, 1.7);

export const VoiceActivity = memo(function VoiceActivity({ state }: { state: VoiceState }) {
  const ratio = useVoiceActivity(state);
  // 音声モードの間は、波の高さを実際の声の大きさに合わせて毎フレーム変える（測れないときは状態ごとの動き）
  const ampRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ampRef.current;
    if (!el || state === "off") return;
    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      if (!voiceLevel.live && !voiceLevel.speaking) {
        el.style.transform = "";
        el.style.transition = "";
        return;
      }
      el.style.transition = "none";
      el.style.transform = `scaleY(${(0.06 + voiceLevel.value * 0.94).toFixed(3)})`;
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      el.style.transform = "";
      el.style.transition = "";
    };
  }, [state]);
  return (
    <section className="hbox hvoice" data-voice={state}>
      <h3 className="hblock__title">
        VOICE ACTIVITY
        <b title="直近 1 分のうち、聞いたり話したりしていた割合">
          <i className="hlamp" data-on={state !== "off" || undefined} />
          {ratio === null ? "OFF" : `${Math.round(ratio * 100)}%`}
        </b>
      </h3>
      {/* 波は SVG の中を動かさず、外側の箱ごと横に流す（描き直しを起こさず軽い） */}
      <div className="hvoice__wave" aria-hidden="true">
        <div className="hvoice__amp" ref={ampRef}>
          <div className="hvoice__flow hvoice__flow--b">
            <svg viewBox="0 0 400 40" preserveAspectRatio="none">
              <path d={WAVE_B} />
            </svg>
          </div>
          <div className="hvoice__flow hvoice__flow--a">
            <svg viewBox="0 0 400 40" preserveAspectRatio="none">
              <path d={WAVE_A} />
            </svg>
          </div>
        </div>
      </div>
      <div className="hbox__ticks" aria-hidden="true">
        <i />
        <i />
        <i />
        <i />
      </div>
    </section>
  );
});

/* ---------- NOTIFICATIONS（近い順に 3 件） ---------- */

export const Notifications = memo(function Notifications({ news }: { news?: StatusResponse["news"] }) {
  const { items, ready } = useIncoming(news);
  return (
    <section className="hbox hnote">
      <h3 className="hblock__title">
        NOTIFICATIONS
        <b>{ready ? items.length : ""}</b>
      </h3>
      {items.length === 0 ? (
        <p className="hnote__empty">{ready ? "NO NEW ALERTS" : ""}</p>
      ) : (
        <ul>
          {items.slice(0, 3).map((it) => (
            <li key={it.key}>
              <span className="hnote__icon">
                <Icon name={it.icon} size={10} />
              </span>
              <span className="hnote__text">{it.text}</span>
              <time>{it.when}</time>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
});

/* ---------- ACTIVITY LIVE：直近 2 時間の会話の量（4 分ごと）・文脈の使用量・短い数字 ---------- */

const SLOTS = 30;
const SLOT_MS = 4 * 60_000;

export function ActivityLive({
  messages,
  phase,
  mode,
  lastRun,
  maxContext,
}: {
  messages: UiMessage[];
  phase: ChatPhase;
  mode: CoreMode;
  lastRun: LastRunStats;
  maxContext: number;
}) {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);
  const counts = new Array<number>(SLOTS).fill(0);
  let total = 0;
  if (now !== null) {
    for (const m of messages) {
      const k = Math.floor((now - m.createdAt) / SLOT_MS);
      if (k >= 0 && k < SLOTS) {
        counts[SLOTS - 1 - k]++;
        total++;
      }
    }
  }
  const peak = Math.max(4, ...counts);
  const ctx = lastRun.contextMessages ?? 0;
  const ttft = lastRun.ttftMs;
  const cells = [
    { label: "MSG", value: String(total), title: "直近 2 時間の発言数" },
    { label: "RT", value: ttft === undefined ? "—" : `${(ttft / 1000).toFixed(1)}s`, title: "最後の応答時間" },
    { label: "CTX", value: `${ctx}/${maxContext}`, title: "会話の文脈" },
    { label: "MODE", value: MODE_LABEL[mode].slice(0, 5), title: MODE_LABEL[mode] },
  ];
  return (
    <section className="hbox hactivity" data-busy={phase !== "idle" || undefined}>
      <header>
        <span>ACTIVITY</span>
        <b className="hactivity__live">
          <i /> LIVE
        </b>
      </header>
      <div className="hactivity__bars" aria-hidden="true" title={`${total} MSG / 2H`}>
        {counts.map((c, i) => (
          <i key={i} data-now={i === SLOTS - 1 || undefined} style={{ transform: `scaleY(${Math.max(0.05, c / peak).toFixed(3)})` }} />
        ))}
      </div>
      <div className="hactivity__meter" title={`会話の文脈 ${ctx}/${maxContext}`}>
        <Bar ratio={ctx / Math.max(1, maxContext)} live={phase !== "idle"} />
      </div>
      <ul className="hactivity__cells">
        {cells.map((c) => (
          <li key={c.label} title={c.title}>
            <span>{c.label}</span>
            <b>{c.value}</b>
          </li>
        ))}
      </ul>
    </section>
  );
}
