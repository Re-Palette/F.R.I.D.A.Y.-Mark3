"use client";

/**
 * カメラで手を読み取って、中央のホログラムを動かす（アイアンマン風）。
 *   つまんで動かす → 回す ／ 両手でつまんで広げる → 拡大 ／ グーを長め → 元に戻す
 * 手の認識（MediaPipe Hand Landmarker）はブラウザの中だけで動き、カメラの映像はどこにも送らない。
 * 認識の部品（wasm・自分のサイトから）とモデル（Google から）は、ホログラムを作り始めたとき・ボタンに触れたとき・
 * オンにしたときに裏で準備を始め、一度準備した認識はこの画面を開いている間ずっと使い回す（2 回目からはすぐ動く）。
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { GestureTracker, type Point } from "@/lib/hand-gestures";
import { holo, resetView, steerBy, zoomBy } from "@/lib/hologram-control";
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

/** 手の認識の間隔の下限（ミリ秒）。最大で約 30 回/秒。前の認識が終わってから次を送るので、遅い端末では自然に減る */
const FRAME_MS = 33;
/** CPU での認識がこれより遅い（ミリ秒・平均）端末では、GPU に切り替える */
const SLOW_INFER_MS = 55;

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

/** 準備済み（または準備中）の認識。オフにしても捨てずに、次にオンにしたとき使い回す */
let warmed: Promise<Worker | null> | null = null;

/** 手の認識の準備を裏で始める（何度呼んでもよい）。使えない環境では null */
export function warmHands(): Promise<Worker | null> {
  warmed ??= startWorker().catch(() => {
    warmed = null;
    return null;
  });
  return warmed;
}

if (typeof window !== "undefined") {
  window.addEventListener("pagehide", () => {
    void warmed?.then((w) => w?.postMessage({ type: "close" }));
    warmed = null;
  });
}

interface WorkerResult {
  landmarks: Point[][];
  /** 認識にかかった時間（ミリ秒） */
  ms?: number;
  delegate?: "CPU" | "GPU";
}

