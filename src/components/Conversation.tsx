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

import type { ActionKind } from "@/core/types";

const ACTION_LABEL = {
  "todo-add": ["TODO ADDED", "tasks"],
  "todo-done": ["TODO DONE", "tasks"],
  "project-progress": ["PROGRESS", "analysis"],
  reminder: ["REMINDER SET", "memory"],
  "company-instruct": ["COMPANY TASKED", "automation"],
  "company-advance": ["COMPANY WORKING", "automation"],
} as const satisfies Record<ActionKind, readonly [string, string]>;

const CALENDAR_LABEL = { add: "CALENDAR ADDED", update: "CALENDAR UPDATED", delete: "CALENDAR DELETED" } as const;

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
        {msg.image && (
          // eslint-disable-next-line @next/next/no-img-element
          <img className="msg__image" src={msg.image} alt="カメラで見せた映像" />
        )}
        {msg.files && msg.files.length > 0 && (
          <div className="msg__files" aria-label="添付したファイル">
            {msg.files.map((f, i) => (
              <span key={`${f.name}-${i}`} className="attach attach--sent">
                {f.thumb ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={f.thumb} alt="" />
                ) : (
                  <Icon name={f.kind === "image" ? "image" : f.kind === "sheet" ? "analysis" : "doc"} size={14} />
                )}
                <span className="attach__name">{f.name}</span>
              </span>
            ))}
          </div>
        )}
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
      {msg.calendar && msg.calendar.length > 0 && (
        <ul className="msg__memories" aria-label="カレンダーに追加した予定">
          {msg.calendar.map((c, i) => (
            <li
              key={`${c.title}-${i}`}
              className="memory-chip memory-chip--calendar"
              data-failed={!c.ok || undefined}
              title={c.ok ? "Google カレンダーを更新しました" : c.error}
            >
              <Icon name="calendar" size={12} /> <span>{c.ok ? CALENDAR_LABEL[c.action] : "CALENDAR FAILED"}</span> {c.when}{" "}
              {c.title}
            </li>
          ))}
        </ul>
      )}
      {msg.music && msg.music.length > 0 && (
        <ul className="msg__memories" aria-label="音楽の操作">
          {msg.music.map((m, i) => (
            <li key={`${m.label}-${i}`} className="memory-chip memory-chip--music" data-failed={!m.ok || undefined} title={m.error}>
              <Icon name="music" size={12} /> <span>{m.ok ? "MUSIC" : "MUSIC FAILED"}</span> {m.label}
            </li>
          ))}
        </ul>
      )}
      {msg.drafts && msg.drafts.length > 0 && (
        <ul className="msg__memories" aria-label="Gmail に保存した下書き">
          {msg.drafts.map((d, i) => (
            <li key={`${d.subject}-${i}`} className="memory-chip memory-chip--mail" data-failed={!d.ok || undefined} title={d.ok ? "送信はしていません。Gmail の下書きで確認して送ってください" : d.error}>
              <Icon name="mail" size={12} /> <span>{d.ok ? "DRAFT SAVED" : "DRAFT FAILED"}</span> {d.to} {d.subject && `「${d.subject}」`}
              {d.ok && (
                <a href="https://mail.google.com/mail/u/0/#drafts" target="_blank" rel="noreferrer noopener">
                  GMAIL ↗
                </a>
              )}
            </li>
          ))}
        </ul>
      )}
      {msg.documents?.map((d, i) => (
        <details key={`${d.title}-${i}`} className="doc-card hud" open={i === 0 && (msg.documents?.length ?? 0) === 1}>
          <HudFrame cut={12} small={5} ticks={false} />
          <summary>
            <Icon name="doc" size={14} />
            <b>{d.title}</b>
            <span className="doc-card__state" data-failed={!d.ok || undefined}>
              {d.ok ? (d.updated ? "UPDATED" : "SAVED") : "NOT SAVED"}
            </span>
            {d.path && <span className="doc-card__path">{d.path}</span>}
          </summary>
          {!d.ok && d.error && <p className="doc-card__error">{d.error}</p>}
          <div className="doc-card__body md">
            <Markdown text={d.content ?? ""} />
          </div>
          {d.content && (
            <button type="button" className="ghost-btn doc-card__copy" onClick={() => void navigator.clipboard?.writeText(d.content ?? "")}>
              コピー
            </button>
          )}
        </details>
      ))}
      {msg.actions && msg.actions.length > 0 && (
        <ul className="msg__memories" aria-label="脳に書き込んだこと">
          {msg.actions.map((a, i) => (
            <li
              key={`${a.kind}-${i}`}
              className="memory-chip memory-chip--calendar"
              data-failed={!a.ok || undefined}
              title={a.ok ? (a.kind.startsWith("company-") ? "AI 会社（ARQO）で実行しました" : "脳（Obsidian）に保存しました") : a.error}
            >
              <Icon name={ACTION_LABEL[a.kind][1]} size={12} /> <span>{a.ok ? ACTION_LABEL[a.kind][0] : "FAILED"}</span> {a.label}
            </li>
          ))}
        </ul>
      )}
      {msg.tabs && msg.tabs.length > 0 && (
        <ul className="msg__memories" aria-label="開いたページ">
          {msg.tabs.map((t, i) => (
            <li key={i} className="memory-chip memory-chip--calendar" data-failed={!t.ok || undefined} title={t.error ?? t.url}>
              <Icon name="link" size={12} /> <span>{t.action === "close" ? (t.ok ? "CLOSED" : "NOTHING TO CLOSE") : t.ok ? "OPENED" : "OPEN FAILED"}</span>{" "}
              {t.action === "open" && t.ok && t.url ? (
                <a href={t.url} target="_blank" rel="noopener noreferrer">
                  {t.label}
                </a>
              ) : (
                t.label
              )}
            </li>
          ))}
        </ul>
      )}
      {msg.newsSettings && (
        <ul className="msg__memories" aria-label="ニュースの設定">
          <li
            className="memory-chip memory-chip--calendar"
            data-failed={!msg.newsSettings.ok || undefined}
            title={msg.newsSettings.ok ? "脳の「ニュース」ノートに保存しました" : msg.newsSettings.error}
          >
            <Icon name="doc" size={12} /> <span>{msg.newsSettings.ok ? "NEWS SETTINGS" : "NEWS SETTINGS FAILED"}</span>
            {msg.newsSettings.ok &&
              ` ${msg.newsSettings.time === "off" ? "自動オフ" : msg.newsSettings.time} · ${msg.newsSettings.topics?.join("、") || "分野なし"}`}
          </li>
        </ul>
      )}
      {msg.status !== "streaming" && msg.sources && msg.sources.length > 0 && (
        <ul className="msg__sources" aria-label="検索で参照したページ">
          {msg.sources.map((src) => (
            <li key={src.uri}>
              <a href={src.uri} target="_blank" rel="noreferrer noopener" title={src.title}>
                <Icon name="search" size={11} /> {src.title}
              </a>
            </li>
          ))}
        </ul>
      )}
      {msg.status === "done" && msg.memories && msg.memories.length > 0 && (
        <ul className="msg__memories" aria-label="脳に覚えたこと">
          {msg.memories.map((m) => (
            <li key={m} className="memory-chip" title="Obsidian の脳（記憶.md）に保存">
              <Icon name="brain" size={12} /> <span>MEMORY SAVED</span> {m}
            </li>
          ))}
        </ul>
      )}
      {(msg.status === "done" || msg.status === "stopped") && msg.meta && (
        <div className="msg__meta msg__meta--ai">
          {msg.status === "stopped" && <span>STOPPED · </span>}
          {msg.meta.model}
          {msg.meta.prepMs !== undefined && <> · prep {(msg.meta.prepMs / 1000).toFixed(2)}s</>}
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
