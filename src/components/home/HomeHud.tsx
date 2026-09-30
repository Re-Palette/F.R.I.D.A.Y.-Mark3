"use client";

/**
 * HOME — F.R.I.D.A.Y. Personal AI Command Center。
 *   中央：F.R.I.D.A.Y. CORE と、その周りの処理ノード（THINK / CONNECT / SEARCH / CREATE）、呼びかけの案内
 *   左：メーター・レーダー・システム状態／右：天気・エージェント一覧・INCOMING
 *   下：返事（RESPONSE）。入力欄はその下（Dashboard 側）。
 */
import { memo } from "react";
import type { StatusResponse } from "@/core/types";
import type { ChatPhase, ChatStage, LastRunStats, UiMessage } from "@/hooks/useChat";
import type { VoiceState } from "@/hooks/useVoice";
import { HandControl } from "../HandControl";
import { WeatherPanel } from "../RightPanel";
import {
  activeProcess,
  AgentRoster,
  Gauges,
  IncomingPanel,
  PROCESS_NODES,
  ProcessNode,
  RadarLocal,
  ResponsePanel,
  SystemStatus,
  type ChatAgentStatus,
} from "./panels";
import { Reactor } from "./Reactor";

const HINT: Record<VoiceState, string> = {
  off: "下の入力欄から話しかけてください（音声は VOICE MODE）",
  standby: "「フライデー」と呼んでください",
  listening: "どうぞ、話してください…",
  thinking: "考えています…",
  speaking: "話しています…（話しかければ割り込めます）",
};

export const HomeHud = memo(function HomeHud({
  phase,
  stage,
  chatStatus,
  onOpenChat,
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
  const process = activeProcess(phase, stage);
  const [think, connect, search, create] = PROCESS_NODES;
  return (
    <div className="home" aria-hidden={hidden} inert={hidden}>
      <div className="home__left">
        <Gauges chatStatus={chatStatus} brain={brain} lastRun={lastRun} maxContext={maxContext} />
        <RadarLocal />
        <SystemStatus chatStatus={chatStatus} phase={phase} brain={brain} calendar={calendar} lastRun={lastRun} />
      </div>

      <div className="home__core">
        <div className="core-rig">
          <Reactor phase={phase} stage={stage} voiceState={voiceState} active={!hidden} />
          <div className="core-rig__nodes">
            <ProcessNode node={think} side="left" active={process === "think"} />
            <ProcessNode node={connect} side="right" active={process === "connect"} />
            <ProcessNode node={search} side="left" active={process === "search"} />
            <ProcessNode node={create} side="right" active={process === "create"} />
          </div>
        </div>
        <p className="home__hint" data-voice={voiceState}>
          {HINT[voiceState]}
        </p>
        <HandControl hidden={hidden} />
      </div>

      <div className="home__right">
        <WeatherPanel />
        <AgentRoster chatStatus={chatStatus} phase={phase} stage={stage} brain={brain} automation={automation} onOpenChat={onOpenChat} />
        <IncomingPanel news={news} />
      </div>

      <div className="home__response">
        <ResponsePanel messages={messages} phase={phase} voiceState={voiceState} lastRun={lastRun} onOpenChat={onOpenChat} />
      </div>
    </div>
  );
});