/** 1 コマ送って、手の 21 点を受け取る */
function askWorker(worker: Worker, bitmap: ImageBitmap, time: number): Promise<WorkerResult> {
  return new Promise((resolve) => {
    worker.onmessage = (e: MessageEvent<{ type: string } & Partial<WorkerResult>>) => {
      if (e.data.type === "result") resolve({ landmarks: e.data.landmarks ?? [], ms: e.data.ms, delegate: e.data.delegate });
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
  /** 1 秒あたりの手の認識回数 */
  const [rate, setRate] = useState(0);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stopRef = useRef<() => void>(() => {});

  const stop = useCallback(() => {
    stopRef.current();
    stopRef.current = () => {};
    holo.cursors = [];
    setHands(0);
    setRate(0);
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
      // 認識（Worker）は捨てずに残し、次にオンにしたとき使い回す
      landmarker?.close();
    };
    try {
      // カメラの起動と、認識の準備を同時に進める（順番に待たない）
      const cameraReady = navigator.mediaDevices
        .getUserMedia({ video: { width: 320, height: 240, facingMode: "user" }, audio: false })
        .then(async (s) => {
          stream = s;
          if (stopped) s.getTracks().forEach((t) => t.stop());
          const v = document.createElement("video");
          v.muted = true;
          v.playsInline = true;
          v.srcObject = s;
          await v.play();
          return v;
        });
      const [video, w] = await Promise.all([cameraReady, warmHands()]);
      worker = w;

      // 認識は別の作業場所（Worker）で。使えない環境では画面側で（回数を絞って）動かす
      if (!worker) {
        const { FilesetResolver, HandLandmarker } = await import("@mediapipe/tasks-vision");
        const files = await FilesetResolver.forVisionTasks(WASM);
        const make = (delegate: "GPU" | "CPU") =>
          HandLandmarker.createFromOptions(files, { baseOptions: { modelAssetPath: MODEL, delegate }, runningMode: "VIDEO", numHands: 2 });
        landmarker = await make("CPU").catch(() => make("GPU"));
      }
      if (stopped) {
        stopRef.current();
        return;
      }
      setStatus("ready");
      setMessage("");

      const tracker = new GestureTracker();
      let lastCount = 0;
      // 最新の認識結果（小窓の描画は、これを毎フレームなめらかに追いかけて描く）
      let latest: Point[][] = [];
      let pinching: boolean[] = [];
      const apply = (landmarks: Point[][]) => {
        const now = performance.now();
        for (const ev of tracker.update(landmarks, now)) {
          if (ev.type === "rotate") steerBy(ev.dx, ev.dy);
          else if (ev.type === "zoom") zoomBy(ev.factor);
          else resetView();
        }
        holo.cursors = tracker.cursors;
        latest = landmarks;
        pinching = tracker.cursors.map((c) => c.pinching);
        if (landmarks.length !== lastCount) {
          lastCount = landmarks.length;
          setHands(lastCount);
        }
      };

      // 小窓：カメラの映像は毎フレーム描き、手の骨格は認識と認識の間をなめらかにつなぐ
      let shown: Point[][] = [];
      let lastDraw = performance.now();
      let raf = 0;
      const paint = (now: number) => {
        if (stopped) return;
        raf = requestAnimationFrame(paint);
        const dt = Math.min(0.1, (now - lastDraw) / 1000);
        lastDraw = now;
        const k = 1 - Math.exp(-dt * 22);
        if (shown.length !== latest.length) shown = latest.map((h) => h.map((p) => ({ ...p })));
        else
          shown = shown.map((h, i) =>
            h.map((p, j) => {
              const q = latest[i]?.[j] ?? p;
              return { x: p.x + (q.x - p.x) * k, y: p.y + (q.y - p.y) * k };
            }),
          );
        draw(canvasRef.current, video, shown, pinching);
      };
      raf = requestAnimationFrame(paint);
      const stopLoops = stopRef.current;
      stopRef.current = () => {
        cancelAnimationFrame(raf);
        stopLoops();
      };

      // 認識：前の認識が終わってから次のコマを送る（重なって溜まらないように）。最大で約 30 回/秒
      let avgMs = 0;
      let samples = 0;
      let switched = false;
      let count = 0;
      let rateFrom = performance.now();
      const next = (wait: number) => {
        if (!stopped) timer = window.setTimeout(tick, wait);
      };
      const tick = async () => {
        const began = performance.now();
        if (video.readyState < 2) return next(FRAME_MS);
        if (worker) {
          const bitmap = await createImageBitmap(video, { resizeWidth: 256, resizeHeight: 192 }).catch(() => null);
          if (!bitmap || stopped) return next(FRAME_MS);
          const result = await askWorker(worker, bitmap, began);
          if (stopped) return;
          apply(result.landmarks);
          // CPU での認識が遅すぎる端末では、GPU に切り替える（1 回だけ）
          if (result.ms !== undefined) {
            avgMs = samples ? avgMs * 0.85 + result.ms * 0.15 : result.ms;
            samples++;
            if (!switched && samples > 20 && result.delegate === "CPU" && avgMs > SLOW_INFER_MS) {
              switched = true;
              worker.postMessage({ type: "delegate", value: "GPU" });
            }
          }
        } else if (landmarker) {
          apply(landmarker.detectForVideo(video, began).landmarks);
        }
        // 1 秒あたりの認識回数（小窓に表示）
        count++;
        const span = performance.now() - rateFrom;
        if (span >= 1000) {
          setRate(Math.round((count * 1000) / span));
          count = 0;
          rateFrom = performance.now();
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

  // ホログラムを作り始めたら、手で動かせるよう裏で認識の準備を始めておく（画面が空いたときに）
  const holoStatus = useHoloState().status;
  useEffect(() => {
    if (holoStatus !== "loading" && holoStatus !== "ready") return;
    if ("requestIdleCallback" in window) window.requestIdleCallback(() => void warmHands(), { timeout: 4000 });
    else setTimeout(() => void warmHands(), 1500);
  }, [holoStatus]);

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
          <span className="hand__tag">
            {status === "ready" ? `${hands ? `HAND ×${hands}` : "NO HAND"}${rate ? ` · ${rate}/s` : ""}` : "LOADING"}
          </span>
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
      <button
        type="button"
        className="hand__btn"
        aria-pressed={on}
        onPointerEnter={() => void warmHands()}
        onFocus={() => void warmHands()}
        onClick={() => (on ? stop() : void start())}
      >
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
    g.strokeStyle = hot ? "#fff1dd" : "rgba(255,160,70,0.9)";
    g.lineWidth = 1.5;
    g.beginPath();
    for (const [a, b] of BONES) {
      g.moveTo(lm[a].x * w, lm[a].y * h);
      g.lineTo(lm[b].x * w, lm[b].y * h);
    }
    g.stroke();
    g.fillStyle = hot ? "#fff1dd" : "#ffd9a0";
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
