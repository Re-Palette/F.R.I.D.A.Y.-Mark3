/**
 * 声の聞き取りの方式（この端末だけの設定）。
 *   chrome   … Chrome の音声認識（速い・無料。ただし Windows の「既定の録音デバイス」を使うので、
 *              Chrome で選んだマイクと違うと、音量は動くのに何も聞き取れないことがある）
 *   recorded … マイクの音を自分で録って、話し終わったらサーバーで文字にする（ChatGPT などと同じ方式。Chrome で選んだマイクを使う）
 *   auto     … まず Chrome の音声認識。声は届いているのに聞き取れない状態が続いたら、自動で recorded に切り替える
 */
import { useSyncExternalStore } from "react";

export type VoiceInputMode = "auto" | "chrome" | "recorded";

const KEY = "friday.voice.input.v1";
/** 自動で切り替えたか（auto のまま、実際には録音方式を使う） */
const AUTO_KEY = "friday.voice.input.auto-recorded";
const listeners = new Set<() => void>();
let cache: { mode: VoiceInputMode; autoRecorded: boolean } | null = null;

function read(): { mode: VoiceInputMode; autoRecorded: boolean } {
  if (cache) return cache;
  let mode: VoiceInputMode = "auto";
  let autoRecorded = false;
  try {
    const v = localStorage.getItem(KEY);
    if (v === "chrome" || v === "recorded" || v === "auto") mode = v;
    autoRecorded = localStorage.getItem(AUTO_KEY) === "1";
  } catch {
    /* noop */
  }
  cache = { mode, autoRecorded };
  return cache;
}

function write(next: { mode: VoiceInputMode; autoRecorded: boolean }) {
  cache = next;
  try {
    localStorage.setItem(KEY, next.mode);
    if (next.autoRecorded) localStorage.setItem(AUTO_KEY, "1");
    else localStorage.removeItem(AUTO_KEY);
  } catch {
    /* noop */
  }
  listeners.forEach((l) => l());
}

export function setVoiceInputMode(mode: VoiceInputMode): void {
  write({ mode, autoRecorded: false });
}

/** 自動のとき、Chrome の音声認識が聞き取れていないので録音方式に切り替える（切り替えたら true） */
export function autoSwitchToRecorded(): boolean {
  const s = read();
  if (s.mode !== "auto" || s.autoRecorded) return false;
  write({ mode: "auto", autoRecorded: true });
  return true;
}

/** 実際に録音方式を使うか */
export function usesRecorded(s = read()): boolean {
  return s.mode === "recorded" || (s.mode === "auto" && s.autoRecorded);
}

const SERVER = { mode: "auto" as VoiceInputMode, autoRecorded: false };

export function useVoiceInput(): { mode: VoiceInputMode; autoRecorded: boolean; recorded: boolean } {
  const s = useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    read,
    () => SERVER,
  );
  return { ...s, recorded: usesRecorded(s) };
}
