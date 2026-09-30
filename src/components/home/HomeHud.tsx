"use client";

/**
 * HOME — シンプルな AI アシスタント画面。
 *   中央：コア（リング）と呼びかけの案内／左：メーター・レーダー・システム状態／右：天気・エージェント一覧
 *   下：返事（RESPONSE）。入力欄はその下（Dashboard 側）。
 */
import { memo } from "react";
import type { StatusResponse } from "@/core/types";
import type { ChatPhase, LastRunStats, UiMessage } from "@/hooks/useChat";
import type { VoiceState } from "@/hooks/useVoice";
import { HandControl } from "../HandControl";
import { WeatherPanel } from "../RightPanel";
import { AgentRoster, Gauges, RadarLocal, ResponsePanel, SystemStatus, type ChatAgentStatus } from "./panels";
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
  chatStatus,
  onOpenChat,
  hidden,
  brain,
  calendar,
  voiceState,
  messages,
  lastRun,
  maxContext,
}: {
  phase: ChatPhase;
  chatStatus: ChatAgentStatus;
  onOpenChat: () => void;
  hidden: boolean;
  brain?: StatusResponse["brain"];
  calendar?: StatusResponse["calendar"];
  voiceState: VoiceState;
  messages: UiMessage[];
  lastRun: LastRunStats;
  maxContext: number;
}) {
  return (
    <div className="home" aria-hidden={hidden} inert={hidden}>
      <div className="home__left">
        <Gauges chatStatus={chatStatus} brain={brain} lastRun={lastRun} maxContext={maxContext} />
        <RadarLocal />
        <SystemStatus chatStatus={chatStatus} brain={brain} calendar={calendar} lastRun={lastRun} />
      </div>

      <div className="home__core">
        <Reactor phase={phase} speaking={voiceState === "speaking"} active={!hidden} />
        <p className="home__hint" data-voice={voiceState}>
          {HINT[voiceState]}
        </p>
        <HandControl hidden={hidden} />
      </div>

      <div className="home__right">
        <WeatherPanel />
        <AgentRoster chatStatus={chatStatus} brain={brain} onOpenChat={onOpenChat} />
      </div>

      <div className="home__response">
        <ResponsePanel messages={messages} voiceState={voiceState} onOpenChat={onOpenChat} />
      </div>
    </div>
  );
});
