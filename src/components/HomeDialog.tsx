"use client";

/**
 * HOME のまま会話するときの表示。中央下に、最新の発言と F.R.I.D.A.Y. の返答を字幕のように出す。
 * 会話中は表示し続け、終わってしばらくすると自動で隠れる（全文は CHAT で見られる）。
 */
import { memo, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ChatPhase, UiMessage } from "@/hooks/useChat";
import type { VoiceState } from "@/hooks/useVoice";
import { HudFrame } from "./HudFrame";
import { Icon } from "./icons";
import { Markdown } from "./Markdown";

/** 会話が終わってから隠れるまで */
const LINGER_MS = 20_000;

export const HomeDialog = memo(function HomeDialog({
  messages,
  phase,
  voiceState,
  hidden,
  onOpenChat,
}: {
  messages: UiMessage[];
  phase: ChatPhase;
  voiceState: VoiceState;
  hidden: boolean;
  onOpenChat: () => void;
}) {
  const last = messages[messages.length - 1];
  const reply = last?.role === "assistant" ? last : undefined;
  const question = [...messages].reverse().find((m) => m.role === "user");
  const busy = phase !== "idle" || voiceState === "thinking" || voiceState === "speaking";

  // 会話中は表示。終わったら LINGER_MS 後に隠す（新しいやり取りが来たらまた表示）
  const [visible, setVisible] = useState(false);
  const key = `${last?.id}:${last?.content.length}:${last?.status}`;
  useEffect(() => {
    if (!last) {
      setVisible(false);
      return;
    }
    setVisible(true);
    if (busy) return;
    const t = setTimeout(() => setVisible(false), LINGER_MS);
    return () => clearTimeout(t);
  }, [key, busy]); // eslint-disable-line react-hooks/exhaustive-deps

  // 返答が伸びたら最下部に追従
  const bodyRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [reply?.content]);

  const aborted = reply?.status === "error" && reply.error?.code === "ABORTED" && !reply.content;
  const show = visible && !hidden && !!question && !aborted;
  const waiting = !reply || (reply.status === "streaming" && !reply.content);

  return (
    <section className="home-dialog hud" data-show={show || undefined} aria-hidden={!show} aria-live="polite">
      <HudFrame cut={14} small={6} />
      <header className="home-dialog__head">
        <span className="home-dialog__you" title={question?.content}>
          <b>YOU</b> {question?.content}
        </span>
        <button type="button" className="home-dialog__btn" onClick={onOpenChat} title="CHAT で会話全体を見る" tabIndex={show ? 0 : -1}>
          CHAT <Icon name="chevron" size={12} />
        </button>
        <button
          type="button"
          className="home-dialog__btn"
          onClick={() => setVisible(false)}
          title="閉じる"
          aria-label="閉じる"
          tabIndex={show ? 0 : -1}
        >
          ×
        </button>
      </header>
      <div className="home-dialog__body md" ref={bodyRef} data-streaming={reply?.status === "streaming" || undefined}>
        <b className="home-dialog__name">F.R.I.D.A.Y.</b>
        {waiting ? (
          <span className="signal" aria-label="応答を生成中">
            <i />
            <i />
            <i />
            <i />
          </span>
        ) : reply?.status === "error" && !reply.content ? (
          <p className="home-dialog__error">{reply.error?.message}</p>
        ) : (
          <Markdown text={reply?.content ?? ""} />
        )}
      </div>
    </section>
  );
});
