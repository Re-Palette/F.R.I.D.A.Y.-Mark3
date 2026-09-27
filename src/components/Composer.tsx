"use client";

/**
 * 画面下部の入力エリア。
 * Enter で送信 / Shift+Enter で改行。日本語 IME の変換確定 Enter では送信しない。
 */
import { forwardRef, useImperativeHandle, useRef, useState, type KeyboardEvent } from "react";
import type { ChatPhase } from "@/hooks/useChat";
import { Icon } from "./icons";

export interface ComposerHandle {
  focus: () => void;
}

interface Props {
  phase: ChatPhase;
  disabled: boolean;
  onSend: (text: string) => boolean;
  onStop: () => void;
}

export const Composer = forwardRef<ComposerHandle, Props>(function Composer({ phase, disabled, onSend, onStop }, ref) {
  const [value, setValue] = useState("");
  const [pulse, setPulse] = useState(0);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const busy = phase !== "idle";

  useImperativeHandle(ref, () => ({ focus: () => taRef.current?.focus() }), []);

  const resize = () => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 160)}px`;
  };

  const submit = () => {
    if (busy || disabled || !value.trim()) return;
    if (onSend(value)) {
      setValue("");
      setPulse((p) => p + 1);
      requestAnimationFrame(() => {
        resize();
        taRef.current?.focus();
      });
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // isComposing / keyCode 229: IME 変換中の Enter は送信しない
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && e.keyCode !== 229) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <div className="composer" data-busy={busy || undefined}>
      <div className="composer__mic" title="音声入力（今後対応）" aria-hidden="true">
        <Icon name="mic" size={22} />
      </div>
      <div className="composer__main">
        <div className="composer__row">
          <textarea
            ref={taRef}
            className="composer__input"
            rows={1}
            value={value}
            placeholder="F.R.I.D.A.Y.に話しかけてみてください…"
            onChange={(e) => {
              setValue(e.target.value);
              resize();
            }}
            onKeyDown={onKeyDown}
            aria-label="F.R.I.D.A.Y. へのメッセージ"
            autoFocus
          />
          {busy ? (
            <button type="button" className="composer__send composer__send--stop" onClick={onStop} title="応答を停止">
              <Icon name="stop" size={18} />
            </button>
          ) : (
            <button
              key={pulse}
              type="button"
              className="composer__send"
              onClick={submit}
              disabled={!value.trim() || disabled}
              title="送信 (Enter)"
            >
              <Icon name="send" size={20} strokeWidth={2.2} />
            </button>
          )}
        </div>
        <div className="composer__tools">
          <button type="button" className="tool-btn" disabled title="今後対応">
            <Icon name="mic" size={13} /> 音声入力
          </button>
          <button type="button" className="tool-btn" disabled title="今後対応">
            <Icon name="clip" size={13} /> ファイル添付
          </button>
          <button type="button" className="tool-btn" disabled title="今後対応">
            <Icon name="image" size={13} /> 画像生成
          </button>
          <span className="composer__hint">Enter 送信 · Shift+Enter 改行</span>
          <span className="composer__voice" title="今後対応">
            VOICE MODE
            <span className="eq">
              <i />
              <i />
              <i />
              <i />
            </span>
          </span>
        </div>
      </div>
    </div>
  );
});
