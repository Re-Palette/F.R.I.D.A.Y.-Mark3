/**
 * 「カメラで見せて聞く」のカメラ。オンの間は映像を画面の小窓に映し、話しかけた瞬間の 1 枚を撮って会話に添える。
 * 映像はこの端末の中だけで扱い、送るのは話しかけたときの静止画 1 枚だけ（保存はしない）。
 */
import { useSyncExternalStore } from "react";

export interface CameraState {
  on: boolean;
  /** 映像が届き始めたか */
  ready: boolean;
  error?: string;
}

/** 会話に添える 1 枚（full は送る用、thumb は画面に出す小さい版。どちらも data URL） */
export interface CameraShot {
  full: string;
  thumb: string;
}

let state: CameraState = { on: false, ready: false };
const listeners = new Set<() => void>();
let stream: MediaStream | null = null;
let video: HTMLVideoElement | null = null;
let openedAt = 0;
let opening: Promise<void> | null = null;

function set(next: Partial<CameraState>) {
  state = { ...state, ...next };
  listeners.forEach((l) => l());
}

export function getCameraState(): CameraState {
  return state;
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function useCameraState(): CameraState {
  return useSyncExternalStore(subscribe, getCameraState, getCameraState);
}

/** 画面の小窓に映すための映像（オンの間だけ） */
export function cameraStream(): MediaStream | null {
  return stream;
}

const ERRORS: Record<string, string> = {
  NotAllowedError: "カメラの使用が許可されていません。アドレスバーのカメラのマークから許可してください。",
  NotFoundError: "カメラが見つかりませんでした。",
  NotReadableError: "カメラを開けませんでした。ほかのアプリが使っていないか確かめてください。",
};

export function openCamera(): Promise<void> {
  if (stream) return Promise.resolve();
  if (opening) return opening;
  opening = (async () => {
    set({ on: true, ready: false, error: undefined });
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw Object.assign(new Error(), { name: "NotFoundError" });
      // スマホは外側のカメラ、パソコンは付いているカメラ
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      });
      if (!state.on) {
        // 開いている間に閉じられた
        stream.getTracks().forEach((t) => t.stop());
        stream = null;
        return;
      }
      video = document.createElement("video");
      video.muted = true;
      video.playsInline = true;
      video.srcObject = stream;
      await video.play().catch(() => {});
      openedAt = performance.now();
      set({ ready: true });
    } catch (err) {
      const name = err instanceof Error ? err.name : "";
      stream = null;
      set({ on: false, ready: false, error: ERRORS[name] ?? "カメラを開けませんでした。" });
    } finally {
      opening = null;
    }
  })();
  return opening;
}

export function closeCamera(): void {
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
  if (video) video.srcObject = null;
  video = null;
  set({ on: false, ready: false, error: undefined });
}

export function toggleCamera(): void {
  if (state.on) closeCamera();
  else void openCamera();
}

export function dismissCameraError(): void {
  set({ error: undefined });
}

/** 映像を、長い辺が max 以内の JPEG にする */
function snapshot(v: HTMLVideoElement, max: number, quality: number): string {
  const scale = Math.min(1, max / Math.max(v.videoWidth, v.videoHeight));
  const c = document.createElement("canvas");
  c.width = Math.round(v.videoWidth * scale);
  c.height = Math.round(v.videoHeight * scale);
  c.getContext("2d")!.drawImage(v, 0, 0, c.width, c.height);
  return c.toDataURL("image/jpeg", quality);
}

/** いま写っている 1 枚を撮る（カメラがオフ・映像がまだなら null） */
export async function captureFrame(): Promise<CameraShot | null> {
  if (opening) await opening;
  const v = video;
  if (!v || !stream) return null;
  // 開いた直後は明るさが安定しないので、少しだけ待つ
  const settle = 700 - (performance.now() - openedAt);
  if (settle > 0) await new Promise((r) => setTimeout(r, settle));
  if (v.readyState < 2 || !v.videoWidth) {
    await new Promise<void>((resolve) => {
      const done = () => resolve();
      v.addEventListener("loadeddata", done, { once: true });
      setTimeout(done, 2000);
    });
  }
  if (!v.videoWidth) return null;
  return { full: snapshot(v, 1024, 0.82), thumb: snapshot(v, 240, 0.7) };
}

/**
 * カメラを使ってほしそうな言い方か（オフのときに言われたら、カメラを開いてから聞く）。
 * 「これ何？」「これ見て」「カメラで見て」など。普通の会話で勝手に開かないよう、はっきりした言い方だけ。
 */
export function asksToLook(text: string): boolean {
  return /カメラ(を|で)?(つけて|起動|オン|開いて|見て)|カメラで|これ(って|は)?(何|なに|なん)[?？だでか]?|これ(を)?見て|見てくれ|見てほしい|見てもらえ|これ(を)?読(んで|める)/.test(text);
}
