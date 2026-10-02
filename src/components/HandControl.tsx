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
import { HandPredictor } from "@/lib/hand-predict";
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

/** 手の認識に送る間隔の下限（ミリ秒）。最大で約 30 回/秒。各 Worker は前の認識が終わってから次を受け取るので、遅い端末では自然に減る */
const FRAME_MS = 33;
/** CPU での認識がこれより遅い（ミリ秒・平均）端末では、GPU も試してみる */
const SLOW_INFER_MS = 45;

type Delegate = "CPU" | "GPU";
/**
 * この端末で速かった方（CPU / GPU）を覚えておく。GPU が速いかどうかは端末しだいで、
 * 遅い端末では CPU の何十倍もかかる（1 秒に 1 回しか認識できなくなる）ので、必ず測って決める。
 */
const PICK_KEY = "friday.hand.delegate.v1";
interface Pick {
  pick: Delegate;
  /** 試して遅かった・使えなかった */
  gpuBad?: boolean;
}
function savedPick(): Pick {
  try {
    const v = JSON.parse(localStorage.getItem(PICK_KEY) || "null") as Pick | null;
    if (v && (v.pick === "CPU" || v.pick === "GPU")) return v;
  } catch {
    /* 使えない環境 */
  }
  return { pick: "CPU" };
}
function savePick(v: Pick) {
  try {
    localStorage.setItem(PICK_KEY, JSON.stringify(v));
  } catch {
    /* noop */
  }
}

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
    worker.postMessage({ type: "init", model: MODEL, delegate: savedPick().pick });
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

/** 2 つ目の認識（CPU に十分な余裕がある端末だけ）。1 つ目と交互にコマを受け持つ */
let second: Promise<Worker | null> | null = null;
function warmSecond(): Promise<Worker | null> {
  // GPU を使う端末では 2 つにしても速くならない（GPU を取り合うだけ）
  // 4 スレッドの端末は実際のコアが 2 つしかないことが多く、画面の描画と取り合ってカクつくので 8 以上だけ
  if ((navigator.hardwareConcurrency || 2) < 8 || savedPick().pick === "GPU") return Promise.resolve(null);
  second ??= startWorker().catch(() => {
    second = null;
    return null;
  });
  return second;
}

if (typeof window !== "undefined") {
  window.addEventListener("pagehide", () => {
    for (const p of [warmed, second]) void p?.then((w) => w?.postMessage({ type: "close" }));
    warmed = second = null;
  });
}

interface WorkerResult {
  landmarks: Point[][];
  /** 認識にかかった時間（ミリ秒） */
  ms?: number;
  delegate?: Delegate;
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
  /** 手の認識の遅れ（ミリ秒） */
  const [lagMs, setLagMs] = useState(0);
  /** 認識に使っている方（CPU / GPU）と、1 回にかかる時間 */
  const [engine, setEngine] = useState("");
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stopRef = useRef<() => void>(() => {});

