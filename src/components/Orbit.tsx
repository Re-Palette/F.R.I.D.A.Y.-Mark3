"use client";

/**
 * HUB 表示: 中央の Core、周囲の Agent カード、Core とカードを結ぶ回路配線、四隅の HUD 読み取り表示。
 * Phase 1 で実際に動くのは CHAT AI のみ。他は状態表示だけ。
 */
import { memo, useEffect, useLayoutEffect, useRef, useState } from "react";
import { AGENT_CARDS, type AgentCardDef } from "@/data/agents";
import type { ChatPhase } from "@/hooks/useChat";
import { Core } from "./Core";
import { HudFrame } from "./HudFrame";
import { Icon } from "./icons";

export type ChatAgentStatus = "checking" | "online" | "offline";

const PHASE_LABEL: Record<AgentCardDef["phase"], string> = {
  live: "ONLINE",
  ready: "READY",
  soon: "COMING SOON",
};

/* 状態ごとの信号レベル（5 段） */
const SIGNAL: Record<string, number> = { online: 5, checking: 2, offline: 0, ready: 3, soon: 1 };

function AgentCard({
  def,
  index,
  chatStatus,
  onOpenChat,
}: {
  def: AgentCardDef;
  index: number;
  chatStatus: ChatAgentStatus;
  onOpenChat: () => void;
}) {
  const live = def.phase === "live";
  const state = live ? chatStatus : def.phase;
  const label = live
    ? chatStatus === "online"
      ? "ONLINE"
      : chatStatus === "checking"
        ? "LINKING"
        : "OFFLINE"
    : PHASE_LABEL[def.phase];
  const level = SIGNAL[state] ?? 0;

  return (
    <button
      type="button"
      className="agent-card hud"
      data-state={state}
      data-live={live || undefined}
      data-slot={def.slot}
      onClick={live ? onOpenChat : undefined}
      aria-disabled={!live}
      title={live ? "F.R.I.D.A.Y. と会話する" : "このエージェントは今後のアップデートで追加されます"}
    >
      <HudFrame cut={16} leds={live} />
      <span className="agent-card__id">AGT-{String(index + 1).padStart(2, "0")}</span>
      <span className="agent-card__icon">
        <svg className="agent-card__hex" viewBox="0 0 60 60" aria-hidden="true">
          <path d="M30 2 L54 16 V44 L30 58 L6 44 V16 Z" />
          <path className="agent-card__hex-inner" d="M30 8 L49 19 V41 L30 52 L11 41 V19 Z" />
        </svg>
        <Icon name={def.icon} size={24} strokeWidth={1.5} />
      </span>
      <span className="agent-card__body">
        <span className="agent-card__title">{def.title}</span>
        <span className="agent-card__engine">{def.engine}</span>
        <span className="agent-card__status">
          <span className="agent-card__signal" aria-hidden="true">
            {[0, 1, 2, 3, 4].map((i) => (
              <i key={i} data-on={i < level || undefined} />
            ))}
          </span>
          {label}
        </span>
      </span>
      <span className="agent-card__chev">
        <Icon name="chevron" size={18} strokeWidth={1.8} />
      </span>
      <span className="agent-card__tags">{def.tags.join("  /  ")}</span>
    </button>
  );
}

interface Trace {
  key: string;
  d: string;
  live: boolean;
  end: [number, number];
  start: [number, number];
}

