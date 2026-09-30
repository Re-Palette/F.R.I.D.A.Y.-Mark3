"use client";

/**
 * HOME の各パネル（戦術 HUD 風）。数字はすべて実データ（無いものは演出だけで数字を出さない）。
 *   天気（小）／AI エージェント一覧／最近の活動（会話ログ）／パフォーマンス（ToDo・応答時間）
 *   ネットワーク（接続先サービスの衛星ネットワーク）／ニューラルメモリ（脳のノート）／クイックアクション
 */
import { useEffect, useMemo, useState } from "react";
import type { StatusResponse } from "@/core/types";
import { QUICK_ACCESS } from "@/data/dashboard";
import { AGENT_CARDS, type AgentCardDef } from "@/data/agents";
import { ACTIVITY_CHANGED, TASKS_CHANGED, type UiMessage } from "@/hooks/useChat";
import type { WeatherReport } from "@/integrations/weather";
import { HudFrame } from "../HudFrame";
import { Icon } from "../icons";
import { PanelHead, WEATHER_ICON } from "../RightPanel";

export type ChatAgentStatus = "checking" | "online" | "offline";

/** 定期的に JSON を読む小さな道具（画面に戻ったとき・イベントでも読み直す） */
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

/* ---------- 天気（小） ---------- */

export function WeatherMini() {
  const res = useJson<{ ok: boolean; weather?: WeatherReport }>("/api/weather", [], 15 * 60_000);
  const w = res?.ok ? res.weather : undefined;
  const today = w?.days[0];
  return (
    <section className="panel hud hpanel hpanel--weather" title={w ? `${w.label}（体感 ${w.feelsLike}℃）` : undefined}>
      <HudFrame cut={12} ticks={false} />
      {w ? (
        <>
          <Icon name={WEATHER_ICON[w.kind]} size={34} className="hweather__icon" />
          <div className="hweather__temp">
            <b>{w.now}°</b>
            {today && <span>/ {today.lo}°</span>}
          </div>
          <div className="hweather__city">{w.city.toUpperCase()}</div>
          <div className="hweather__label">
            {w.label}
            {today ? ` · ☂${today.rain}%` : ""}
          </div>
        </>
      ) : (
        <div className="hweather__label">WEATHER —</div>
      )}
    </section>
  );
}

/* ---------- AI エージェント ---------- */

function agentState(def: AgentCardDef, chat: ChatAgentStatus, brain?: StatusResponse["brain"]): { state: string; label: string } {
  if (def.key === "vault" || def.key === "memai") {
    if (!brain?.configured) return { state: "soon", label: "NOT LINKED" };
    return brain.connected ? { state: "online", label: "ONLINE" } : { state: "offline", label: "OFFLINE" };
  }
  if (def.phase !== "live") return { state: "soon", label: "STANDBY" };
  return chat === "online" ? { state: "online", label: "ONLINE" } : chat === "checking" ? { state: "checking", label: "LINKING" } : { state: "offline", label: "OFFLINE" };
}

