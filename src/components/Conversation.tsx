"use client";

/**
 * 会話ログ。F.R.I.D.A.Y. の返答はストリーミングで逐次表示される。
 */
import { memo, useEffect, useLayoutEffect, useRef } from "react";
import type { ChatPhase, UiMessage } from "@/hooks/useChat";
import type { VoiceState } from "@/hooks/useVoice";
import { Core } from "./Core";
import { HudFrame } from "./HudFrame";
import { Icon } from "./icons";
import { Markdown } from "./Markdown";

function time(ts: number) {
  return new Date(ts).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" });
}

const SUGGESTIONS = ["おはよう", "ちょっと相談がある", "大学受験どうしようかな", "この企画どう思う？"];

const Message = memo(function Message({
  msg,
  onRetry,
  canRetry,
}: {
  msg: UiMessage;
  onRetry: () => void;
  canRetry: boolean;
}) {
  if (msg.role === "user") {
    return (
      <div className="msg msg--user">
        <div className="msg__bubble hud">
          <HudFrame cut={10} small={4} ticks={false} />
          {msg.content}
        </div>
        <div className="msg__meta">{time(msg.createdAt)}</div>
      </div>
    );
  }

  const waiting = msg.status === "streaming" && !msg.content;
  return (
    <div className="msg msg--ai" data-status={msg.status}>
      <div className="msg__head">
        <span className="msg__name">F.R.I.D.A.Y.</span>
        <span className="msg__time">{time(msg.createdAt)}</span>
      </div>
      <div className="msg__panel hud">
        <HudFrame cut={14} />
        {waiting ? (
          <span className="signal" aria-label="応答を生成中">
            <i />
            <i />
            <i />
            <i />
          </span>
        ) : (
          <div className="md" data-streaming={msg.status === "streaming" || undefined}>
            <Markdown text={msg.content} />
          </div>
        )}

        {msg.status === "error" && msg.error && (
          <div className="msg__error" role="alert">
            <span className="msg__error-code">{msg.error.code}</span>
            <span>{msg.error.message}</span>
            {msg.error.retryable && canRetry && (
              <button type="button" className="ghost-btn" onClick={onRetry}>
                <Icon name="retry" size={14} /> 再試行
              </button>
            )}
          </div>
        )}
      </div>
      {(msg.status === "done" || msg.status === "stopped") && msg.meta && (
        <div className="msg__meta msg__meta--ai">
          {msg.status === "stopped" && <span>STOPPED · </span>}
          {msg.meta.model}
          {msg.meta.ttftMs !== undefined && <> · first token {(msg.meta.ttftMs / 1000).toFixed(2)}s</>}
          {msg.meta.totalMs !== undefined && <> · total {(msg.meta.totalMs / 1000).toFixed(1)}s</>}
        </div>
      )}
    </div>
  );
});

export function Conversation({
  messages,
  phase,
  onRetry,
  onSuggest,
  onBack,
  onClear,
  hidden,
  voiceState = "off",
}: {
  messages: UiMessage[];
  phase: ChatPhase;
  onRetry: () => void;
  onSuggest: (text: string) => void;
  onBack: () => void;
  onClear: () => void;
  hidden: boolean;
  voiceState?: VoiceState;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  // 新しいメッセージ・ストリーミング中は最下部に追従（ユーザーが遡っている時は追従しない）
  const last = messages[messages.length - 1];
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [messages.length, last?.content, last?.status]);

  useEffect(() => {
    if (last?.role === "user") stick.current = true;
  }, [last]);

  const lastIndex = messages.length - 1;

  return (
    <section className="conversation" aria-hidden={hidden} inert={hidden} aria-label="F.R.I.D.A.Y. との会話">
      <header className="conversation__bar">
        <button type="button" className="ghost-btn" onClick={onBack} title="HUB に戻る (Esc)">
          <Icon name="back" size={14} /> HUB
        </button>
        <div className="conversation__title">
          <Core phase={phase} compact />
          <div>
            <div className="conversation__name">CHAT AI</div>
            <div className="conversation__sub">
              {voiceState === "listening"
                ? "LISTENING…"
                : voiceState === "speaking"
                  ? "SPEAKING"
                  : phase === "waiting"
                    ? "LINKING…"
                    : phase === "streaming"
                      ? "RESPONDING"
                      : voiceState === "standby"
                        ? "「フライデー」で起動"
                        : "STANDBY"}
            </div>
          </div>
        </div>
        <button type="button" className="ghost-btn" onClick={onClear} disabled={!messages.length} title="新しい会話を始める">
          <Icon name="plus" size={14} /> NEW
        </button>
      </header>

      <div className="conversation__scroll" ref={scrollRef}>
        {messages.length === 0 ? (
          <div className="conversation__empty">
            <p className="conversation__hello">何でも話しかけてください。</p>
            <div className="suggestions">
              {SUGGESTIONS.map((s) => (
                <button key={s} type="button" className="chip" onClick={() => onSuggest(s)}>
                  {s}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="conversation__list" aria-live="polite">
            {messages.map((m, i) =>
              // 1 文字も出る前に止めた返答（割り込み・停止）は表示しない
              m.status === "error" && m.error?.code === "ABORTED" && !m.content ? null : (
                <Message key={m.id} msg={m} onRetry={onRetry} canRetry={i === lastIndex && phase === "idle"} />
              ),
            )}
          </div>
        )}
      </div>
    </section>
  );
}
