"use client";

/**
 * HOME の小さな部品（シンプル版）。数字はすべて実データ（無いものは「—」）。
 *   丸いメーター 4 つ／レーダーと現在地・時刻／システム状態／エージェント一覧／返事（RESPONSE）
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { StatusResponse } from "@/core/types";
import { AGENT_CARDS } from "@/data/agents";
import { TASKS_CHANGED, type LastRunStats, type UiMessage } from "@/hooks/useChat";
import type { VoiceState } from "@/hooks/useVoice";
import type { WeatherReport } from "@/integrations/weather";
import { HudFrame } from "../HudFrame";
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
        <circle cx="24" cy="24" r="23" className="gauge__bezel" />
        {Array.from({ length: 24 }, (_, i) => {
          const a = (i / 24) * Math.PI * 2;
          const r1 = i % 6 === 0 ? 20.6 : 21.6;
          return <line key={i} x1={24 + Math.cos(a) * r1} y1={24 + Math.sin(a) * r1} x2={24 + Math.cos(a) * 23} y2={24 + Math.sin(a) * 23} className="gauge__tick" />;
        })}
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
      <svg viewBox="-18 -18 216 216" aria-hidden="true">
        <circle cx="90" cy="90" r="98" className="radar__bezel" />
        {Array.from({ length: 72 }, (_, i) => {
          const a = ((i * 5 - 90) * Math.PI) / 180;
          const r1 = i % 6 === 0 ? 90 : 94;
          return <line key={i} x1={90 + Math.cos(a) * r1} y1={90 + Math.sin(a) * r1} x2={90 + Math.cos(a) * 98} y2={90 + Math.sin(a) * 98} className="radar__tick" />;
        })}
        {[0, 90, 180, 270].map((d) => {
          const a = ((d - 90) * Math.PI) / 180;
          return (
            <text key={d} x={90 + Math.cos(a) * 105} y={90 + Math.sin(a) * 105} className="radar__deg" textAnchor="middle" dominantBaseline="middle">
              {String(d).padStart(3, "0")}
            </text>
          );
        })}
        {[86, 64, 42, 20].map((r) => (
          <circle key={r} cx="90" cy="90" r={r} className="radar__ring" />
        ))}
        <path d="M90 4V176M4 90H176" className="radar__ring" />
        <g className="radar__sweep">
          <path d="M90 90 L90 4 A86 86 0 0 1 150.8 29.2 Z" />
          <animateTransform attributeName="transform" type="rotate" from="0 90 90" to="360 90 90" dur="5s" repeatCount="indefinite" />
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

export function SystemStatus({
  chatStatus,
  brain,
  calendar,
  lastRun,
}: {
  chatStatus: ChatAgentStatus;
  brain?: StatusResponse["brain"];
  calendar?: StatusResponse["calendar"];
  lastRun: LastRunStats;
}) {
  const ttft = lastRun.ttftMs;
  const rows = [
    { label: "CHAT LINK", value: chatStatus === "online" ? "ONLINE" : chatStatus === "checking" ? "…" : "OFFLINE", ratio: chatStatus === "online" ? 1 : 0 },
    { label: "BRAIN LINK", value: !brain?.configured ? "—" : brain.connected ? "ONLINE" : "OFFLINE", ratio: brain?.connected ? 1 : 0 },
    { label: "CALENDAR LINK", value: !calendar?.configured ? "—" : calendar.connected ? "ONLINE" : "OFFLINE", ratio: calendar?.connected ? 1 : 0 },
    { label: "RESPONSE", value: ttft === undefined ? "—" : `${(ttft / 1000).toFixed(1)}s`, ratio: ttft === undefined ? 0 : Math.max(0.05, 1 - ttft / 6000) },
  ];
  return (
    <section className="panel hud spanel">
      <HudFrame cut={10} small={4} ticks={false} />
      <header className="spanel__head">
        SYSTEM STATUS <i>////</i>
      </header>
      <ul className="sstatus">
        {rows.map((r) => (
          <li key={r.label}>
            <span>{r.label}</span>
            <b>{r.value}</b>
            <i className="sstatus__leds">
              {Array.from({ length: 20 }, (_, k) => (
                <em key={k} data-on={k < Math.round(r.ratio * 20) || undefined} />
              ))}
            </i>
          </li>
        ))}
      </ul>
    </section>
  );
}

/* ---------- エージェント一覧 ---------- */

export function AgentRoster({ chatStatus, brain, onOpenChat }: { chatStatus: ChatAgentStatus; brain?: StatusResponse["brain"]; onOpenChat: () => void }) {
  return (
    <section className="panel hud spanel">
      <HudFrame cut={10} small={4} ticks={false} />
      <header className="spanel__head">
        AGENT ROSTER <i>////</i>
      </header>
      <ul className="roster">
        <li data-on>
          <span className="roster__dot" />
          F.R.I.D.A.Y.
        </li>
        {AGENT_CARDS.map((a) => {
          const on = agentOnline(a.key, a.phase, chatStatus, brain);
          return (
            <li key={a.key} data-on={on || undefined}>
              <button type="button" onClick={a.phase === "live" ? onOpenChat : undefined} aria-disabled={a.phase !== "live"} title={a.engine}>
                <span className="roster__dot" />
                {a.title}
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/* ---------- 返事（RESPONSE） ---------- */

const VOICE_TAG: Record<VoiceState, string> = { off: "TEXT", standby: "WAKE", listening: "LISTENING", thinking: "THINKING", speaking: "SPEAKING" };

export function ResponsePanel({ messages, voiceState, onOpenChat }: { messages: UiMessage[]; voiceState: VoiceState; onOpenChat: () => void }) {
  const question = [...messages].reverse().find((m) => m.role === "user");
  const last = messages[messages.length - 1];
  const reply = last?.role === "assistant" ? last : undefined;
  const bodyRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [reply?.content]);
  const waiting = question && (!reply || (reply.status === "streaming" && !reply.content));
  return (
    <section className="panel hud rpanel" aria-live="polite">
      <HudFrame cut={10} small={4} ticks={false} />
      <header className="spanel__head">
        RESPONSE
        <span className="rpanel__state" data-voice={voiceState}>
          ● {VOICE_TAG[voiceState]}
        </span>
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
