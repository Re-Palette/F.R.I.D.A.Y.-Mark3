"use client";

/**
 * HOME の部品（共通の読み込み・レーダー・エージェント一覧・お知らせ・返事）。数字はすべて実データ（無いものは「—」）。
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

export function useJson<T>(url: string | null, events: string[] = [], everyMs = 0): T | null {
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

export function useClock(): Date | null {
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

/* ---------- レーダー ---------- */

export function Radar() {
  const ticks = Array.from({ length: 36 }, (_, i) => i * 10);
  return (
    <div className="radar" aria-hidden="true">
      <svg viewBox="0 0 180 180">
        <defs>
          <linearGradient id="radar-sweep" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0" stopColor="#ff6a00" stopOpacity="0" />
            <stop offset="1" stopColor="#ffb347" stopOpacity="0.95" />
          </linearGradient>
        </defs>
        <circle cx="90" cy="90" r="84" className="radar__rim" />
        <circle cx="90" cy="90" r="56" className="radar__ring" />
        <circle cx="90" cy="90" r="28" className="radar__ring" />
        {ticks.map((d) => (
          <path key={d} className="radar__tick" d={`M90 ${d % 90 === 0 ? 8 : 10}V${d % 90 === 0 ? 18 : 14}`} transform={`rotate(${d} 90 90)`} />
        ))}
        <path d="M90 16V164M16 90H164" className="radar__ring radar__ring--cross" />
        <circle cx="118" cy="62" r="2.4" className="radar__blip" />
        <circle cx="66" cy="118" r="1.8" className="radar__blip radar__blip--b" />
        <circle cx="90" cy="90" r="3" className="radar__center" />
      </svg>
      {/* 回る扇形は別の SVG にして、要素ごと回す（描き直しを起こさず軽い） */}
      <svg viewBox="0 0 180 180" className="radar__spinner">
        <path d="M90 90 L90 6 A84 84 0 0 1 132 17.2 Z" fill="url(#radar-sweep)" />
        <path d="M90 90 L132 17.2" className="radar__edge" />
      </svg>
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

/* ---------- お知らせ（予定・リマインダー・期限の ToDo・ニュース） ---------- */

export interface Incoming {
  key: string;
  icon: IconName;
  text: string;
  /** 並べ替え用（近い順） */
  at: number;
  when: string;
}

const hhmm = (d: Date) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;

/** 近いお知らせを近い順に（すべて実データ） */
export function useIncoming(news?: StatusResponse["news"]): { items: Incoming[]; ready: boolean } {
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
      items.push({ key: `c${e.id}`, icon: "calendar", text: e.title, at: e.allDay ? now : at, when: e.allDay ? "TODAY" : e.timeLabel || hhmm(new Date(at)) });
    }
    for (const r of rem?.reminders ?? []) {
      if (r.at < now - 60 * 60_000 || r.at > now + 24 * 3600_000) continue;
      items.push({ key: `r${r.id}`, icon: "bell", text: r.text, at: r.at, when: hhmm(new Date(r.at)) });
    }
    for (const t of tasks?.todos ?? []) {
      if (!t.due || t.due > today) continue;
      items.push({ key: `t${t.text}`, icon: "tasks", text: t.text, at: now - (t.due < today ? 1 : 0), when: t.due < today ? "OVERDUE" : "TODAY" });
    }
    if (news && news.time !== "off") {
      const [h, m] = news.time.split(":").map(Number);
      const at = new Date(clock);
      at.setHours(h || 0, m || 0, 0, 0);
      if (at.getTime() < now) at.setDate(at.getDate() + 1);
      items.push({ key: "news", icon: "search", text: "ニュースのまとめ", at: at.getTime(), when: news.time });
    }
  }
  items.sort((a, b) => a.at - b.at);
  return { items, ready: clock !== null };
}

/* ---------- 返事（RESPONSE）：必要なときだけ開く HUD パネル ---------- */

const VOICE_TAG: Record<VoiceState, string> = { off: "TEXT", standby: "WAKE", listening: "LISTENING", thinking: "THINKING", speaking: "SPEAKING" };

/** 検索の結果は ① 要約（返事の本文）→ ② 関連 Web ページ の順に出す */
export function ResponsePanel({
  messages,
  phase,
  voiceState,
  lastRun,
  onOpenChat,
  onClose,
}: {
  messages: UiMessage[];
  phase: ChatPhase;
  voiceState: VoiceState;
  lastRun: LastRunStats;
  onOpenChat: () => void;
  onClose: () => void;
}) {
  const question = [...messages].reverse().find((m) => m.role === "user");
  const last = messages[messages.length - 1];
  const reply = last?.role === "assistant" ? last : undefined;
  const bodyRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (el && reply?.status === "streaming") el.scrollTop = el.scrollHeight;
  }, [reply?.content, reply?.status]);
  const waiting = question && (!reply || (reply.status === "streaming" && !reply.content));
  const state = phase === "waiting" ? "PROCESSING" : phase === "streaming" ? "RESPONDING" : VOICE_TAG[voiceState];
  const rt = reply?.meta?.ttftMs ?? lastRun.ttftMs;
  const sources = reply && reply.status !== "streaming" ? (reply.sources ?? []) : [];
  const docs = reply?.documents?.filter((d) => d.ok) ?? [];
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
        <button type="button" className="rpanel__close" onClick={onClose} aria-label="返事のパネルを閉じる" title="閉じる">
          ×
        </button>
      </header>
      <div className="rpanel__body" ref={bodyRef}>
        {question && (
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
            {docs.length > 0 && (
              <p className="rpanel__docs">
                <Icon name="doc" size={12} /> {docs.map((d) => d.title).join(" / ")}
                <button type="button" onClick={onOpenChat}>
                  OPEN
                </button>
              </p>
            )}
            {sources.length > 0 && (
              <div className="rpanel__sources">
                <b>SOURCES</b>
                <ul aria-label="検索で参照したページ">
                  {sources.map((src) => (
                    <li key={src.uri}>
                      <a href={src.uri} target="_blank" rel="noreferrer noopener" title={src.title}>
                        <Icon name="search" size={11} /> {src.title}
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
}
