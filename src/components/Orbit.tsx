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
      data-slot={def.slot}
      onClick={live ? onOpenChat : undefined}
      aria-disabled={!live}
      title={live ? "F.R.I.D.A.Y. と会話する" : "このエージェントは今後のアップデートで追加されます"}
    >
      <span className="agent-card__icon">
        <Icon name={def.icon} size={28} strokeWidth={1.4} />
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
        <Icon name="chevron" size={20} strokeWidth={1.8} />
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
      <div className="orbit__core">
        <Core phase={phase} />
      </div>
      {AGENT_CARDS.map((c) => (
        <AgentCard key={c.key} def={c} chatStatus={chatStatus} onOpenChat={onOpenChat} />
      ))}
    </div>
  );
}
