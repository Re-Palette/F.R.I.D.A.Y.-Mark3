"use client";

/**
 * 画面下部の入力エリア。
 * Enter で送信 / Shift+Enter で改行 / Esc で応答を停止。日本語 IME の変換確定 Enter では送信しない。
 * 応答中でも次の発言を入力・送信できる（今の応答を止めて次へ進む）。
 * 入力中は onTyping を呼び、サーバー側で Gemini への接続を温めておく。
 * ファイル添付：クリップのボタン・貼り付け（写真）・画面へのドロップ（Dashboard）。添えたファイルは入力欄の上に並ぶ。
 */
import { forwardRef, memo, useEffect, useImperativeHandle, useRef, useState, type ClipboardEvent, type KeyboardEvent } from "react";
import { addFiles, removeAttachment, useAttachments, type AttachmentKind } from "@/lib/attachments";
import type { ChatPhase } from "@/hooks/useChat";
import type { VoiceState } from "@/hooks/useVoice";
import { HudFrame } from "./HudFrame";
import { Icon, type IconName } from "./icons";

const KIND_ICON: Record<AttachmentKind, IconName> = { image: "image", pdf: "doc", doc: "doc", sheet: "analysis", slides: "doc", text: "doc" };

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
  /** 「フライデー」の呼びかけで起動できるか（スマホは false） */
  wakeWord?: boolean;
  voiceInterim?: string;
  onVoiceToggle?: () => void;
  onTalk?: () => void;
  /** カメラで見せて聞く（オンの間は、話しかけた瞬間の 1 枚が添えられる） */
  cameraOn?: boolean;
  onCameraToggle?: () => void;
  /** 画面を見て手伝う（共有している間は、画面について聞いたときにその瞬間の 1 枚が添えられる） */
  screenOn?: boolean;
  onScreenToggle?: () => void;
}

const VOICE_LABEL: Record<VoiceState, string> = {
  off: "VOICE MODE",
  standby: "「フライデー」で起動",
  listening: "LISTENING",
  thinking: "THINKING",
  speaking: "SPEAKING",
};