export function AgentsPanel({ chatStatus, brain, onOpenChat }: { chatStatus: ChatAgentStatus; brain?: StatusResponse["brain"]; onOpenChat: () => void }) {
  const rows = AGENT_CARDS.map((def, i) => ({ def, i, ...agentState(def, chatStatus, brain) }));
  const active = rows.filter((r) => r.state === "online").length;
  return (
    <section className="panel hud hpanel hpanel--agents">
      <HudFrame cut={14} leds />
      <PanelHead title="AI" accent="AGENTS" extra={<span className="hbadge">{active} ACTIVE</span>} idx="A1" />
      <ul className="hagents">
        {rows.map(({ def, i, state, label }) => (
          <li key={def.key}>
            <button type="button" className="hagent" data-state={state} onClick={def.phase === "live" ? onOpenChat : undefined} aria-disabled={def.phase !== "live"} title={def.tags.join(" / ")}>
              <span className="hagent__emblem">
                <svg viewBox="0 0 40 40" aria-hidden="true">
                  <path d="M20 2 L36 11 V29 L20 38 L4 29 V11 Z" className="hagent__hex" />
                  <circle cx="20" cy="20" r="17.5" className="hagent__ring" pathLength="100" />
                </svg>
                <Icon name={def.icon} size={14} strokeWidth={1.6} />
              </span>
              <span className="hagent__name">
                <b>{def.title}</b>
                <small>AGT-{String(i + 1).padStart(2, "0")}</small>
              </span>
              <span className="hagent__status">
                <i />
                {label}
              </span>
              <span className="hagent__role">{def.engine}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

/* ---------- 最近の活動（会話ログ） ---------- */

interface ActivityItem {
  day: "today" | "yesterday";
  time: string;
  text: string;
  voice: boolean;
}

export function ActivityPanel({ onOpenChat }: { onOpenChat: () => void }) {
  const data = useJson<{ configured: boolean; items: ActivityItem[] }>("/api/activity", [ACTIVITY_CHANGED], 60_000);
  const items = data?.items ?? [];
  return (
    <section className="panel hud hpanel hpanel--activity">
      <HudFrame cut={14} />
      <PanelHead
        title="RECENT"
        accent="ACTIVITY"
        extra={
          <button type="button" className="hlink" onClick={onOpenChat}>
            VIEW ALL →
          </button>
        }
        idx="A2"
      />
      {!data ? (
        <p className="hempty">読み込み中…</p>
      ) : !data.configured ? (
        <p className="hempty">脳（Obsidian）に接続すると、会話の記録がここに並びます。</p>
      ) : items.length === 0 ? (
        <p className="hempty">今日・昨日の会話はまだありません。話しかけると記録されます。</p>
      ) : (
        <ul className="hactivity">
          {items.map((a, i) => (
            <li key={`${a.day}-${a.time}-${i}`}>
              <span className="hactivity__dot" data-voice={a.voice || undefined} />
              <time>{a.day === "yesterday" ? `昨日 ${a.time}` : a.time}</time>
              <span className="hactivity__text">{a.text}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/* ---------- パフォーマンス（戦術モニター） ---------- */

export function PerformancePanel({ messages, brain }: { messages: UiMessage[]; brain?: StatusResponse["brain"] }) {
  const tasks = useJson<{ configured: boolean; todos: unknown[]; done?: unknown[] }>("/api/projects", [TASKS_CHANGED]);
  const times = useMemo(
    () => messages.filter((m) => m.role === "assistant" && typeof m.meta?.ttftMs === "number").map((m) => m.meta!.ttftMs!).slice(-24),
    [messages],
  );
  const avg = times.length ? times.reduce((a, b) => a + b, 0) / times.length / 1000 : null;
  const done = tasks?.done?.length ?? 0;
  const total = done + (tasks?.todos.length ?? 0);

  // 波形：応答時間の推移（2 回以上話したら）。それまでは待機の波
  const W = 220;
  const H = 54;
  const line =
    times.length >= 2
      ? (() => {
          const max = Math.max(...times, 1);
          return times.map((t, i) => `${((i / (times.length - 1)) * W).toFixed(1)},${(H - 6 - (t / max) * (H - 14)).toFixed(1)}`).join(" ");
        })()
      : null;
  return (
    <section className="panel hud hpanel hpanel--perf">
      <HudFrame cut={14} />
      <PanelHead title="PERFORMANCE" extra={<span className="hbadge">{line ? "LIVE" : "STANDBY"}</span>} idx="B1" />
      <div className="hmonitor" data-idle={!line || undefined}>
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
          {[0.25, 0.5, 0.75].map((y) => (
            <line key={y} x1="0" x2={W} y1={H * y} y2={H * y} className="hmonitor__grid" />
          ))}
          {Array.from({ length: 11 }, (_, i) => (
            <line key={i} x1={(W / 10) * i} x2={(W / 10) * i} y1="0" y2={H} className="hmonitor__grid" />
          ))}
          {line ? (
            <>
              <polyline points={`0,${H} ${line} ${W},${H}`} className="hmonitor__fill" />
              <polyline points={line} className="hmonitor__line" />
            </>
          ) : (
            <path className="hmonitor__idle" d={`M0 ${H / 2} ${Array.from({ length: 23 }, (_, i) => `Q${i * 10 + 5} ${H / 2 + (i % 2 ? 6 : -6)} ${(i + 1) * 10} ${H / 2}`).join(" ")}`} />
          )}
        </svg>
        <i className="hmonitor__sweep" />
      </div>
      <dl className="hstats">
        <div>
          <dt>TASKS COMPLETED</dt>
          <dd>{tasks?.configured ? `${done} / ${total}` : "—"}</dd>
        </div>
        <div>
          <dt>AVG. RESPONSE</dt>
          <dd>{avg !== null ? `${avg.toFixed(1)}s` : "—"}</dd>
        </div>
        <div>
          <dt>BRAIN NOTES</dt>
          <dd>{brain?.connected ? (brain.notes ?? 0) : "—"}</dd>
        </div>
      </dl>
    </section>
  );
}

/* ---------- ネットワーク（接続先サービスの衛星ネットワーク） ---------- */

const R = 58;
const LON0 = -170;
const LAT0 = 22;
const rad = Math.PI / 180;
function project(lat: number, lon: number): [number, number, boolean] {
  const la = lat * rad;
  const dl = (lon - LON0) * rad;
  const la0 = LAT0 * rad;
  const x = R * Math.cos(la) * Math.sin(dl);
  const y = -R * (Math.cos(la0) * Math.sin(la) - Math.sin(la0) * Math.cos(la) * Math.cos(dl));
  const visible = Math.sin(la0) * Math.sin(la) + Math.cos(la0) * Math.cos(la) * Math.cos(dl) > 0;
  return [70 + x, 70 + y, visible];
}
const GRATICULE = (() => {
  const paths: string[] = [];
  const draw = (pts: [number, number, boolean][]) => {
    let d = "";
    let pen = false;
    for (const [x, y, v] of pts) {
      if (!v) {
        pen = false;
        continue;
      }
      d += `${pen ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`;
      pen = true;
    }
    if (d) paths.push(d);
  };
  for (let lon = -180; lon < 180; lon += 20) draw(Array.from({ length: 37 }, (_, i) => project(-90 + i * 5, lon)));
  for (let lat = -60; lat <= 60; lat += 20) draw(Array.from({ length: 73 }, (_, i) => project(lat, -180 + i * 5)));
  return paths;
})();

export function NetworkPanel({ chatStatus, brain, calendar, search, tts }: { chatStatus: ChatAgentStatus; brain?: StatusResponse["brain"]; calendar?: StatusResponse["calendar"]; search?: StatusResponse["search"]; tts?: StatusResponse["tts"] }) {
  const home = project(35.7, 139.7);
  const links = [
    { name: "GEMINI", lat: 37.4, lon: -122.1, on: chatStatus === "online" },
    { name: "BRAIN", lat: 37.8, lon: -122.4 + 4, on: Boolean(brain?.connected) },
    { name: "CALENDAR", lat: 40.7, lon: -100, on: Boolean(calendar?.connected) },
    { name: "GMAIL", lat: 30, lon: -95, on: Boolean(calendar?.connected && calendar.gmail) },
    { name: "SEARCH", lat: 20, lon: -155, on: chatStatus === "online" && search !== "off" },
    { name: "VOICE", lat: 60, lon: 170, on: tts?.provider === "elevenlabs" },
  ];
  const online = links.filter((l) => l.on).length;
  return (
    <section className="panel hud hpanel hpanel--net">
      <HudFrame cut={14} />
      <PanelHead title="NETWORK" extra={<span className="hbadge">{online ? `${online}/${links.length} LINK` : "OFFLINE"}</span>} idx="B2" />
      <div className="hnet">
        <svg viewBox="0 0 140 140" className="hnet__globe" aria-hidden="true">
          <circle cx="70" cy="70" r={R} className="hnet__sphere" />
          {GRATICULE.map((d, i) => (
            <path key={i} d={d} className="hnet__grid" />
          ))}
          <circle cx="70" cy="70" r={R + 7} className="hnet__orbit" />
          {links.map((l) => {
            const [x, y, v] = project(l.lat, l.lon);
            if (!v) return null;
            const mx = (home[0] + x) / 2;
            const my = (home[1] + y) / 2;
            const cx = 70 + (mx - 70) * 1.55;
            const cy = 70 + (my - 70) * 1.55;
            return (
              <g key={l.name} data-on={l.on || undefined} className="hnet__link">
                <path d={`M${home[0].toFixed(1)} ${home[1].toFixed(1)}Q${cx.toFixed(1)} ${cy.toFixed(1)} ${x.toFixed(1)} ${y.toFixed(1)}`} />
                <circle cx={x} cy={y} r="2.2" />
              </g>
            );
          })}
          <circle cx={home[0]} cy={home[1]} r="3.4" className="hnet__home" />
          <circle cx={home[0]} cy={home[1]} r="3.4" className="hnet__ping" />
        </svg>
        <ul className="hnet__list">
          {links.map((l) => (
            <li key={l.name} data-on={l.on || undefined}>
              <i />
              {l.name}
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

/* ---------- ニューラルメモリ（脳のノート） ---------- */

const NEURONS = Array.from({ length: 34 }, (_, i) => {
  const a = i * 2.39996;
  const r = Math.sqrt((i + 0.5) / 34);
  return { x: 60 + Math.cos(a) * r * 46, y: 56 + Math.sin(a) * r * 40 * (1 - 0.15 * Math.sin(a)) };
});
const SYNAPSES = (() => {
  const out: [number, number][] = [];
  NEURONS.forEach((p, i) => {
    NEURONS.map((q, j) => ({ j, d: Math.hypot(p.x - q.x, p.y - q.y) }))
      .filter((e) => e.j > i)
      .sort((a, b) => a.d - b.d)
      .slice(0, 2)
      .forEach((e) => out.push([i, e.j]));
  });
  return out;
})();

export function NeuralPanel({ brain }: { brain?: StatusResponse["brain"] }) {
  const mem = useJson<{ entries?: unknown[]; indexed?: number }>(brain?.connected ? "/api/memory" : null);
  const lit = brain?.connected ? Math.min(NEURONS.length, 6 + Math.round((brain.notes ?? 0) / 3)) : 4;
  return (
    <section className="panel hud hpanel hpanel--neural">
      <HudFrame cut={14} />
      <PanelHead title="NEURAL" accent="MEMORY" idx="B4" />
      <svg viewBox="0 0 120 112" className="hneural" aria-hidden="true">
        {SYNAPSES.map(([a, b], i) => (
          <line key={i} x1={NEURONS[a].x} y1={NEURONS[a].y} x2={NEURONS[b].x} y2={NEURONS[b].y} className="hneural__syn" data-on={(a < lit && b < lit) || undefined} style={{ animationDelay: `${-(i % 9) * 0.4}s` }} />
        ))}
        {NEURONS.map((n, i) => (
          <circle key={i} cx={n.x} cy={n.y} r={i < lit ? 1.8 : 1.1} className="hneural__node" data-on={i < lit || undefined} style={{ animationDelay: `${-(i % 7) * 0.5}s` }} />
        ))}
      </svg>
      <dl className="hstats hstats--tight">
        <div>
          <dt>NOTES</dt>
          <dd>{brain?.connected ? (brain.notes ?? 0) : "—"}</dd>
        </div>
        <div>
          <dt>MEMORIES</dt>
          <dd>{brain?.connected && mem?.entries ? mem.entries.length : "—"}</dd>
        </div>
        <div>
          <dt>INDEXED</dt>
          <dd>{brain?.connected && mem?.indexed ? mem.indexed : "—"}</dd>
        </div>
      </dl>
      <p className="hquote">「明日の君を、もっと好きにさせる。」</p>
    </section>
  );
}

/* ---------- クイックアクション ---------- */

export type QuickKind = "chat" | "project" | "task" | "search";

export function QuickActionPanel({ onQuick }: { onQuick: (kind: QuickKind) => void }) {
  const main: { kind: QuickKind; label: string; icon: Parameters<typeof Icon>[0]["name"] }[] = [
    { kind: "chat", label: "NEW CHAT", icon: "chat" },
    { kind: "project", label: "NEW PROJECT", icon: "projects" },
    { kind: "task", label: "ADD TASK", icon: "tasks" },
    { kind: "search", label: "SEARCH", icon: "search" },
  ];
  return (
    <section className="panel hud hpanel hpanel--quick">
      <HudFrame cut={14} />
      <PanelHead title="QUICK" accent="ACTION" idx="B5" />
      <div className="hquick">
        {main.map((q) => (
          <button key={q.kind} type="button" className="hquick__main" onClick={() => onQuick(q.kind)}>
            <Icon name={q.icon} size={20} />
            <span>{q.label}</span>
          </button>
        ))}
      </div>
      <div className="hquick__links">
        {QUICK_ACCESS.map((q) =>
          "href" in q ? (
            <a key={q.label} href={q.href} target="_blank" rel="noreferrer noopener" title={q.label}>
              <Icon name={q.icon} size={15} />
            </a>
          ) : (
            <span key={q.label} className="is-disabled" title={`${q.label}（今後対応）`}>
              <Icon name={q.icon} size={15} />
            </span>
          ),
        )}
      </div>
    </section>
  );
}
