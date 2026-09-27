/**
 * HUB 表示: 中央の Core と、その周囲の Agent カード。
 * Phase 1 で実際に動くのは CHAT AI のみ。他は状態表示だけ。
 */
import { AGENT_CARDS, type AgentCardDef } from "@/data/agents";
import type { ChatPhase } from "@/hooks/useChat";
import { Core } from "./Core";
import { Icon } from "./icons";

export type ChatAgentStatus = "checking" | "online" | "offline";

const PHASE_LABEL: Record<AgentCardDef["phase"], string> = {
  live: "ONLINE",
  ready: "READY",
  soon: "COMING SOON",
};

function AgentCard({
  def,
  chatStatus,
  onOpenChat,
}: {
  def: AgentCardDef;
  chatStatus: ChatAgentStatus;
  onOpenChat: () => void;
}) {
  const live = def.phase === "live";
  const state = live ? chatStatus : def.phase;
  const label = live
    ? chatStatus === "online"
      ? "ONLINE"
      : chatStatus === "checking"
        ? "CONNECTING"
        : "OFFLINE"
    : PHASE_LABEL[def.phase];

  return (
    <button
      type="button"
      className="agent-card"
      data-state={state}
      data-live={live || undefined}
      style={{ left: `${def.pos.x}%`, top: `${def.pos.y}%` }}
      onClick={live ? onOpenChat : undefined}
      aria-disabled={!live}
      title={live ? "F.R.I.D.A.Y. と会話する" : "このエージェントは今後のアップデートで追加されます"}
    >
      <span className="agent-card__icon">
        <Icon name={def.icon} size={24} />
      </span>
      <span className="agent-card__body">
        <span className="agent-card__title">{def.title}</span>
        <span className="agent-card__engine">{def.engine}</span>
        <span className="agent-card__status">
          <i className="status-dot" />
          {label}
        </span>
      </span>
      <span className="agent-card__chev">
        <Icon name="chevron" size={16} />
      </span>
      <span className="agent-card__tags">{def.tags.join("  •  ")}</span>
    </button>
  );
}

export function Orbit({
  phase,
  chatStatus,
  onOpenChat,
  hidden,
}: {
  phase: ChatPhase;
  chatStatus: ChatAgentStatus;
  onOpenChat: () => void;
  hidden: boolean;
}) {
  return (
    <div className="orbit" aria-hidden={hidden} inert={hidden}>
      <svg className="orbit__links" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
        {AGENT_CARDS.map((c) => (
          <line
            key={c.key}
            x1="50"
            y1="50"
            x2={c.pos.x}
            y2={c.pos.y}
            className={c.phase === "live" ? "orbit__link orbit__link--live" : "orbit__link"}
            vectorEffect="non-scaling-stroke"
          />
        ))}
      </svg>
      <div className="orbit__core">
        <Core phase={phase} />
      </div>
      {AGENT_CARDS.map((c) => (
        <AgentCard key={c.key} def={c} chatStatus={chatStatus} onOpenChat={onOpenChat} />
      ))}
    </div>
  );
}
