"use client";

/**
 * HOME — AI OS の司令画面。中央に AI コア、左に予定・天気／AI エージェント／最近の活動、
 * 右にパフォーマンス／ネットワーク／プロジェクト／ニューラルメモリ／クイックアクション。
 * コアから各パネルへ、データが流れる接続線を引く。
 */
import { memo, useLayoutEffect, useRef, useState } from "react";
import type { StatusResponse } from "@/core/types";
import type { ChatPhase, UiMessage } from "@/hooks/useChat";
import { HandControl } from "../HandControl";
import { ProjectsPanel, SchedulePanel } from "../RightPanel";
import { AiCore } from "./AiCore";
import {
  ActivityPanel,
  AgentsPanel,
  NetworkPanel,
  NeuralPanel,
  PerformancePanel,
  QuickActionPanel,
  WeatherMini,
  type ChatAgentStatus,
  type QuickKind,
} from "./panels";

interface Link {
  d: string;
  key: string;
}

/** コアの縁から各パネルの内側の辺へ、ゆるい曲線の接続線を引く */
function useLinks(ref: React.RefObject<HTMLDivElement | null>) {
  const [links, setLinks] = useState<{ list: Link[]; w: number; h: number }>({ list: [], w: 0, h: 0 });
  useLayoutEffect(() => {
    const box = ref.current;
    if (!box) return;
    const measure = () => {
      const core = box.querySelector<HTMLElement>(".aicore");
      if (!core || getComputedStyle(box).display !== "grid" || box.dataset.narrow) {
        setLinks({ list: [], w: 0, h: 0 });
        return;
      }
      const b = box.getBoundingClientRect();
      const zoom = b.width / box.offsetWidth || 1; // 画面全体の縮小（CSS zoom）を打ち消す
      const c = core.getBoundingClientRect();
      const cx = (c.left + c.width / 2 - b.left) / zoom;
      const cy = (c.top + c.height / 2 - b.top) / zoom;
      const r = (Math.min(c.width, c.height) / 2 / zoom) * 0.92;
      const list: Link[] = [];
      box.querySelectorAll<HTMLElement>("[data-link]").forEach((el) => {
        const p = el.getBoundingClientRect();
        const left = (p.left - b.left) / zoom;
        const right = (p.right - b.left) / zoom;
        const midY = (p.top + p.height / 2 - b.top) / zoom;
        const toRight = left > cx;
        const ex = toRight ? left : right;
        const ey = Math.max((p.top - b.top) / zoom + 18, Math.min((p.bottom - b.top) / zoom - 18, midY));
        const ang = Math.atan2(ey - cy, ex - cx);
        const sx = cx + Math.cos(ang) * r;
        const sy = cy + Math.sin(ang) * r;
        const k = (ex - sx) * 0.55;
        list.push({ key: el.dataset.link!, d: `M${sx.toFixed(1)} ${sy.toFixed(1)} C${(sx + k).toFixed(1)} ${sy.toFixed(1)} ${(ex - k).toFixed(1)} ${ey.toFixed(1)} ${ex.toFixed(1)} ${ey.toFixed(1)}` });
      });
      setLinks({ list, w: box.offsetWidth, h: box.offsetHeight });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(box);
    window.addEventListener("resize", measure);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [ref]);
  return links;
}

export const HomeHud = memo(function HomeHud({
  phase,
  chatStatus,
  onOpenChat,
  onQuick,
  hidden,
  narrow,
  brain,
  calendar,
  tts,
  speaking,
  messages,
}: {
  phase: ChatPhase;
  chatStatus: ChatAgentStatus;
  onOpenChat: () => void;
  onQuick: (kind: QuickKind) => void;
  hidden: boolean;
  narrow: boolean;
  brain?: StatusResponse["brain"];
  calendar?: StatusResponse["calendar"];
  tts?: StatusResponse["tts"];
  speaking: boolean;
  messages: UiMessage[];
}) {
  const ref = useRef<HTMLDivElement>(null);
  const links = useLinks(ref);
  const coreStatus = chatStatus === "online" ? (phase === "idle" ? "SYSTEM ONLINE" : "PROCESSING") : chatStatus === "checking" ? "LINKING" : "OFFLINE";

  return (
    <div className="home" ref={ref} aria-hidden={hidden} inert={hidden} data-narrow={narrow || undefined}>
      {links.list.length > 0 && (
        <svg className="home__links" width={links.w} height={links.h} aria-hidden="true">
          {links.list.map((l) => (
            <g key={l.key}>
              <path d={l.d} className="home__link" />
              <path d={l.d} className="home__flow" />
            </g>
          ))}
        </svg>
      )}

      <div className="home__left">
        <div className="home__row" data-link="schedule">
          <SchedulePanel gmail={calendar?.connected ? calendar.gmail : undefined} />
          <WeatherMini />
        </div>
        <div data-link="agents" className="home__grow">
          <AgentsPanel chatStatus={chatStatus} brain={brain} onOpenChat={onOpenChat} />
        </div>
        <div data-link="activity">
          <ActivityPanel onOpenChat={onOpenChat} />
        </div>
      </div>

      <div className="home__core">
        <AiCore phase={phase} speaking={speaking} active={!hidden} status={coreStatus} />
        <HandControl hidden={hidden} />
      </div>

      <div className="home__right">
        <div className="home__row" data-link="perf">
          <PerformancePanel messages={messages} brain={brain} />
          <NetworkPanel chatStatus={chatStatus} brain={brain} calendar={calendar} tts={tts} />
        </div>
        <div className="home__row home__grow" data-link="projects">
          <ProjectsPanel title="ACTIVE" accent="PROJECTS" idx="B3" />
          <NeuralPanel brain={brain} />
        </div>
        <div data-link="quick">
          <QuickActionPanel onQuick={onQuick} />
        </div>
      </div>
    </div>
  );
});