  const stop = useCallback(() => {
    stopRef.current();
    stopRef.current = () => {};
    holo.cursors = [];
    setHands(0);
    setRate(0);
    setLagMs(0);
    setEngine("");
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
        // コマ数が多いほど、手を動かしてから届くまでが短い（暗い所ではカメラが自動で減らすことがある）
        .getUserMedia({ video: { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 60, min: 24 }, facingMode: "user" }, audio: false })
        .catch(() => navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: "user" }, audio: false }))
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
      const predictor = new HandPredictor();
      let lastCount = 0;
      /** 最後に使った認識結果の撮影時刻（並行して認識するので、追い越された古い結果は捨てる） */
      let newest = 0;
      let count = 0;
      let rateFrom = performance.now();
      /** カメラの 1 コマを撮ってから結果が届くまで（ミリ秒・平均） */
      let lag = 0;
      const apply = (landmarks: Point[][], capturedAt: number) => {
        const now = performance.now();
        lag = lag ? lag * 0.8 + (now - capturedAt) * 0.2 : now - capturedAt;
        if (capturedAt <= newest) return;
        newest = capturedAt;
        predictor.push(landmarks, capturedAt);
        if (landmarks.length !== lastCount) {
          lastCount = landmarks.length;
          setHands(lastCount);
        }
        // 1 秒あたりの認識回数（小窓に表示）
        count++;
        const span = now - rateFrom;
        if (span >= 1000) {
          setRate(Math.round((count * 1000) / span));
          setLagMs(Math.round(lag));
          count = 0;
          rateFrom = now;
        }
      };

      // 描画のたびに：先読みした「いま」の手の形で操作を読み取り、小窓に今の映像と骨格を描く。
      // （認識は 1 秒に十数回しか届かず、届いたときには手はもう先へ動いているため、先読みで追いつかせる）
      let raf = 0;
      let secondStarted = false;
      /** 画面の描画が重くなったら 2 つ目の認識を止める（認識より画面のなめらかさを優先） */
      let secondOff = false;
      let fpsFrom = 0;
      let fpsFrames = 0;
      const frame = (now: number) => {
        if (stopped) return;
        raf = requestAnimationFrame(frame);
        fpsFrames++;
        if (!fpsFrom) fpsFrom = now;
        else if (now - fpsFrom >= 2000) {
          if (secondStarted && (fpsFrames * 1000) / (now - fpsFrom) < 40) secondOff = true;
          fpsFrom = now;
          fpsFrames = 0;
        }
        const hands = predictor.at(now);
        for (const ev of tracker.update(hands, now)) {
          if (ev.type === "rotate") steerBy(ev.dx, ev.dy);
          else if (ev.type === "zoom") zoomBy(ev.factor);
          else resetView();
        }
        holo.cursors = tracker.cursors;
        draw(canvasRef.current, video, hands, tracker.cursors.map((c) => c.pinching));
      };
      raf = requestAnimationFrame(frame);
      const stopLoops = stopRef.current;
      stopRef.current = () => {
        cancelAnimationFrame(raf);
        stopLoops();
      };

      // 認識：各 Worker は、前の認識が終わってから次のコマを受け取る（重なって溜まらないように）。
      // CPU のコアに余裕がある端末では 2 つの Worker が交互にコマを受け持ち、1 秒あたりの認識回数を倍にする。
      // 送る間隔は全体で FRAME_MS 以上あける（最大で約 30 回/秒）
      let nextSend = 0;
      // CPU / GPU の速さを測って、速い方を使う（GPU は試して速いときだけ。遅ければすぐ CPU に戻して覚えておく）
      const saved = savedPick();
      const tune = { ...saved, trial: false, trialFrom: 0, cpu: 0, cpuN: 0, gpu: 0, gpuN: 0 };
      const setPick = (pick: Delegate, w: Worker) => {
        tune.pick = pick;
        w.postMessage({ type: "delegate", value: pick });
      };
      const decide = (w: Worker, useGpu: boolean) => {
        tune.trial = false;
        if (useGpu) savePick({ pick: "GPU" });
        else {
          tune.gpuBad = true;
          savePick({ pick: "CPU", gpuBad: true });
          if (tune.pick === "GPU") setPick("CPU", w);
          startSecond();
        }
      };
      const learn = (w: Worker, result: WorkerResult) => {
        if (result.ms === undefined) return;
        if (result.delegate === "GPU") {
          tune.gpu = tune.gpuN ? tune.gpu * 0.7 + result.ms * 0.3 : result.ms;
          tune.gpuN++;
        } else {
          tune.cpu = tune.cpuN ? tune.cpu * 0.85 + result.ms * 0.15 : result.ms;
          tune.cpuN++;
        }
        setEngine(`${result.delegate ?? "CPU"} ${Math.round(result.delegate === "GPU" ? tune.gpu : tune.cpu)}ms`);
        // GPU の 1 回が明らかに遅い（CPU の 3 倍以上・0.2 秒以上）→ 待たずにすぐ CPU に戻す
        if (result.delegate === "GPU" && result.ms > Math.max(200, tune.cpu * 3) && (tune.trial || tune.pick === "GPU")) decide(w, false);
        else if (tune.trial) {
          // 試し中：GPU が CPU よりはっきり速いときだけ GPU にする。遅い・作れない（CPU のまま）ならすぐやめる
          if (result.delegate === "GPU" && ((tune.gpuN >= 3 && tune.gpu > tune.cpu * 1.3) || tune.gpuN >= 12)) decide(w, tune.gpu < tune.cpu * 0.8);
          else if (result.delegate !== "GPU" && tune.cpuN - tune.trialFrom > 15) decide(w, false);
        } else if (tune.pick === "CPU" && !tune.gpuBad && tune.cpuN > 20 && tune.cpu > SLOW_INFER_MS) {
          tune.trial = true;
          tune.trialFrom = tune.cpuN;
          tune.gpuN = 0;
          setPick("GPU", w);
        } else if (tune.pick === "GPU" && tune.gpuN >= 8 && tune.gpu > 90) {
          // 前は GPU が速かったのに今は遅い（端末の状態が変わった）→ CPU に戻す
          decide(w, false);
        }
      };
      const run = async (w: Worker, primary: boolean) => {
        while (!stopped) {
          // 2 つ目は、GPU を試している間・GPU を使う間は休む（取り合って測り間違えないように）
          if (!primary && secondOff) return;
          if (!primary && (tune.trial || tune.pick === "GPU")) {
            await new Promise((r) => (timer = window.setTimeout(r, 250)));
            continue;
          }
          const wait = nextSend - performance.now();
          if (wait > 0) await new Promise((r) => (timer = window.setTimeout(r, wait)));
          if (stopped) return;
          if (video.readyState < 2) {
            await new Promise((r) => (timer = window.setTimeout(r, FRAME_MS)));
            continue;
          }
          const began = performance.now();
          nextSend = Math.max(nextSend, began) + FRAME_MS;
          const bitmap = await createImageBitmap(video, { resizeWidth: 384, resizeHeight: 288, resizeQuality: "medium" }).catch(() => null);
          if (!bitmap || stopped) continue;
          const result = await askWorker(w, bitmap, began);
          if (stopped) return;
          apply(result.landmarks, began);
          if (primary) learn(w, result);
        }
      };
      // 2 つ目は、1 つ目が動き出してから裏で準備する（オンにしてから動き出すまでを遅くしない）
      const startSecond = () => {
        if (secondStarted || tune.pick === "GPU") return;
        secondStarted = true;
        void warmSecond().then((w2) => {
          if (w2 && !stopped) void run(w2, false);
        });
      };
      if (worker) {
        void run(worker, true);
        startSecond();
      } else if (landmarker) {
        const lm = landmarker;
        const tick = () => {
          if (stopped) return;
          const began = performance.now();
          if (video.readyState >= 2) apply(lm.detectForVideo(video, began).landmarks, began);
          timer = window.setTimeout(tick, Math.max(0, FRAME_MS - (performance.now() - began)));
        };
        tick();
      }
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
            {status === "ready" ? `${hands ? `HAND ×${hands}` : "NO HAND"}${rate ? ` · ${rate}/s · ${lagMs}ms` : ""}${engine ? ` · ${engine}` : ""}` : "LOADING"}
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
function draw(canvas: HTMLCanvasElement | null, video: CanvasImageSource, hands: Point[][], pinching: boolean[]) {
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
