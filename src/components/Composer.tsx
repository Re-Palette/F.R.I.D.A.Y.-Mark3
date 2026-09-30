"use client";

/**
 * 画面下部の入力エリア。
 * Enter で送信 / Shift+Enter で改行 / Esc で応答を停止。日本語 IME の変換確定 Enter では送信しない。
 * 応答中でも次の発言を入力・送信できる（今の応答を止めて次へ進む）。
 * 入力中は onTyping を呼び、サーバー側で Gemini への接続を温めておく。
 */
import { forwardRef, memo, useImperativeHandle, useRef, useState, type KeyboardEvent } from "react";
import type { ChatPhase } from "@/hooks/useChat";
import type { VoiceState } from "@/hooks/useVoice";
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
  onTyping?: () => void;
  voiceState?: VoiceState;
  voiceInterim?: string;
  onVoiceToggle?: () => void;
  onTalk?: () => void;
}

const VOICE_LABEL: Record<VoiceState, string> = {
  off: "VOICE MODE",
  standby: "「フライデー」で起動",
  listening: "LISTENING",
  thinking: "THINKING",
  speaking: "SPEAKING",
};

const VOICE_PLACEHOLDER: Partial<Record<VoiceState, string>> = {
  standby: "「フライデー」と呼びかけるか、ここに入力…",
  listening: "どうぞ、話してください…",
  speaking: "F.R.I.D.A.Y. が話しています…（話しかければ割り込めます）",
  thinking: "考えています…（話しかければ割り込めます）",
};

export const Composer = memo(
  forwardRef<ComposerHandle, Props>(function Composer(
    { phase, disabled, onSend, onStop, onTyping, voiceState = "off", voiceInterim, onVoiceToggle, onTalk },
    ref,
  ) {
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
    if (disabled || !value.trim()) return;
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
    } else if (e.key === "Escape" && busy) {
      e.preventDefault();
      onStop();
    }
  };

  return (
    <div className="composer hud" data-busy={busy || undefined} data-voice={voiceState}>
      <HudFrame cut={22} small={10} leds notch />
      <button
        type="button"
        className="composer__mic"
        data-voice-control
        onClick={onTalk}
        title="押して話す（呼びかけなしで 1 回聞き取り）"
        aria-label="音声で話す"
      >
        <svg className="composer__mic-ring" viewBox="0 0 64 64">
          <circle cx="32" cy="32" r="30" strokeDasharray="3 4.2" />
          <path d="M32 2 A30 30 0 0 1 60 22" className="composer__mic-arc" />
        </svg>
        <Icon name="mic" size={24} strokeWidth={1.8} />
      </button>
      <div className="composer__main">
        <div className="composer__row">
          <textarea
            ref={taRef}
            className="composer__input"
            rows={1}
            value={value}
            placeholder={voiceInterim || VOICE_PLACEHOLDER[voiceState] || "F.R.I.D.A.Y.に話しかけてみてください…"}
            onChange={(e) => {
              setValue(e.target.value);
              resize();
              onTyping?.();
            }}
            onKeyDown={onKeyDown}
            aria-label="F.R.I.D.A.Y. へのメッセージ"
            autoFocus
          />
          {busy && !value.trim() ? (
            <button type="button" className="composer__send composer__send--stop" onClick={onStop} title="応答を停止 (Esc)">
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
          <button type="button" className="tool-btn" data-voice-control onClick={onTalk} title="押して話す">
            <Icon name="mic" size={14} /> 音声入力
          </button>
          <button type="button" className="tool-btn" disabled title="今後対応">
            <Icon name="clip" size={14} /> ファイル添付
          </button>
          <button type="button" className="tool-btn" disabled title="今後対応">
            <Icon name="image" size={14} /> 画像生成
          </button>
          <button
            type="button"
            className="composer__voice"
            data-voice-control
            data-on={voiceState !== "off" || undefined}
            onClick={onVoiceToggle}
            aria-pressed={voiceState !== "off"}
            title={voiceState === "off" ? "音声会話をオン（「フライデー」で起動）" : "音声会話をオフ"}
          >
            <i className="composer__voice-led" />
            {VOICE_LABEL[voiceState]}
            <span className="eq">
              <i />
              <i />
              <i />
              <i />
            </span>
          </button>
        </div>
      </div>
    </div>
  );
  }),
);
