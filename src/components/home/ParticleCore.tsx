"use client";

/**
 * コアの中心：光る太陽と、線でつながった光の点の網（canvas 2D）。F.R.I.D.A.Y. の状態で動きが変わる。
 *   待機：ゆっくり回って呼吸する／聞き取り中：網が波打つ／考え中：速く渦を巻く
 *   検索中：光の帯が上下に走査する／処理中：縮んで広がる／返事中：中心から光の波が広がる
 * 音声モードの間は、実際の声（voiceLevel）に合わせて動く：
 *   大きさ → 明るさ・大きさ・波打ちの強さ／音節の立ち上がり → 中心から光の波が 1 つ広がり、回転が一瞬速まる
 *   抑揚（声が上がる・下がる）→ 球が縦に伸びる・つぶれる／低い声 → 赤道がふくらむ／高い子音 → 表面がきらめく
 * 見えていないとき・タブが裏のときは描かない。動きを減らす設定なら止まった絵を 1 枚だけ描く。
 * 描くのは画面とは別の処理（Worker・OffscreenCanvas）。返事の表示・検索などで画面の処理が忙しくても、球はなめらかに動き続ける。
 * Worker が使えないブラウザでは、これまでどおり画面の処理の中で描く（描き方は core-render で共通）。
 */
import { isLowPowerDevice } from "@/lib/low-power";
import { memo, useEffect, useRef, useState } from "react";
import { voiceLevel } from "@/lib/voice-level";
import { resizeWorthIt, settled } from "@/lib/settle";
import { isScreenCovered } from "@/lib/screen-cover";
import { tooSoon } from "@/lib/frame-cap";
import { frameStats, startCore, type CoreInput, type CoreMode, type CoreRenderer, type CoreVoice } from "./core-render";

export type { CoreMode } from "./core-render";

/** Worker で描けなかった（作れない・途中で落ちた）ら、以後は画面の処理の中で描く */
let workerBroken = false;

function canUseWorker(): boolean {
  if (workerBroken || typeof Worker === "undefined" || typeof OffscreenCanvas === "undefined") return false;
  if (!("transferControlToOffscreen" in HTMLCanvasElement.prototype)) return false;
  try {
    // 確かめる用：localStorage "friday.core-worker" = "0" で画面の処理の中で描く
    if (localStorage.getItem("friday.core-worker") === "0") return false;
  } catch {
    /* 使えなくてもよい */
  }
  return true;
}

const voiceNow = (): CoreVoice => ({
  value: voiceLevel.value,
  low: voiceLevel.low,
  mid: voiceLevel.mid,
  high: voiceLevel.high,
  inflection: voiceLevel.inflection,
  onset: voiceLevel.onset,
  onsets: voiceLevel.onsets,
  talking: voiceLevel.talking,
});
const pausedNow = () => document.hidden || isScreenCovered();
const busyNow = () => document.body.dataset.localBusy !== undefined;

/**
 * onSlow：この端末では描画が追いつかない（なめらかに動かない）と分かったときに 1 回だけ呼ぶ。
 * そのあとは自分でも軽い描き方（低い解像度・少ないコマ数）に切り替える。
 */
