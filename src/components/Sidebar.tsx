import type { LastRunStats } from "@/hooks/useChat";
import type { ChatAgentStatus } from "./Orbit";
import { Icon, type IconName } from "./icons";

export type View = "home" | "chat";

const NAV: { key: string; label: string; icon: IconName; view?: View }[] = [
  { key: "home", label: "HOME", icon: "home", view: "home" },
  { key: "chat", label: "CHAT", icon: "chat", view: "chat" },
  { key: "projects", label: "PROJECTS", icon: "projects" },
  { key: "memory", label: "MEMORY", icon: "memory" },
  { key: "tasks", label: "TASKS", icon: "tasks" },
  { key: "calendar", label: "CALENDAR", icon: "calendar" },
  { key: "files", label: "FILES", icon: "files" },
  { key: "settings", label: "SETTINGS", icon: "settings" },
];

function Meter({ label, value, ratio }: { label: string; value: string; ratio: number }) {
  return (
    <div className="meter">
      <span className="meter__label">{label}</span>
      <span className="meter__bar">
        <span style={{ transform: `scaleX(${Math.max(0.02, Math.min(1, ratio))})` }} />
      </span>
      <span className="meter__value">{value}</span>
    </div>
  );
}

export function Sidebar({
  view,
  onNavigate,
  chatStatus,
  model,
  lastRun,
  sessionCount,
  maxContext,
}: {
  view: View;
  onNavigate: (v: View) => void;
  chatStatus: ChatAgentStatus;
  model?: string;
  lastRun: LastRunStats;
  sessionCount: number;
  maxContext: number;
}) {
  const ok = chatStatus === "online";
  const ttft = lastRun.ttftMs;
  const ctx = lastRun.contextMessages ?? 0;

  return (
    <aside className="sidebar">
      <nav className="nav" aria-label="メインメニュー">
        {NAV.map((n) => {
          const active = n.view === view;
          return (
            <button
              key={n.key}
              type="button"
              className="nav__item"
              data-active={active || undefined}
              aria-current={active ? "page" : undefined}
              aria-disabled={!n.view}
              onClick={n.view ? () => onNavigate(n.view!) : undefined}
              title={n.view ? n.label : `${n.label}（今後対応）`}
            >
              <Icon name={n.icon} size={20} />
              <span className="nav__label">{n.label}</span>
              {!n.view && <span className="nav__soon">SOON</span>}
            </button>
          );
        })}
      </nav>

      <section className="panel sys-status">
        <div className="sys-status__head">
          <span className="sys-status__icon" data-ok={ok || undefined}>
            <Icon name="pulse" size={22} />
          </span>
          <div>
            <div className="sys-status__title">SYSTEM STATUS</div>
            <div className={`sys-status__state ${ok ? "is-ok" : chatStatus === "checking" ? "" : "is-warn"}`}>
              {ok ? "CHAT AGENT ONLINE" : chatStatus === "checking" ? "CHECKING…" : "API KEY REQUIRED"}
            </div>
          </div>
        </div>
        <div className="meters">
          <Meter label="LATENCY" value={ttft !== undefined ? `${(ttft / 1000).toFixed(2)}s` : "—"} ratio={ttft ? ttft / 3000 : 0} />
          <Meter label="CONTEXT" value={`${ctx}/${maxContext}`} ratio={ctx / maxContext} />
          <Meter label="SESSION" value={`${sessionCount}`} ratio={sessionCount / 50} />
          <div className="sys-status__model" title={model}>
            MODEL <b>{model ?? "—"}</b>
          </div>
        </div>
      </section>

      <div className="signature" aria-hidden="true">
        F.R.I.D.A.Y. <span>Mark3</span>
      </div>
    </aside>
  );
}
