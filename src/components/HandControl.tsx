"use client";

/**
 * カメラで手を読み取って、中央のホログラムを動かす（アイアンマン風）。
 *   つまんで動かす → 回す ／ 両手でつまんで広げる → 拡大 ／ グーを長め → 元に戻す
 * 手の認識（MediaPipe Hand Landmarker）はブラウザの中だけで動き、カメラの映像はどこにも送らない。
 * 認識の部品（wasm・自分のサイトから）とモデル（Google から）は、オンにしたときだけ読み込む。
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { GestureTracker, type Point } from "@/lib/hand-gestures";
import { holo, resetView, rotateBy, zoomBy } from "@/lib/hologram-control";
import { useHoloState } from "@/lib/hologram-model";

/** wasm は build 時に public/mediapipe/ へコピーしたもの（scripts/copy-mediapipe.mjs） */
const WASM = "/mediapipe";
const MODEL = "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task";
/** 手の骨格の線（MediaPipe の 21 点のつながり） */
const BONES = [
  [0, 1], [1, 2], [2, 3], [3, 4], [0, 5], [5, 6], [6, 7], [7, 8], [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16], [13, 17], [0, 17], [17, 18], [18, 19], [19, 20],
];

type Status = "off" | "loading" | "ready" | "error";

/* 拡大表示の画面からもオン・オフできるよう、状態を外に出しておく */
const TOGGLE = "friday:hand-toggle";
let shared: Status = "off";
const watchers = new Set<() => void>();
const publish = (s: Status) => {
  shared = s;
  watchers.forEach((w) => w());
};
export function useHandStatus(): Status {
  return useSyncExternalStore(
    (fn) => (watchers.add(fn), () => watchers.delete(fn)),
    () => shared,
    () => "off",
  );
}
export function toggleHand(): void {
  window.dispatchEvent(new Event(TOGGLE));
}

export function HandControl({ hidden }: { hidden: boolean }) {
  const [status, setStatus] = useState<Status>("off");
  const [message, setMessage] = useState("");
  const [hands, setHands] = useState(0);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stopRef = useRef<() => void>(() => {});

  const stop = useCallback(() => {
    stopRef.current();
    stopRef.current = () => {};
    holo.cursors = [];
    setHands(0);
    setStatus("off");
    setMessage("");
  }, []);

  const start = useCallback(async () => {
    setStatus("loading");
    setMessage("カメラと手の認識を準備しています…");
    let stream: MediaStream | null = null;
    let raf = 0;
    let landmarker: { close(): void; detectForVideo(v: HTMLVideoElement, t: number): { landmarks: Point[][] } } | null = null;
    let stopped = false;
    stopRef.current = () => {
      stopped = true;
      cancelAnimationFrame(raf);
      stream?.getTracks().forEach((t) => t.stop());
      landmarker?.close();
    };
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { width: 320, height: 240, facingMode: "user" }, audio: false });
      const video = document.createElement("video");
      video.muted = true;
      video.playsInline = true;
      video.srcObject = stream;
      await video.play();

      const { FilesetResolver, HandLandmarker } = await import("@mediapipe/tasks-vision");
      const files = await FilesetResolver.forVisionTasks(WASM);
      const make = (delegate: "GPU" | "CPU") =>
        HandLandmarker.createFromOptions(files, {
          baseOptions: { modelAssetPath: MODEL, delegate },
          runningMode: "VIDEO",
          numHands: 2,
        });
      landmarker = await make("GPU").catch(() => make("CPU"));
      if (stopped) {
        landmarker.close();
        return;
      }
      setStatus("ready");
      setMessage("");

      const tracker = new GestureTracker();
      let lastVideoTime = -1;
      let lastCount = 0;
      const loop = () => {
        raf = requestAnimationFrame(loop);
        if (video.readyState < 2 || video.currentTime === lastVideoTime || !landmarker) return;
        lastVideoTime = video.currentTime;
        const now = performance.now();
        const result = landmarker.detectForVideo(video, now);
        for (const ev of tracker.update(result.landmarks, now)) {
          if (ev.type === "rotate") rotateBy(ev.dx, ev.dy);
          else if (ev.type === "zoom") zoomBy(ev.factor);
          else resetView();
        }
        holo.cursors = tracker.cursors;
        if (result.landmarks.length !== lastCount) {
          lastCount = result.landmarks.length;
          setHands(lastCount);
        }
        draw(canvasRef.current, video, result.landmarks, tracker.cursors.map((c) => c.pinching));
      };
      loop();
    } catch (err) {
      stopRef.current();
      const name = (err as { name?: string }).name;
      setStatus("error");
      setMessage(
        name === "NotAllowedError"
          ? "カメラの使用が許可されていません。アドレスバーのカメラのアイコンから許可してください。"
          : name === "NotFoundError"
            ? "カメラが見つかりません。"
            : "手の認識を読み込めませんでした。ネットワークを確認して、もう一度オンにしてください。",
      );
    }
  }, []);

  useEffect(() => publish(status), [status]);
  const statusRef = useRef(status);
  statusRef.current = status;
  useEffect(() => {
    const onToggle = () => (statusRef.current === "loading" || statusRef.current === "ready" ? stop() : void start());
    window.addEventListener(TOGGLE, onToggle);
    return () => window.removeEventListener(TOGGLE, onToggle);
  }, [start, stop]);

  // HOME を離れたらカメラを止める
  useEffect(() => {
    if (hidden && status !== "off") stop();
  }, [hidden, status, stop]);
  useEffect(() => () => stopRef.current(), []);

  // カメラ映像は左のメニューの空き（拡大表示中はその画面の中）に出す。どちらも無ければボタンの上に出す
  const expanded = useHoloState().expanded;
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  useEffect(() => {
    setSlot(document.querySelector<HTMLElement>(expanded ? ".holo-stage__hand" : "#hand-slot") ?? document.getElementById("hand-slot"));
  }, [expanded]);

  const on = status === "loading" || status === "ready";
  const panel = (on || message) && (
    <div className="hand__panel">
      {on && (
        <div className="hand__view">
          <canvas ref={canvasRef} width={176} height={132} />
          <span className="hand__tag">{status === "ready" ? (hands ? `HAND ×${hands}` : "NO HAND") : "LOADING"}</span>
        </div>
      )}
      {status === "ready" && (
        <p className="hand__help">
          つまんで動かす：回す ／ 両手で広げる：拡大
          <br />
          グーを長めに：元に戻す
        </p>
      )}
      {message && <p className="hand__msg">{message}</p>}
    </div>
  );
  return (
    <div className="hand" data-status={status}>
      {panel && (slot ? createPortal(panel, slot) : panel)}
      <button type="button" className="hand__btn" aria-pressed={on} onClick={() => (on ? stop() : void start())}>
        <HandIcon /> HAND {on ? "ON" : "OFF"}
      </button>
    </div>
  );
}