export const ParticleCore = memo(function ParticleCore({
  mode,
  active,
  onSlow,
  cool = false,
}: {
  mode: CoreMode;
  active: boolean;
  onSlow?: () => void;
  /** 青い色合いで描く（K.A.R.E.N.）。暖色の赤と青を入れ替えるので、光り方・明るさはそのまま */
  cool?: boolean;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const slowRef = useRef(onSlow);
  slowRef.current = onSlow;
  /** Worker に渡した canvas は二度と使えないので、描き直すたびに新しい canvas にする */
  const [gen, setGen] = useState(0);
  const sendRef = useRef<((input: Partial<CoreInput>) => void) | null>(null);

  useEffect(() => {
    sendRef.current?.({ mode });
  }, [mode]);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || !active) return;
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const lowPower = isLowPowerDevice();
    const dpr = () => window.devicePixelRatio || 1;
    let drawn: { w: number; h: number } | null = null;
    let resize: (w: number, h: number) => void = () => {};
    const fit = (force = false) => {
      // 少し縮んだ・伸びただけなら作り直さない（CSS で伸び縮みする。描く位置は前の大きさのまま比率で合う）
      if (!force && !resizeWorthIt(drawn, canvas.clientWidth, canvas.clientHeight)) return;
      drawn = { w: canvas.clientWidth, h: canvas.clientHeight };
      resize(drawn.w, drawn.h);
    };
    let stop = () => {};
    let stats = false;
    try {
      stats = localStorage.getItem("friday.core-stats") === "1";
    } catch {
      /* 使えなくてもよい */
    }
    const pushStats = (st: object) => (window as unknown as { __coreStats?: unknown[] }).__coreStats?.push(st);

    if (!still && canUseWorker()) {
      // ---- 別の処理（Worker）で描く ----
      let worker: Worker;
      let off: OffscreenCanvas;
      try {
        worker = new Worker(new URL("./core.worker.ts", import.meta.url), { type: "module" });
      } catch {
        workerBroken = true;
        setGen((g) => g + 1);
        return;
      }
      try {
        off = canvas.transferControlToOffscreen();
      } catch {
        // すでに渡した canvas（作り直しの途中）。新しい canvas ができてから始める
        worker.terminate();
        setGen((g) => g + 1);
        return;
      }
      worker.onmessage = (e: MessageEvent<{ type: string; fps?: number; maxGap?: number }>) => {
        if (e.data.type === "slow") slowRef.current?.();
        else if (e.data.type === "stats") pushStats(e.data);
      };
      worker.onerror = () => {
        // Worker が動かなかった：この canvas は渡してしまったので、新しい canvas で画面の処理の中で描き直す
        workerBroken = true;
        worker.terminate();
        setGen((g) => g + 1);
      };
      const send = (input: Partial<CoreInput> & { focused?: boolean }) => worker.postMessage({ type: "input", input });
      sendRef.current = send;
      worker.postMessage(
        {
          type: "init",
          canvas: off,
          cool,
          lowPower,
          still,
          w: canvas.clientWidth,
          h: canvas.clientHeight,
          dpr: dpr(),
          stats,
          input: { mode: modeRef.current, voice: voiceNow(), paused: pausedNow(), localBusy: busyNow(), focused: document.hasFocus() },
        },
        [off],
      );
      drawn = { w: canvas.clientWidth, h: canvas.clientHeight };
      resize = (w, h) => worker.postMessage({ type: "resize", w, h, dpr: dpr() });

      // 声の大きさ・止めるか・ローカル AI が忙しいかを、変わったときだけ Worker に伝える
      // （ここが遅れても、球の回転・呼吸は Worker の側で動き続ける）
      let last = { voice: voiceNow(), paused: pausedNow(), localBusy: busyNow(), focused: document.hasFocus() };
      let raf = 0;
      const watch = () => {
        raf = requestAnimationFrame(watch);
        const v = voiceLevel;
        const lv = last.voice;
        const next: Partial<CoreInput> & { focused?: boolean } = {};
        if (v.value !== lv.value || v.onsets !== lv.onsets || v.talking !== lv.talking || v.inflection !== lv.inflection || v.onset !== lv.onset || v.mid !== lv.mid) {
          next.voice = voiceNow();
        }
        const p = pausedNow();
        const b = busyNow();
        const f = document.hasFocus();
        if (p !== last.paused) next.paused = p;
        if (b !== last.localBusy) next.localBusy = b;
        if (f !== last.focused) next.focused = f;
        if (next.voice || next.paused !== undefined || next.localBusy !== undefined || next.focused !== undefined) {
          last = { voice: next.voice ?? last.voice, paused: p, localBusy: b, focused: f };
          send(next);
        }
      };
      raf = requestAnimationFrame(watch);
      // タブが裏に回ったときは、画面の更新が止まる前にすぐ伝える
      const onVis = () => {
        last.paused = pausedNow();
        send({ paused: last.paused });
      };
      document.addEventListener("visibilitychange", onVis);
      stop = () => {
        cancelAnimationFrame(raf);
        document.removeEventListener("visibilitychange", onVis);
        sendRef.current = null;
        worker.postMessage({ type: "stop" });
        // 渡した canvas はもう使えないので、次に描くときは新しい canvas にする
        setGen((g) => g + 1);
      };
    } else {
      // ---- 画面の処理の中で描く（Worker が使えないとき） ----
      const renderer: CoreRenderer | null = startCore(canvas, {
        cool,
        lowPower,
        // 性能の低いパソコンでは、初めから 1 秒 30 回に抑える（画面の処理と取り合うため）
        frameGap: lowPower ? 32 : 0,
        still,
        input: () => ({ mode: modeRef.current, voice: voiceLevel, paused: pausedNow(), localBusy: busyNow() }),
        onSlow: () => slowRef.current?.(),
        tooSoon,
        makeCanvas: () => document.createElement("canvas"),
        raf: (cb) => requestAnimationFrame(cb),
        caf: (id) => cancelAnimationFrame(id),
        onFrame: stats ? frameStats(pushStats) : undefined,
      });
      if (!renderer) return;
      resize = (w, h) => renderer.resize(w, h, dpr());
      fit(true);
      stop = () => renderer.stop();
    }

    // 返事の欄が伸びていく間などは作り直さず、大きさが落ち着いてから 1 回だけ描き直しの準備をする
    const fitLater = settled(() => fit());
    const ro = new ResizeObserver(fitLater);
    ro.observe(canvas);
    return () => {
      ro.disconnect();
      fitLater.cancel();
      stop();
    };
  }, [active, cool, gen]);

  return <canvas key={gen} ref={ref} className="pcore" aria-hidden="true" />;
});