export const Composer = memo(
  forwardRef<ComposerHandle, Props>(function Composer(
    { phase, disabled, onSend, onStop, onTyping, voiceState = "off", wakeWord = true, voiceInterim, onVoiceToggle, onTalk, cameraOn = false, onCameraToggle, screenOn = false, onScreenToggle },
    ref,
  ) {
  const [value, setValue] = useState("");
  const attachments = useAttachments();
  // 画面の共有はパソコンのブラウザだけ（スマホでは出さない）
  const [canScreen, setCanScreen] = useState(false);
  useEffect(() => setCanScreen(Boolean(navigator.mediaDevices?.getDisplayMedia) && !/Android|iPhone|iPad/i.test(navigator.userAgent)), []);
  const [attachMsg, setAttachMsg] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const reading = attachments.some((a) => a.status === "reading");
  const hasReady = attachments.some((a) => a.status === "ready");
  const canSend = (Boolean(value.trim()) || hasReady) && !reading;
  const attach = (files: FileList | File[]) => setAttachMsg(addFiles(files));
  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = [...e.clipboardData.files];
    if (!files.length) return;
    e.preventDefault();
    attach(files);
  };
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
    if (disabled || !canSend) return;
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
        {/* 聞き取り中・話し中に反応する波形の輪 */}
        <span className="composer__wave" aria-hidden="true">
          {Array.from({ length: 24 }, (_, i) => (
            <i key={i} style={{ transform: `rotate(${i * 15}deg)`, animationDelay: `${((i * 0.13) % 1).toFixed(2)}s` }} />
          ))}
        </span>
        <svg className="composer__mic-ring" viewBox="0 0 64 64">
          <circle cx="32" cy="32" r="30" strokeDasharray="3 4.2" />
          <path d="M32 2 A30 30 0 0 1 60 22" className="composer__mic-arc" />
        </svg>
        <Icon name="mic" size={24} strokeWidth={1.8} />
      </button>
      <div className="composer__main">
        {(attachments.length > 0 || attachMsg) && (
          <div className="composer__files" aria-label="添付するファイル">
            {attachments.map((a) => (
              <span key={a.id} className="attach" data-status={a.status} title={a.error ?? a.note ?? a.name}>
                {a.thumb ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={a.thumb} alt="" />
                ) : (
                  <Icon name={KIND_ICON[a.kind]} size={14} />
                )}
                <span className="attach__name">{a.name}</span>
                <span className="attach__state">{a.status === "reading" ? "読み込み中…" : a.status === "error" ? a.error : a.note ?? ""}</span>
                <button type="button" className="attach__x" onClick={() => removeAttachment(a.id)} aria-label={`${a.name} を外す`}>
                  ×
                </button>
              </span>
            ))}
            {attachMsg && <span className="attach__msg">{attachMsg}</span>}
          </div>
        )}
        <div className="composer__row">
          <textarea
            ref={taRef}
            className="composer__input"
            rows={1}
            value={value}
            placeholder={voiceInterim /* 案内の文字は出さず、聞き取り中の言葉だけを見せる */}
            onChange={(e) => {
              setValue(e.target.value);
              resize();
              onTyping?.();
            }}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            aria-label="F.R.I.D.A.Y. へのメッセージ"
            autoFocus
          />
          {busy && !value.trim() && !hasReady ? (
            <button type="button" className="composer__send composer__send--stop" onClick={onStop} title="応答を停止 (Esc)">
              <Icon name="stop" size={18} />
            </button>
          ) : (
            <button
              key={pulse}
              type="button"
              className="composer__send"
              onClick={submit}
              disabled={!canSend || disabled}
              title={reading ? "ファイルを読み込み中…" : "送信 (Enter / Shift+Enter で改行)"}
            >
              <Icon name="chevrons" size={20} strokeWidth={2.4} />
            </button>
          )}
        </div>
        <div className="composer__tools">
          <button type="button" className="tool-btn" data-voice-control onClick={onTalk} title="押して話す">
            <Icon name="mic" size={14} /> 音声入力
          </button>
          <input
            ref={fileRef}
            type="file"
            multiple
            hidden
            accept="image/*,.pdf,.docx,.xlsx,.pptx,.txt,.md,.csv,.tsv,.json,.html,.xml,.yaml,.yml,.js,.ts,.tsx,.jsx,.py,.java,.c,.cpp,.cs,.go,.rs,.rb,.php,.swift,.kt,.sql,.sh,.log,.tex"
            onChange={(e) => {
              if (e.target.files) attach(e.target.files);
              e.target.value = "";
            }}
          />
          <button type="button" className="tool-btn" disabled title="今後対応">
            <Icon name="image" size={14} /> 画像生成
          </button>
          <button
            type="button"
            className="composer__attach"
            data-on={attachments.length > 0 || undefined}
            onClick={() => fileRef.current?.click()}
            title="ファイルを添えて聞く（写真・PDF・Word / Excel / PowerPoint・テキスト。画面にドロップ・貼り付けでも添えられます）"
          >
            <Icon name="clip" size={14} />
            FILE
          </button>
          {onScreenToggle && canScreen && (
            <button
              type="button"
              className="composer__attach composer__screen"
              data-on={screenOn || undefined}
              onClick={onScreenToggle}
              aria-pressed={screenOn}
              title={screenOn ? "画面の共有をやめる" : "画面を共有して聞く（「この画面どういう意味？」と聞いたとき、その瞬間の画面を F.R.I.D.A.Y. に見せます）"}
            >
              <Icon name="monitor" size={14} />
              SCREEN
            </button>
          )}
          {onCameraToggle && (
            <button
              type="button"
              className="composer__camera"
              data-on={cameraOn || undefined}
              onClick={onCameraToggle}
              aria-pressed={cameraOn}
              title={cameraOn ? "カメラを閉じる" : "カメラで見せて聞く（話しかけた瞬間の 1 枚を F.R.I.D.A.Y. に見せます）"}
            >
              <Icon name="camera" size={14} />
              CAMERA
            </button>
          )}
          <button
            type="button"
            className="composer__voice"
            data-voice-control
            data-on={voiceState !== "off" || undefined}
            onClick={onVoiceToggle}
            aria-pressed={voiceState !== "off"}
            title={voiceState === "off" ? (wakeWord ? "音声会話をオン（「フライデー」で起動）" : "音声会話をオン") : "音声会話をオフ"}
          >
            <i className="composer__voice-led" />
            {voiceState === "standby" && !wakeWord ? "VOICE ON" : VOICE_LABEL[voiceState]}
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
