"use client";

/**
 * ミニマル HUD の表示部品。どれも「短い名前 + 数字」だけを出し、数字はすべて実データ（取れないものは「—」）。
 *   上のタブ（AGENTS / NOTES / TASKS / CONTEXT）／SYSTEM STATUS（この端末の負荷）／CURRENT MODE／接続の短いバー
 *   左下の現在地／VOICE ACTIVITY／NOTIFICATIONS／ACTIVITY LIVE（会話の量）
 */
import { useEffect, useRef, useState } from "react";
import type { StatusResponse } from "@/core/types";
import { AGENT_CARDS } from "@/data/agents";
import { TASKS_CHANGED, type ChatPhase, type LastRunStats, type UiMessage } from "@/hooks/useChat";
import type { VoiceState } from "@/hooks/useVoice";
import type { WeatherReport } from "@/integrations/weather";
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

export function TopTabs({
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
  const tabs: { key: HomeTab; label: string; value: string; title: string }[] = [
    { key: "agents", label: "AGENTS", value: `${agents}/${AGENT_CARDS.length}`, title: "動いているエージェント（一覧を開く）" },
    { key: "notes", label: "NOTES", value: notes === null ? "—" : String(notes), title: "脳（Obsidian）のノート数（MEMORY を開く）" },
    { key: "tasks", label: "TASKS", value: todo === null ? "—" : String(todo), title: "未完了の ToDo（TASKS を開く）" },
    { key: "context", label: "CONTEXT", value: `${ctx}/${maxContext}`, title: "会話の文脈（CHAT を開く）" },
  ];
  return (
    <nav className="htabs" aria-label="HOME のタブ">
      {tabs.map((t) => (
        <button key={t.key} type="button" className="htab" data-open={open === t.key || undefined} onClick={() => onTab(t.key)} title={t.title}>
          <span>{t.label}</span>
          <b>{t.value}</b>
        </button>
      ))}
    </nav>
  );
}

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

function useDeviceMetrics(active: boolean): Metrics {
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
        memText: heap ? mb(heap.usedJSHeapSize) : "—",
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

export function SystemBars({ active }: { active: boolean }) {
  const m = useDeviceMetrics(active);
  const pct = (r: number | null) => (r === null ? "—" : `${Math.round(r * 100)}%`);
  const rows = [
    { label: "CPU", value: pct(m.cpu), ratio: m.cpu, title: "この画面の処理の重さ" },
    { label: "MEMORY", value: m.memText, ratio: m.mem, title: "この画面が使っているメモリ" },
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
            <b>{r.value}</b>
            <Bar ratio={r.ratio} />
          </li>
        ))}
      </ul>
    </section>
  );
}

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

export function CurrentMode({ mode, hint }: { mode: CoreMode; hint: string }) {
  return (
    <section className="hmode" data-mode={mode}>
      <span className="hmode__label">CURRENT MODE</span>
      <b className="hmode__value">
        <i />
        {MODE_LABEL[mode]}
      </b>
      <small className="hmode__hint">{hint}</small>
    </section>
  );
}

/* ---------- 接続の短いバー ---------- */

export function LinkBars({
  chatStatus,
  phase,
  brain,
  calendar,
  lastRun,
}: {
  chatStatus: ChatAgentStatus;
  phase: ChatPhase;
  brain?: StatusResponse["brain"];
  calendar?: StatusResponse["calendar"];
  lastRun: LastRunStats;
}) {
  const link = (s?: { configured: boolean; connected: boolean }) => (!s?.configured ? "—" : s.connected ? "ON" : "OFF");
  const ttft = lastRun.ttftMs;
  const rows = [
    { label: "AI", value: chatStatus === "online" ? (phase === "idle" ? "ON" : "BUSY") : chatStatus === "offline" ? "OFF" : "…", ratio: chatStatus === "online" ? 1 : 0, live: phase !== "idle" },
    { label: "BRAIN", value: link(brain), ratio: brain?.connected ? 1 : brain?.configured ? 0 : null },
    { label: "CALENDAR", value: link(calendar), ratio: calendar?.connected ? 1 : calendar?.configured ? 0 : null },
    { label: "RESPONSE", value: ttft === undefined ? "—" : `${(ttft / 1000).toFixed(1)}s`, ratio: ttft === undefined ? null : 1 - ttft / 6000 },
  ];
  return (
    <ul className="hrows hrows--short">
      {rows.map((r) => (
        <li key={r.label} data-off={r.value === "OFF" || undefined}>
          <span>{r.label}</span>
          <Bar ratio={r.ratio} live={r.live} />
          <b>{r.value}</b>
        </li>
      ))}
    </ul>
  );
}

/* ---------- 左下の現在地 ---------- */

export function LocationMark() {
  const w = useJson<{ ok: boolean; weather?: WeatherReport }>("/api/weather", [], 15 * 60_000);
  const wx = w?.ok ? w.weather : undefined;
  return (
    <div className="hloc">
      <svg viewBox="0 0 44 44" aria-hidden="true" className="hloc__cross">
        <circle cx="22" cy="22" r="15" />
        <circle cx="22" cy="22" r="3" className="hloc__dot" />
        <path d="M22 1v10M22 33v10M1 22h10M33 22h10" />
      </svg>
      <div>
        <b>{wx ? wx.city.toUpperCase() : "—"}</b>
        <span>{wx ? `${Math.round(wx.now)}° ${wx.label}` : "LOCATION"}</span>
      </div>
    </div>
  );
}

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

const WAVE = Array.from({ length: 36 }, (_, i) => 0.3 + 0.7 * Math.abs(Math.sin(i * 1.7) * Math.cos(i * 0.45)));

export function VoiceActivity({ state }: { state: VoiceState }) {
  const ratio = useVoiceActivity(state);
  return (
    <section className="hblock hvoice" data-voice={state}>
      <h3 className="hblock__title">
        VOICE ACTIVITY
        <b title="直近 1 分のうち、聞いたり話したりしていた割合">{ratio === null ? "OFF" : `${Math.round(ratio * 100)}%`}</b>
      </h3>
      <div className="hvoice__wave" aria-hidden="true">
        {WAVE.map((h, i) => (
          <i key={i} style={{ "--h": h.toFixed(2), animationDelay: `${(-i * 0.09).toFixed(2)}s` } as React.CSSProperties} />
        ))}
      </div>
    </section>
  );
}

/* ---------- NOTIFICATIONS（近い順に 3 件） ---------- */

export function Notifications({ news }: { news?: StatusResponse["news"] }) {
  const { items, ready } = useIncoming(news);
  return (
    <section className="hblock hnote">
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
              <Icon name={it.icon} size={12} />
              <span>{it.text}</span>
              <time>{it.when}</time>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/* ---------- ACTIVITY LIVE：直近 2 時間の会話の量（5 分ごと） ---------- */

const SLOTS = 24;
const SLOT_MS = 5 * 60_000;

export function ActivityLive({ messages, phase }: { messages: UiMessage[]; phase: ChatPhase }) {
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
  return (
    <section className="hactivity" data-busy={phase !== "idle" || undefined}>
      <header>
        <span>ACTIVITY</span>
        <b className="hactivity__live">
          <i /> LIVE
        </b>
        <em>{total} MSG / 2H</em>
      </header>
      <div className="hactivity__bars" aria-hidden="true">
        {counts.map((c, i) => (
          <i key={i} data-now={i === SLOTS - 1 || undefined} style={{ transform: `scaleY(${Math.max(0.06, c / peak).toFixed(3)})` }} />
        ))}
      </div>
    </section>
  );
}
