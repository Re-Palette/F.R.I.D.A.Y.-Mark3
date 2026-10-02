/**
 * 「画面を見て手伝う」。SCREEN ボタンで画面（またはウィンドウ・タブ）の共有を始め、
 * 画面について聞いたとき（「この画面」「このエラー」「これどういう意味？」など）だけ、その瞬間の 1 枚を会話に添える。
 * 共有はブラウザの決まりでボタンを押したときにしか始められない。映像はこの端末の中だけで扱い、保存しない（Obsidian にも残さない）。
 */
import { useSyncExternalStore } from "react";
import type { ChatFile } from "@/core/types";

export interface ScreenState {
  on: boolean;
  error?: string;
}

let state: ScreenState = { on: false };
const listeners = new Set<() => void>();
let stream: MediaStream | null = null;
let video: HTMLVideoElement | null = null;

function set(next: Partial<ScreenState>) {
  state = { ...state, ...next };
  listeners.forEach((l) => l());
}

export function getScreenState(): ScreenState {
  return state;
}

export function useScreenState(): ScreenState {
  return useSyncExternalStore(
    (fn) => (listeners.add(fn), () => listeners.delete(fn)),
    getScreenState,
    getScreenState,
  );
}

/** 共有を始める（ボタンを押したときに呼ぶ） */
export async function openScreen(): Promise<void> {
  if (stream) return;
  try {
    if (!navigator.mediaDevices?.getDisplayMedia) throw Object.assign(new Error(), { name: "NotSupportedError" });
    stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 5, max: 10 } }, audio: false });
    // ブラウザの「共有を停止」で止められたら、こちらも閉じる
    stream.getVideoTracks()[0]?.addEventListener("ended", () => closeScreen());
    video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.srcObject = stream;
    await video.play().catch(() => {});
    set({ on: true, error: undefined });
  } catch (err) {
    stream = null;
    const name = err instanceof Error ? err.name : "";
    // 選ぶ画面でキャンセルしたときは何も言わない
    set({
      on: false,
      error: name === "NotAllowedError" || name === "AbortError" ? undefined : name === "NotSupportedError" ? "このブラウザは画面の共有に対応していません（パソコンの Chrome / Edge で使えます）。" : "画面を共有できませんでした。",
    });
  }
}

export function closeScreen(): void {
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
  if (video) video.srcObject = null;
  video = null;
  set({ on: false });
}

export function toggleScreen(): void {
  if (state.on) closeScreen();
  else void openScreen();
}

/** 画面について聞いているか */
export function asksAboutScreen(text: string): boolean {
  return /画面|このページ|このサイト|この表示|このエラー|このコード|この表|この文(章)?|このメール|このボタン|このアプリ|ここ(の|に|って|は)|これ(って|は|どういう|なに|何|なんて|どう)|どこ(を|に)(押|クリック)/.test(text);
}

/** いま映っている画面の 1 枚（文字が読めるよう、長い辺 1920px まで）。共有していなければ null */
export async function captureScreen(): Promise<{ file: ChatFile; thumb: string } | null> {
  const v = video;
  if (!v || !stream) return null;
  if (!v.videoWidth) await new Promise((r) => setTimeout(r, 300));
  if (!v.videoWidth) return null;
  const draw = (max: number, quality: number) => {
    const scale = Math.min(1, max / Math.max(v.videoWidth, v.videoHeight));
    const c = document.createElement("canvas");
    c.width = Math.round(v.videoWidth * scale);
    c.height = Math.round(v.videoHeight * scale);
    c.getContext("2d")!.drawImage(v, 0, 0, c.width, c.height);
    return c.toDataURL("image/jpeg", quality);
  };
  const full = draw(1920, 0.8);
  return {
    file: { name: "画面のスクリーンショット", mimeType: "image/jpeg", data: full.slice(full.indexOf(",") + 1) },
    thumb: draw(200, 0.7),
  };
}
