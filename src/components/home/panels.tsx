"use client";

/**
 * HOME の小さな部品（シンプル版）。数字はすべて実データ（無いものは「—」）。
 *   丸いメーター／レーダーと現在地・時刻／システム状態／コア周りの処理ノード／エージェント一覧／INCOMING／返事（RESPONSE）
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { StatusResponse } from "@/core/types";
import { AGENT_CARDS } from "@/data/agents";
import { CALENDAR_CHANGED, TASKS_CHANGED, type ChatPhase, type ChatStage, type LastRunStats, type UiMessage } from "@/hooks/useChat";
import { REMINDERS_CHANGED } from "@/hooks/useReminders";
import type { VoiceState } from "@/hooks/useVoice";
import type { WeatherReport } from "@/integrations/weather";
import { HudFrame } from "../HudFrame";
import { Icon, type IconName } from "../icons";
import { Markdown } from "../Markdown";

export type ChatAgentStatus = "checking" | "online" | "offline";

function useJson<T>(url: string | null, events: string[] = [], everyMs = 0): T | null {
  const [data, setData] = useState<T | null>(null);
  useEffect(() => {
    if (!url) return;
    let alive = true;
    const load = () =>
      fetch(url, { cache: "no-store" })
        .then((r) => r.json() as Promise<T>)
        .then((j) => alive && setData(j))
        .catch(() => {});
    void load();
    const t = everyMs ? setInterval(load, everyMs) : 0;
    const evs = ["focus", ...events];
    evs.forEach((e) => window.addEventListener(e, load));
    return () => {
      alive = false;
      clearInterval(t);
      evs.forEach((e) => window.removeEventListener(e, load));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url]);
  return data;
}

function useClock(): Date | null {
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    setNow(new Date());
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  return now;
}

/** 動いている（または脳につながっている）エージェントか */
export function agentOnline(key: string, phase: string, chat: ChatAgentStatus, brain?: StatusResponse["brain"]): boolean {
  if (key === "vault" || key === "memai") return Boolean(brain?.connected);
  return phase === "live" && chat === "online";
}

/* ---------- 丸いメーター ---------- */

function Gauge({ value, ratio, label, title }: { value: string; ratio: number; label: string; title: string }) {
  const r = 19;
  const len = 2 * Math.PI * r;
  return (
    <div className="gauge" title={title}>
      <svg viewBox="0 0 48 48" aria-hidden="true">
        <circle cx="24" cy="24" r={r} className="gauge__track" />
        <circle cx="24" cy="24" r={r} className="gauge__fill" strokeDasharray={`${Math.max(0.02, Math.min(1, ratio)) * len} ${len}`} />
      </svg>
      <b>{value}</b>
      <span>{label}</span>
    </div>
  );
}

export function Gauges({ chatStatus, brain, lastRun, maxContext }: { chatStatus: ChatAgentStatus; brain?: StatusResponse["brain"]; lastRun: LastRunStats; maxContext: number }) {
  const tasks = useJson<{ configured: boolean; todos: unknown[] }>("/api/projects", [TASKS_CHANGED]);
  const agents = AGENT_CARDS.filter((a) => agentOnline(a.key, a.phase, chatStatus, brain)).length;
  const ctx = lastRun.contextMessages ?? 0;
  const notes = brain?.connected ? (brain.notes ?? 0) : null;
  const todo = tasks?.configured ? tasks.todos.length : null;
  return (
    <div className="gauges">
      <Gauge value={String(agents)} ratio={agents / AGENT_CARDS.length} label="AGENTS" title={`動いているエージェント ${agents} / ${AGENT_CARDS.length}`} />
      <Gauge value={notes === null ? "—" : String(notes)} ratio={notes === null ? 0 : Math.min(1, notes / 100)} label="NOTES" title="脳（Obsidian）のノート数" />
      <Gauge value={todo === null ? "—" : String(todo)} ratio={todo === null ? 0 : Math.min(1, todo / 10)} label="TODO" title="未完了の ToDo" />
      <Gauge value={String(ctx)} ratio={ctx / Math.max(1, maxContext)} label="CONTEXT" title={`会話の文脈 ${ctx} / ${maxContext} 件`} />
    </div>
  );
}