/** Core の外周から各カードの最寄りの辺へ、直角・45° で曲がる配線を計算する */
function useTraces(orbitRef: React.RefObject<HTMLDivElement | null>) {
  const [traces, setTraces] = useState<Trace[]>([]);
  const [box, setBox] = useState({ w: 0, h: 0 });

  useLayoutEffect(() => {
    const orbit = orbitRef.current;
    if (!orbit) return;

    const compute = () => {
      const core = orbit.querySelector<HTMLElement>(".orbit__core");
      if (!core || getComputedStyle(orbit).display === "grid") {
        setTraces([]);
        return;
      }
      const W = orbit.offsetWidth;
      const H = orbit.offsetHeight;
      const R = (core.offsetWidth / 2) * 0.99;
      const cx = W / 2;
      const cy = H / 2;
      const out: Trace[] = [];

      orbit.querySelectorAll<HTMLElement>(".agent-card").forEach((card) => {
        const slot = card.dataset.slot ?? "";
        const x = card.offsetLeft;
        const y = card.offsetTop;
        const w = card.offsetWidth;
        const h = card.offsetHeight;
        let pts: [number, number][] = [];

        if (slot === "top") pts = [[cx, cy - R], [cx, y + h]];
        else if (slot === "bottom") pts = [[cx, cy + R], [cx, y]];
        else if (slot === "ml") pts = [[cx - R, cy], [x + w, cy]];
        else if (slot === "mr") pts = [[cx + R, cy], [x, cy]];
        else {
          const left = slot === "tl" || slot === "bl";
          const up = slot === "tl" || slot === "tr";
          const sx = cx + (left ? -1 : 1) * R * Math.SQRT1_2;
          const sy = cy + (up ? -1 : 1) * R * Math.SQRT1_2;
          const tx = left ? x + w : x;
          const ty = up ? y + h * 0.72 : y + h * 0.28;
          const dx = Math.abs(tx - sx);
          const dy = Math.abs(ty - sy);
          const sgnx = left ? -1 : 1;
          const sgny = ty > sy ? 1 : -1;
          // 横に余裕があれば 45° → 水平、縦に長ければ 垂直 → 45° でカードへ入る
          pts =
            dx >= dy
              ? [[sx, sy], [sx + sgnx * dy, ty], [tx, ty]]
              : [[sx, sy], [sx, ty - sgny * dx], [tx, ty]];
        }

        out.push({
          key: slot,
          d: "M" + pts.map((p) => `${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(" L"),
          live: card.dataset.live !== undefined,
          start: pts[0],
          end: pts[pts.length - 1],
        });
      });

      setBox({ w: W, h: H });
      setTraces(out);
    };

    compute();
    const ro = new ResizeObserver(compute);
    ro.observe(orbit);
    return () => ro.disconnect();
  }, [orbitRef]);

  return { traces, box };
}

function pad(n: number) {
  return String(n).padStart(2, "0");
}

/** 四隅の HUD 読み取り表示（稼働時間などの実データ） */
function Readouts({
  model,
  context,
  onlineCount,
  voice,
}: {
  model?: string;
  context: string;
  onlineCount: number;
  voice: string;
}) {
  const [uptime, setUptime] = useState(0);
  useEffect(() => {
    const start = Date.now();
    const t = setInterval(() => setUptime(Math.floor((Date.now() - start) / 1000)), 1000);
    return () => clearInterval(t);
  }, []);

  return (
    <div className="readouts" aria-hidden="true">
      <div className="readout readout--tl">
        <b>SYS://FRIDAY.CORE</b>
        <span>BUILD MK-III · PHASE 01</span>
        <span>
          AGENTS <em>{onlineCount}</em>/{AGENT_CARDS.length} ONLINE
        </span>
        <span>LINK // {model ?? "—"}</span>
        <span>VOICE // {voice}</span>
      </div>
      <div className="readout readout--tr">
        <b>SESSION UPTIME</b>
        <span className="readout__big">
          {pad(Math.floor(uptime / 3600))}:{pad(Math.floor((uptime % 3600) / 60))}:{pad(uptime % 60)}
        </span>
      </div>
      <div className="readout readout--br">
        <b>CONTEXT WINDOW</b>
        <span>{context}</span>
      </div>
    </div>
  );
}

export const Orbit = memo(function Orbit({
  phase,
  chatStatus,
  onOpenChat,
  hidden,
  model,
  context,
  voice = "BROWSER",
}: {
  phase: ChatPhase;
  chatStatus: ChatAgentStatus;
  onOpenChat: () => void;
  hidden: boolean;
  model?: string;
  context: string;
  voice?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const { traces, box } = useTraces(ref);

  return (
    <div className="orbit" ref={ref} aria-hidden={hidden} inert={hidden}>
      {traces.length > 0 && (
        <svg className="orbit__traces" width={box.w} height={box.h} aria-hidden="true">
          {traces.map((t) => (
            <g key={t.key} data-live={t.live || undefined}>
              <path className="trace" d={t.d} />
              {t.live && <path className="trace trace--pulse" d={t.d} />}
              <circle className="trace__node" cx={t.start[0]} cy={t.start[1]} r="2.5" />
              <rect className="trace__end" x={t.end[0] - 3} y={t.end[1] - 3} width="6" height="6" />
            </g>
          ))}
        </svg>
      )}
      <Readouts model={model} context={context} onlineCount={chatStatus === "online" ? 1 : 0} voice={voice} />
      <div className="orbit__core">
        <Core phase={phase} />
      </div>
      {AGENT_CARDS.map((c, i) => (
        <AgentCard key={c.key} def={c} index={i} chatStatus={chatStatus} onOpenChat={onOpenChat} />
      ))}
    </div>
  );
});
