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

/** 手の認識の間隔（ミリ秒）。約 15 回/秒で手の操作には十分。描画はホログラム側でなめらかに補う */
const FRAME_MS = 66;

/** 認識用の Worker（public/hand-worker.mjs）を起動して、準備ができたら返す */
function startWorker(): Promise<Worker> {
  return new Promise((resolve, reject) => {
    let worker: Worker;
    try {
      worker = new Worker("/hand-worker.mjs", { type: "module" });
    } catch (err) {
      reject(err);
      return;
    }
    const fail = (why: unknown) => {
      clearTimeout(limit);
      worker.terminate();
      reject(why);
    };
    const limit = setTimeout(() => fail(new Error("timeout")), 30_000);
    worker.onerror = (e) => fail(e);
    worker.onmessage = (e: MessageEvent<{ type: string; message?: string }>) => {
      if (e.data.type === "ready") {
        clearTimeout(limit);
        worker.onerror = null;
        resolve(worker);
      } else if (e.data.type === "error") fail(new Error(e.data.message));
    };
    worker.postMessage({ type: "init", model: MODEL });
  });
}

/** 1 コマ送って、手の 21 点を受け取る */
function askWorker(worker: Worker, bitmap: ImageBitmap, time: number): Promise<Point[][]> {
  return new Promise((resolve) => {
    worker.onmessage = (e: MessageEvent<{ type: string; landmarks?: Point[][] }>) => {
      if (e.data.type === "result") resolve(e.data.landmarks ?? []);
    };
    worker.postMessage({ type: "frame", bitmap, time }, [bitmap]);
  });
}

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
    let timer = 0;
    let worker: Worker | null = null;
    let landmarker: { close(): void; detectForVideo(v: HTMLVideoElement, t: number): { landmarks: Point[][] } } | null = null;
    let stopped = false;
    stopRef.current = () => {
      stopped = true;
      clearTimeout(timer);
      stream?.getTracks().forEach((t) => t.stop());
      worker?.postMessage({ type: "close" });
      landmarker?.close();
    };
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { width: 320, height: 240, facingMode: "user" }, audio: false });
      const video = document.createElement("video");
      video.muted = true;
      video.playsInline = true;
      video.srcObject = stream;
      await video.play();

      // 認識は別の作業場所（Worker）で。使えない環境では画面側で（回数を絞って）動かす
      worker = await startWorker().catch(() => null);
      if (!worker) {
        const { FilesetResolver, HandLandmarker } = await import("@mediapipe/tasks-vision");
        const files = await FilesetResolver.forVisionTasks(WASM);
        const make = (delegate: "GPU" | "CPU") =>
          HandLandmarker.createFromOptions(files, { baseOptions: { modelAssetPath: MODEL, delegate }, runningMode: "VIDEO", numHands: 2 });
        landmarker = await make("GPU").catch(() => make("CPU"));
      }
      if (stopped) {
        stopRef.current();
        return;
      }
      setStatus("ready");
      setMessage("");

      const tracker = new GestureTracker();
      let lastCount = 0;
      const apply = (landmarks: Point[][]) => {
        const now = performance.now();
        for (const ev of tracker.update(landmarks, now)) {
          if (ev.type === "rotate") rotateBy(ev.dx, ev.dy);
          else if (ev.type === "zoom") zoomBy(ev.factor);
          else resetView();
        }
        holo.cursors = tracker.cursors;
        if (landmarks.length !== lastCount) {
          lastCount = landmarks.length;
          setHands(lastCount);
        }
        draw(canvasRef.current, video, landmarks, tracker.cursors.map((c) => c.pinching));
      };

      // 1 秒に約 15 回。前の認識が終わってから次のコマを送る（重なって溜まらないように）
      const next = (wait: number) => {
        if (!stopped) timer = window.setTimeout(tick, wait);
      };
      const tick = async () => {
        const began = performance.now();
        if (video.readyState < 2) return next(FRAME_MS);
        if (worker) {
          const bitmap = await createImageBitmap(video, { resizeWidth: 256, resizeHeight: 192 }).catch(() => null);
          if (!bitmap || stopped) return next(FRAME_MS);
          const landmarks = await askWorker(worker, bitmap, began);
          if (stopped) return;
          apply(landmarks);
        } else if (landmarker) {
          apply(landmarker.detectForVideo(video, began).landmarks);
        }
        next(Math.max(0, FRAME_MS - (performance.now() - began)));
      };
      next(0);
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
  // 映像は薄く重ねるだけ（色を変える加工は重いので使わない）
  g.globalAlpha = 0.3;
  g.drawImage(video, 0, 0, w, h);
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