/** カメラの映像（鏡写し・ホログラム風の色）に手の骨格を重ねる */
function draw(canvas: HTMLCanvasElement | null, video: HTMLVideoElement, hands: Point[][], pinching: boolean[]) {
  const g = canvas?.getContext("2d");
  if (!canvas || !g) return;
  const { width: w, height: h } = canvas;
  g.save();
  g.clearRect(0, 0, w, h);
  g.translate(w, 0);
  g.scale(-1, 1);
  g.globalAlpha = 0.35;
  g.filter = "grayscale(1) contrast(1.2)";
  g.drawImage(video, 0, 0, w, h);
  g.filter = "none";
  g.globalAlpha = 1;
  g.fillStyle = "rgba(255,120,20,0.18)";
  g.fillRect(0, 0, w, h);
  // 左から順（hand-gestures と同じ並び）に色分けせず、つまんでいる手を明るくする
  const sorted = [...hands].sort((a, b) => b[0].x - a[0].x);
  sorted.forEach((lm, i) => {
    const hot = pinching[i];
    g.strokeStyle = hot ? "#2ee6ff" : "rgba(255,160,70,0.9)";
    g.lineWidth = 1.5;
    g.beginPath();
    for (const [a, b] of BONES) {
      g.moveTo(lm[a].x * w, lm[a].y * h);
      g.lineTo(lm[b].x * w, lm[b].y * h);
    }
    g.stroke();
    g.fillStyle = hot ? "#2ee6ff" : "#ffd9a0";
    for (const p of lm) g.fillRect(p.x * w - 1.5, p.y * h - 1.5, 3, 3);
    if (hot) {
      g.beginPath();
      g.arc(((lm[4].x + lm[8].x) / 2) * w, ((lm[4].y + lm[8].y) / 2) * h, 7, 0, Math.PI * 2);
      g.stroke();
    }
  });
  g.restore();
}

function HandIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M8 13V5.5a1.5 1.5 0 0 1 3 0V12" />
      <path d="M11 11.5V4a1.5 1.5 0 0 1 3 0v7.5" />
      <path d="M14 11.5V5.5a1.5 1.5 0 0 1 3 0V14" />
      <path d="M17 9.5a1.5 1.5 0 0 1 3 0V15a6 6 0 0 1-6 6h-1.5a6 6 0 0 1-4.7-2.3L4.6 14.6a1.5 1.5 0 0 1 2.3-1.9L8 14" />
    </svg>
  );
}
