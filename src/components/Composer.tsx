"use client";

/**
 * 画面下部の入力エリア。
 * Enter で送信 / Shift+Enter で改行。日本語 IME の変換確定 Enter では送信しない。
 */
import { forwardRef, useImperativeHandle, useRef, useState, type KeyboardEvent } from "react";
import type { ChatPhase } from "@/hooks/useChat";
import { HudFrame } from "./HudFrame";
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
    <div className="composer hud" data-busy={busy || undefined}>
      <HudFrame cut={22} small={10} leds notch />
      <div className="composer__mic" title="音声入力（今後対応）" aria-hidden="true">
        <svg className="composer__mic-ring" viewBox="0 0 64 64">
          <circle cx="32" cy="32" r="30" strokeDasharray="3 4.2" />
          <path d="M32 2 A30 30 0 0 1 60 22" className="composer__mic-arc" />
        </svg>
        <Icon name="mic" size={24} strokeWidth={1.8} />
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
              title="送信 (Enter / Shift+Enter で改行)"
            >
              <Icon name="chevrons" size={20} strokeWidth={2.4} />
            </button>
          )}
        </div>
        <div className="composer__tools">
          <button type="button" className="tool-btn" disabled title="今後対応">
            <Icon name="mic" size={14} /> 音声入力
          </button>
          <button type="button" className="tool-btn" disabled title="今後対応">
            <Icon name="clip" size={14} /> ファイル添付
          </button>
          <button type="button" className="tool-btn" disabled title="今後対応">
            <Icon name="image" size={14} /> 画像生成
          </button>
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
