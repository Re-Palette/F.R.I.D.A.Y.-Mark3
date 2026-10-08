"use client";

/**
 * HOME — ミニマルな HUD。主役は中央の F.R.I.D.A.Y. CORE。
 *   上：タブ（AGENTS / NOTES / TASKS / CONTEXT）
 *   左：SYSTEM STATUS・CURRENT MODE・接続の短いバー・現在地／右：レーダー・VOICE ACTIVITY・NOTIFICATIONS
 *   下：ACTIVITY LIVE。返事（検索の要約と関連ページ）は、話しかけたときだけ下に HUD パネルで開く。
 * スマホ：スクロールなしの 1 画面。上に天気・次の予定・今日やること、真ん中にコア（タップで起動して話せる）、
 *   その下に一言の案内。返事はコアの下側に重ねて開く。
 */
import { memo, useCallback, useEffect, useState } from "react";
import type { StatusResponse } from "@/core/types";
import type { ChatPhase, ChatStage, LastRunStats, UiMessage } from "@/hooks/useChat";
import { PHONE_QUERY, useMedia } from "@/hooks/useMedia";
import { skipWhileHidden } from "@/lib/memo-hidden";
import type { VoiceState } from "@/hooks/useVoice";
import { HandControl } from "../HandControl";
import type { View } from "../Sidebar";
import { AgentRoster, Radar, ResponsePanel, type ChatAgentStatus } from "./panels";
import { MobileBrief } from "./MobileBrief";
import { coreMode, Reactor } from "./Reactor";
import { ActivityLive, CurrentMode, LinkBars, LocationMark, Notifications, SystemBars, TopTabs, VoiceActivity, type HomeTab } from "./readouts";

const HINT: Record<VoiceState, string> = {
  off: "下の入力欄から話しかけてください",
  standby: "「フライデー」と呼んでください",
  listening: "どうぞ、話してください…",
  thinking: "考えています…",
  speaking: "話しかければ割り込めます",
};

/** スマホ：コアの下の一言 */
const PHONE_HINT: Record<VoiceState, string> = {
  off: "コアをタップして起動",
  standby: "コアをタップして話しかけてください",
  listening: "どうぞ、話してください…",
  thinking: "考えています…",
  speaking: "タップで止めて話せます",
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
  onWake,
  onVoiceOff,
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
  /** スマホでコアをタップしたとき（呼びかけと同じ） */
  onWake?: () => void;
  /** スマホで VOICE MODE を切る */
  onVoiceOff?: () => void;
}) {
  const phone = useMedia(PHONE_QUERY);
  const mode = coreMode(phase, stage, voiceState);
  // 描画が追いつかない端末では、輪の回転などを止めて軽くする（コアが知らせる）
  const [lite, setLite] = useState(false);
  const onSlow = useCallback(() => setLite(true), []);

  // 返事のパネル：話しかけたら開き、× で閉じる（次に話しかけるとまた開く）
  const lastQuestion = [...messages].reverse().find((m) => m.role === "user")?.id;
  const [closedFor, setClosedFor] = useState<string | undefined>();
  // 声で話したときは、話した内容・返事の字幕を HOME に出さない（読み上げだけ。会話は CHAT に残る）。
  // ただし資料・PDF・スライドを作ったときは、ダウンロードできるように出す
  const lastReply = [...messages].reverse().find((m) => m.role === "assistant");
  const voiceTurn = Boolean(lastReply?.voice) && !lastReply?.documents?.some((d) => d.ok);
  const showResponse = Boolean(lastQuestion) && closedFor !== lastQuestion && !voiceTurn;

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
  const onTab = useCallback(
    (t: HomeTab) => {
      if (t === "agents") return setTab((cur) => (cur === "agents" ? null : "agents"));
      setTab(null);
      if (t === "notes") onNavigate("memory");
      else if (t === "tasks") onNavigate("tasks");
      else onOpenChat();
    },
    [onNavigate, onOpenChat],
  );

  if (phone) {
    return (
      <div className="home home--phone" data-mode={mode} data-lite={lite || undefined} data-response={showResponse || undefined} aria-hidden={hidden} inert={hidden}>
        <MobileBrief onNavigate={onNavigate} />
        <div className="home__core">
          <button type="button" className="core-rig core-tap" onClick={onWake} aria-label={voiceState === "off" ? "F.R.I.D.A.Y. を起動" : "F.R.I.D.A.Y. に話しかける"}>
            <Reactor phase={phase} stage={stage} voiceState={voiceState} active={!hidden} onSlow={onSlow} />
          </button>
          {showResponse && (
            <div className="home__bottom">
              <ResponsePanel
                messages={messages}
                phase={phase}
                voiceState={voiceState}
                lastRun={lastRun}
                onOpenChat={onOpenChat}
                onClose={() => setClosedFor(lastQuestion)}
              />
            </div>
          )}
        </div>
        <div className="home__hint" data-voice={voiceState}>
          <span>{PHONE_HINT[voiceState]}</span>
          {voiceState !== "off" && (
            <button type="button" className="home__off" onClick={onVoiceOff}>
              OFF
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="home" data-mode={mode} data-lite={lite || undefined} data-response={showResponse || undefined} aria-hidden={hidden} inert={hidden}>
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
        <LinkBars chatStatus={chatStatus} phase={phase} brain={brain} calendar={calendar} voiceState={voiceState} lastRun={lastRun} maxContext={maxContext} />
      </div>

      <div className="home__loc">
        <LocationMark />
      </div>

      <div className="home__core">
        <div className="core-rig">
          <Reactor phase={phase} stage={stage} voiceState={voiceState} active={!hidden} onSlow={onSlow} />
        </div>
        <HandControl hidden={hidden} />
      </div>

      <div className="home__right">
        <Radar />
        <VoiceActivity state={voiceState} />
        <Notifications news={news} />
        <div className="hdeco" aria-hidden="true">
          <i />
          <i />
          <i />
          <i />
        </div>
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
          <ActivityLive messages={messages} phase={phase} mode={mode} lastRun={lastRun} maxContext={maxContext} />
        )}
      </div>
    </div>
  );
}, skipWhileHidden);