/* ---------- レーダーと現在地 ---------- */

export function RadarLocal() {
  const w = useJson<{ ok: boolean; weather?: WeatherReport }>("/api/weather", [], 15 * 60_000);
  const now = useClock();
  const city = w?.ok && w.weather ? w.weather.city.toUpperCase() : "—";
  const stamp = now
    ? `${now.getFullYear()}.${String(now.getMonth() + 1).padStart(2, "0")}.${String(now.getDate()).padStart(2, "0")} ${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`
    : "";
  return (
    <div className="radar">
      <svg viewBox="0 0 180 180" aria-hidden="true">
        {[86, 64, 42, 20].map((r) => (
          <circle key={r} cx="90" cy="90" r={r} className="radar__ring" />
        ))}
        <path d="M90 4V176M4 90H176" className="radar__ring" />
        <g className="radar__sweep">
          <path d="M90 90 L90 4 A86 86 0 0 1 150.8 29.2 Z" />
        </g>
        <circle cx="118" cy="62" r="2.4" className="radar__blip" />
        <circle cx="70" cy="112" r="1.8" className="radar__blip radar__blip--b" />
        <circle cx="90" cy="90" r="2.6" className="radar__center" />
      </svg>
      <div className="radar__local">
        <b>LOCAL</b>
        <span>
          {city} / {stamp}
        </span>
      </div>
    </div>
  );
}

/* ---------- システム状態 ---------- */

type Lamp = "online" | "offline" | "processing" | "idle";

