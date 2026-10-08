import { memo } from "react";
import type { LastRunStats } from "@/hooks/useChat";
import type { ChatAgentStatus } from "./home/panels";
import { HudFrame } from "./HudFrame";
import { aiRouteLabel } from "./AiRouteBadge";
import { useAiRoute } from "@/lib/ai-router";
import { Icon, type IconName } from "./icons";

export type View = "home" | "chat" | "projects" | "memory" | "tasks" | "calendar" | "files" | "lecture" | "settings";

const NAV: { key: string; label: string; icon: IconName; view?: View }[] = [
  { key: "home", label: "HOME", icon: "home", view: "home" },
  { key: "chat", label: "CHAT", icon: "chat", view: "chat" },
  { key: "projects", label: "PROJECTS", icon: "projects", view: "projects" },
  { key: "memory", label: "MEMORY", icon: "memory", view: "memory" },
  { key: "tasks", label: "TASKS", icon: "tasks", view: "tasks" },
  { key: "calendar", label: "CALENDAR", icon: "calendar", view: "calendar" },
  { key: "files", label: "FILES", icon: "files", view: "files" },
  { key: "lecture", label: "LECTURE", icon: "lecture", view: "lecture" },
  { key: "settings", label: "SETTINGS", icon: "settings", view: "settings" },
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

export const Sidebar = memo(function Sidebar({
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
  const route = useAiRoute();
  // ローカル AI で答えられるときも「動いている」扱い（表示はオフライン用）
  const ok = chatStatus === "online" || route.route === "offline";
  const ttft = lastRun.ttftMs;
  const ctx = lastRun.contextMessages ?? 0;

  return (
    <aside className="sidebar">
      <nav className="nav" aria-label="メインメニュー">
        {NAV.map((n, i) => {
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
              <Icon name={n.icon} size={23} strokeWidth={1.5} />
              <span className="nav__label">{n.label}</span>
              <span className="nav__idx">{String(i + 1).padStart(2, "0")}</span>
              {!n.view && <span className="nav__soon">SOON</span>}
            </button>
          );
        })}
      </nav>
      {/* 手で操作（HAND）をオンにしたときのカメラ映像の置き場所（HandControl が描く） */}
      <div id="hand-slot" className="hand-slot" />

      <section className="panel sys-status hud">
        <HudFrame cut={16} leds />
        <div className="sys-status__head">
          <span className="sys-status__icon" data-ok={ok || undefined}>
            <Icon name="pulse" size={22} />
          </span>
          <div>
            <div className="sys-status__title">SYSTEM STATUS</div>
            <div className={`sys-status__state ${ok ? "is-ok" : chatStatus === "checking" ? "" : "is-warn"}`}>
              {route.route === "offline" || route.route === "switching" || route.route === "unavailable"
                ? aiRouteLabel(route).label
                : ok
                  ? "CHAT SYSTEM ONLINE"
                  : chatStatus === "checking"
                    ? "CHECKING…"
                    : "API KEY REQUIRED"}
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
});
