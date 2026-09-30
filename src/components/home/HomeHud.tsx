"use client";

/**
 * HOME — ミニマルな HUD。主役は中央の F.R.I.D.A.Y. CORE。
 *   上：タブ（AGENTS / NOTES / TASKS / CONTEXT）
 *   左：SYSTEM STATUS・CURRENT MODE・接続の短いバー・現在地／右：レーダー・VOICE ACTIVITY・NOTIFICATIONS
 *   下：ACTIVITY LIVE。返事（検索の要約と関連ページ）は、話しかけたときだけ下に HUD パネルで開く。
 */
import { memo, useEffect, useState } from "react";
import type { StatusResponse } from "@/core/types";
import type { ChatPhase, ChatStage, LastRunStats, UiMessage } from "@/hooks/useChat";
import type { VoiceState } from "@/hooks/useVoice";
import { HandControl } from "../HandControl";
import type { View } from "../Sidebar";
import { AgentRoster, Radar, ResponsePanel, type ChatAgentStatus } from "./panels";
import { coreMode, Reactor } from "./Reactor";
import { ActivityLive, CurrentMode, LinkBars, LocationMark, Notifications, SystemBars, TopTabs, VoiceActivity, type HomeTab } from "./readouts";

const HINT: Record<VoiceState, string> = {
  off: "下の入力欄から話しかけてください",
  standby: "「フライデー」と呼んでください",
  listening: "どうぞ、話してください…",
  thinking: "考えています…",
  speaking: "話しかければ割り込めます",
};

export const HomeHud = memo(function HomeHud({
  phase,
  stage,
  chatStatus,
  onOpenChat,
  onNavigate,
  hidden,
  brain,
  calendar,
  automation,
  news,
  voiceState,
  messages,
  lastRun,
  maxContext,
}: {
  phase: ChatPhase;
  stage: ChatStage;
  chatStatus: ChatAgentStatus;
  onOpenChat: () => void;
  onNavigate: (v: View) => void;
  hidden: boolean;
  brain?: StatusResponse["brain"];
  calendar?: StatusResponse["calendar"];
  automation?: StatusResponse["automation"];
  news?: StatusResponse["news"];
  voiceState: VoiceState;
  messages: UiMessage[];
  lastRun: LastRunStats;
  maxContext: number;
}) {
  const mode = coreMode(phase, stage, voiceState);

  // 返事のパネル：話しかけたら開き、× で閉じる（次に話しかけるとまた開く）
  const lastQuestion = [...messages].reverse().find((m) => m.role === "user")?.id;
  const [closedFor, setClosedFor] = useState<string | undefined>();
  const showResponse = Boolean(lastQuestion) && closedFor !== lastQuestion;

  // AGENTS のタブは一覧を HUD の小窓で開く（ほかのタブはそれぞれの画面へ）
  const [tab, setTab] = useState<HomeTab | null>(null);
  useEffect(() => {
    if (!tab) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setTab(null);
    const onDown = (e: PointerEvent) => {
      if (!(e.target as Element).closest?.(".home__top")) setTab(null);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onDown);
    };
  }, [tab]);
  const onTab = (t: HomeTab) => {
    if (t === "agents") return setTab((cur) => (cur === "agents" ? null : "agents"));
    setTab(null);
    if (t === "notes") onNavigate("memory");
    else if (t === "tasks") onNavigate("tasks");
    else onOpenChat();
  };

  return (
    <div className="home" data-mode={mode} data-response={showResponse || undefined} aria-hidden={hidden} inert={hidden}>
      <div className="home__top">
        <TopTabs chatStatus={chatStatus} brain={brain} lastRun={lastRun} maxContext={maxContext} open={tab} onTab={onTab} />
        {tab === "agents" && (
          <div className="hpop" role="dialog" aria-label="エージェント一覧">
            <AgentRoster chatStatus={chatStatus} phase={phase} stage={stage} brain={brain} automation={automation} onOpenChat={onOpenChat} />
          </div>
        )}
      </div>

      <div className="home__left">
        <SystemBars active={!hidden} />
        <CurrentMode mode={mode} hint={HINT[voiceState]} />
        <LinkBars chatStatus={chatStatus} phase={phase} brain={brain} calendar={calendar} lastRun={lastRun} />
        <LocationMark />
      </div>

      <div className="home__core">
        <div className="core-rig">
          <Reactor phase={phase} stage={stage} voiceState={voiceState} active={!hidden} />
        </div>
        <HandControl hidden={hidden} />
      </div>

      <div className="home__right">
        <Radar />
        <VoiceActivity state={voiceState} />
        <Notifications news={news} />
      </div>

      <div className="home__bottom">
        {showResponse ? (
          <ResponsePanel
            messages={messages}
            phase={phase}
            voiceState={voiceState}
            lastRun={lastRun}
            onOpenChat={onOpenChat}
            onClose={() => setClosedFor(lastQuestion)}
          />
        ) : (
          <ActivityLive messages={messages} phase={phase} />
        )}
      </div>
    </div>
  );
});