export function SystemStatus({
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
  const busy = phase !== "idle";
  const ttft = lastRun.ttftMs;
  const link = (configured: boolean | undefined, connected: boolean | undefined): Lamp => (!configured ? "idle" : connected ? "online" : "offline");
  const rows: { label: string; icon: IconName; lamp: Lamp; value: string; ratio: number }[] = [
    {
      label: "CHAT LINK",
      icon: "chat",
      lamp: chatStatus === "offline" ? "offline" : busy ? "processing" : chatStatus === "online" ? "online" : "idle",
      value: chatStatus === "offline" ? "OFFLINE" : busy ? "PROCESSING" : chatStatus === "online" ? "ONLINE" : "LINKING",
      ratio: chatStatus === "online" ? 1 : 0,
    },
    {
      label: "BRAIN LINK",
      icon: "brain",
      lamp: link(brain?.configured, brain?.connected),
      value: !brain?.configured ? "NOT SET" : brain.connected ? "ONLINE" : "OFFLINE",
      ratio: brain?.connected ? 1 : 0,
    },
    {
      label: "CALENDAR LINK",
      icon: "calendar",
      lamp: link(calendar?.configured, calendar?.connected),
      value: !calendar?.configured ? "NOT SET" : calendar.connected ? "ONLINE" : "OFFLINE",
      ratio: calendar?.connected ? 1 : 0,
    },
  ];
  return (
    <section className="panel hud spanel">
      <HudFrame cut={10} small={4} ticks={false} />
      <header className="spanel__head">
        <Icon name="pulse" size={14} /> SYSTEM STATUS <i className="spanel__bars" aria-hidden="true"><b /><b /><b /><b /></i>
      </header>
      <ul className="sstatus">
        {rows.map((r) => (
          <li key={r.label} data-lamp={r.lamp}>
            <span className="sstatus__name">
              <Icon name={r.icon} size={13} />
              {r.label}
            </span>
            <b className="sstatus__value">
              <i className="sstatus__lamp" />
              {r.value}
            </b>
            <i className="sstatus__bar">
              <em style={{ transform: `scaleX(${r.ratio})` }} />
            </i>
          </li>
        ))}
        <li data-lamp={ttft === undefined ? "idle" : "online"}>
          <span className="sstatus__name">
            <Icon name="pulse" size={13} />
            RESPONSE
          </span>
          <b className="sstatus__value sstatus__value--num">{ttft === undefined ? "—" : `${(ttft / 1000).toFixed(1)}s`}</b>
          <i className="sstatus__bar sstatus__bar--flow">
            <em style={{ transform: `scaleX(${ttft === undefined ? 0 : Math.max(0.05, 1 - ttft / 6000)})` }} />
          </i>
        </li>
      </ul>
    </section>
  );
}

/* ---------- コア周りの処理ノード（F.R.I.D.A.Y. が今していること） ---------- */

export type ProcessKey = "think" | "search" | "connect" | "create";

export const PROCESS_NODES: { key: ProcessKey; title: string; sub: string; icon: IconName }[] = [
  { key: "think", title: "THINK", sub: "ANALYZE", icon: "brain" },
  { key: "connect", title: "CONNECT", sub: "INTEGRATE", icon: "link" },
  { key: "search", title: "SEARCH", sub: "COLLECT", icon: "search" },
  { key: "create", title: "CREATE", sub: "GENERATE", icon: "doc" },
];

/** いま光らせる処理（答えを考え中 → THINK、検索中 → SEARCH、外部の情報を集め中 → CONNECT、文章を出している → CREATE） */
export function activeProcess(phase: ChatPhase, stage: ChatStage): ProcessKey | null {
  if (phase === "streaming") return "create";
  if (phase === "waiting") return stage ?? "think";
  return null;
}

export function ProcessNode({ node, active, side }: { node: (typeof PROCESS_NODES)[number]; active: boolean; side: "left" | "right" }) {
  return (
    <div className="pnode" data-key={node.key} data-side={side} data-active={active || undefined}>
      <span className="pnode__icon">
        <svg viewBox="0 0 36 36" aria-hidden="true">
          <circle cx="18" cy="18" r="16" className="pnode__ring" pathLength="100" />
        </svg>
        <Icon name={node.icon} size={15} />
      </span>
      <span className="pnode__text">
        <b>{node.title}</b>
        <small>{active ? "ACTIVE" : node.sub}</small>
      </span>
      <i className="pnode__link" aria-hidden="true" />
    </div>
  );
}

/* ---------- エージェント一覧 ---------- */

type AgentLamp = "online" | "standby" | "processing" | "offline";

const AGENT_ICON: Record<string, IconName> = {
  chat: "chat",
  search: "search",
  writing: "doc",
  vault: "vault",
  automation: "automation",
  analysis: "analysis",
  sns: "share",
  memai: "brain",
};

export function AgentRoster({
  chatStatus,
  phase,
  stage,
  brain,
  automation,
  onOpenChat,
}: {
  chatStatus: ChatAgentStatus;
  phase: ChatPhase;
  stage: ChatStage;
  brain?: StatusResponse["brain"];
  automation?: StatusResponse["automation"];
  onOpenChat: () => void;
}) {
  const busy = phase !== "idle";
  const lampOf = (key: string, live: boolean): AgentLamp => {
    if (key === "vault" || key === "memai") {
      if (!brain?.configured) return "standby";
      if (!brain.connected) return "offline";
      return busy && stage === "connect" ? "processing" : "online";
    }
    if (key === "automation" && !automation?.diary) return "standby";
    if (!live) return "standby";
    if (chatStatus === "offline") return "offline";
    if (key === "chat" && busy) return "processing";
    if (key === "search" && busy && stage === "search") return "processing";
    if (key === "writing" && phase === "streaming") return "processing";
    return chatStatus === "online" ? "online" : "standby";
  };
  const rows = AGENT_CARDS.map((a) => ({ a, lamp: lampOf(a.key, a.phase === "live") }));
  const friday: AgentLamp = chatStatus === "offline" ? "offline" : busy ? "processing" : chatStatus === "online" ? "online" : "standby";
  const all = [friday, ...rows.map((r) => r.lamp)];
  const standby = all.filter((l) => l === "standby").length;
  const offline = all.filter((l) => l === "offline").length;
  return (
    <section className="panel hud spanel">
      <HudFrame cut={10} small={4} ticks={false} />
      <header className="spanel__head">
        <Icon name="brain" size={14} /> AGENT ROSTER <i>////</i>
      </header>
      <ul className="roster">
        <li data-lamp={friday}>
          <span className="roster__icon">
            <Icon name="pulse" size={13} />
          </span>
          <span className="roster__name">F.R.I.D.A.Y.</span>
          <span className="roster__state">
            <i />
            {friday.toUpperCase()}
          </span>
        </li>
        {rows.map(({ a, lamp }) => (
          <li key={a.key} data-lamp={lamp}>
            <button type="button" onClick={a.phase === "live" ? onOpenChat : undefined} aria-disabled={a.phase !== "live"} title={a.engine}>
              <span className="roster__icon">
                <Icon name={AGENT_ICON[a.key] ?? "chat"} size={13} />
              </span>
              <span className="roster__name">{a.title}</span>
              <span className="roster__state">
                <i />
                {lamp.toUpperCase()}
              </span>
            </button>
          </li>
        ))}
      </ul>
      <p className="roster__summary">
        {all.length} AGENTS / {standby} STANDBY{offline ? ` / ${offline} OFFLINE` : ""}
      </p>
    </section>
  );
}

/* ---------- INCOMING（予定・リマインダー・期限の ToDo・ニュース） ---------- */

interface Incoming {
  key: string;
  icon: IconName;
  text: string;
  /** 並べ替え用（近い順） */
  at: number;
  when: string;
}

const hhmm = (d: Date) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;

function relative(at: number, now: number): string {
  const min = Math.round((at - now) / 60_000);
  if (min <= 0 && min > -60) return "NOW";
  if (min < 0) return "TODAY";
  if (min < 60) return `${min}m`;
  if (min < 24 * 60) return `${Math.floor(min / 60)}h`;
  return `${Math.floor(min / 1440)}d`;
}

export function IncomingPanel({ news }: { news?: StatusResponse["news"] }) {
  const cal = useJson<{ connected?: boolean; events?: { id: string; title: string; start: string; allDay: boolean; timeLabel: string }[] }>(
    "/api/calendar/events?days=1",
    [CALENDAR_CHANGED],
    5 * 60_000,
  );
  const rem = useJson<{ reminders?: { id: string; at: number; label: string; text: string }[] }>("/api/reminders", [REMINDERS_CHANGED], 60_000);
  const tasks = useJson<{ configured: boolean; todos: { text: string; due?: string; project?: string }[] }>("/api/projects", [TASKS_CHANGED]);
  const clock = useClock();
  const now = clock?.getTime() ?? 0;
  const today = clock ? `${clock.getFullYear()}-${String(clock.getMonth() + 1).padStart(2, "0")}-${String(clock.getDate()).padStart(2, "0")}` : "";

  const items: Incoming[] = [];
  if (clock) {
    for (const e of cal?.events ?? []) {
      const at = Date.parse(e.start);
      if (!e.allDay && at < now - 30 * 60_000) continue;
      items.push({ key: `c${e.id}`, icon: "calendar", text: `予定：${e.title}`, at: e.allDay ? now : at, when: e.allDay ? "TODAY" : e.timeLabel || relative(at, now) });
    }
    for (const r of rem?.reminders ?? []) {
      if (r.at < now - 60 * 60_000 || r.at > now + 24 * 3600_000) continue;
      items.push({ key: `r${r.id}`, icon: "bell", text: `リマインダー：${r.text}`, at: r.at, when: relative(r.at, now) });
    }
    for (const t of tasks?.todos ?? []) {
      if (!t.due || t.due > today) continue;
      items.push({ key: `t${t.text}`, icon: "tasks", text: `タスク：${t.text}`, at: now - (t.due < today ? 1 : 0), when: t.due < today ? "OVERDUE" : "TODAY" });
    }
    if (news && news.time !== "off") {
      const [h, m] = news.time.split(":").map(Number);
      const at = new Date(clock);
      at.setHours(h || 0, m || 0, 0, 0);
      if (at.getTime() < now) at.setDate(at.getDate() + 1);
      items.push({ key: "news", icon: "search", text: `ニュースのまとめ（${news.time}）`, at: at.getTime(), when: relative(at.getTime(), now) });
    }
  }
  items.sort((a, b) => a.at - b.at);
  return (
    <section className="panel hud spanel incoming">
      <HudFrame cut={10} small={4} ticks={false} />
      <header className="spanel__head">
        <Icon name="bell" size={14} /> INCOMING <i>////</i>
      </header>
      {items.length === 0 ? (
        <p className="incoming__empty">{clock ? "新しいお知らせはありません" : ""}</p>
      ) : (
        <ul className="incoming__list">
          {items.slice(0, 5).map((it) => (
            <li key={it.key}>
              <span className="incoming__icon">
                <Icon name={it.icon} size={12} />
              </span>
              <span className="incoming__text">{it.text}</span>
              <time>{it.when}</time>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/* ---------- 返事（RESPONSE） ---------- */

const VOICE_TAG: Record<VoiceState, string> = { off: "TEXT", standby: "WAKE", listening: "LISTENING", thinking: "THINKING", speaking: "SPEAKING" };

export function ResponsePanel({
  messages,
  phase,
  voiceState,
  lastRun,
  onOpenChat,
}: {
  messages: UiMessage[];
  phase: ChatPhase;
  voiceState: VoiceState;
  lastRun: LastRunStats;
  onOpenChat: () => void;
}) {
  const question = [...messages].reverse().find((m) => m.role === "user");
  const last = messages[messages.length - 1];
  const reply = last?.role === "assistant" ? last : undefined;
  const bodyRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [reply?.content]);
  const waiting = question && (!reply || (reply.status === "streaming" && !reply.content));
  const state = phase === "waiting" ? "PROCESSING" : phase === "streaming" ? "RESPONDING" : VOICE_TAG[voiceState];
  const rt = reply?.meta?.ttftMs ?? lastRun.ttftMs;
  return (
    <section className="panel hud rpanel" aria-live="polite" data-busy={phase !== "idle" || undefined}>
      <HudFrame cut={12} small={5} ticks={false} />
      <header className="spanel__head">
        RESPONSE
        <span className="rpanel__state" data-voice={voiceState}>
          ● {state}
        </span>
        <span className="rpanel__rt">RT {rt === undefined ? "—" : `${(rt / 1000).toFixed(1)}s`}</span>
        <button type="button" className="rpanel__chat" onClick={onOpenChat}>
          CHAT →
        </button>
      </header>
      <div className="rpanel__body" ref={bodyRef}>
        {question ? (
          <>
            <p className="rpanel__q">&gt; {question.content}</p>
            {waiting ? (
              <span className="signal" aria-label="応答を生成中">
                <i />
                <i />
                <i />
                <i />
              </span>
            ) : reply?.status === "error" && !reply.content ? (
              <p className="rpanel__err">{reply.error?.message}</p>
            ) : (
              <div className="md rpanel__a">
                <Markdown text={reply?.content ?? ""} />
              </div>
            )}
          </>
        ) : (
          <p className="rpanel__empty">「フライデー」と呼ぶか、下の入力欄から話しかけてください。</p>
        )}
      </div>
    </section>
  );
}
