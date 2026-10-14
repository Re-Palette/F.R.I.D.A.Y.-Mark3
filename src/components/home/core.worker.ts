/**
 * コアの中心の球を、画面とは別の処理で描く（OffscreenCanvas）。
 * 画面の処理が返事の表示・検索・読み込みで忙しくても、球の動きは止まらない・カクつかない。
 * 画面からは、状態・声の大きさ・大きさの変化だけを受け取る。
 */
import { frameStats, QUIET_VOICE, startCore, type CoreInput, type CoreRenderer } from "./core-render";
import { MIN_FRAME_MS, MIN_FRAME_MS_UNFOCUSED } from "@/lib/frame-cap";

type Msg =
  | {
      type: "init";
      canvas: OffscreenCanvas;
      cool: boolean;
      lowPower: boolean;
      still: boolean;
      w: number;
      h: number;
      dpr: number;
      input: Partial<CoreInput> & { focused?: boolean };
      /** なめらかさを測って 2 秒ごとに知らせる（確かめる用） */
      stats?: boolean;
    }
  | { type: "resize"; w: number; h: number; dpr: number }
  | { type: "input"; input: Partial<CoreInput> & { focused?: boolean } }
  | { type: "stop" };

/** Worker の中の self（型は画面用の設定に合わせて、使うものだけ書く） */
const scope = self as unknown as {
  postMessage(m: unknown): void;
  onmessage: ((e: MessageEvent<Msg>) => void) | null;
  close(): void;
  requestAnimationFrame?: (cb: (now: number) => void) => number;
  cancelAnimationFrame?: (id: number) => void;
};

let input: CoreInput = { mode: "idle", voice: QUIET_VOICE, paused: false, localBusy: false };
let focused = true;
let core: CoreRenderer | null = null;

// Worker で画面の更新に合わせて描けない環境では、1 秒 60 回のタイマーで描く
const raf = scope.requestAnimationFrame
  ? (cb: (now: number) => void) => scope.requestAnimationFrame!(cb)
  : (cb: (now: number) => void) => setTimeout(() => cb(performance.now()), 1000 / 60) as unknown as number;
const caf = scope.cancelAnimationFrame ? (id: number) => scope.cancelAnimationFrame!(id) : (id: number) => clearTimeout(id);

function take(next: Partial<CoreInput> & { focused?: boolean }) {
  const { focused: f, ...rest } = next;
  if (typeof f === "boolean") focused = f;
  input = { ...input, ...rest };
}

scope.onmessage = (e: MessageEvent<Msg>) => {
  const d = e.data;
  if (d.type === "init") {
    take(d.input);
    core = startCore(d.canvas, {
      cool: d.cool,
      lowPower: d.lowPower,
      // 画面の処理と取り合わないので、性能の低いパソコンでも毎フレーム描く（重ければ自動で軽くする）
      frameGap: 0,
      still: d.still,
      input: () => input,
      onSlow: () => scope.postMessage({ type: "slow" }),
      tooSoon: (now, last) => now - last < (focused ? MIN_FRAME_MS : MIN_FRAME_MS_UNFOCUSED),
      makeCanvas: () => new OffscreenCanvas(1, 1),
      raf,
      caf,
      onFrame: d.stats ? frameStats((st) => scope.postMessage({ type: "stats", ...st })) : undefined,
    });
    core?.resize(d.w, d.h, d.dpr);
  } else if (d.type === "resize") core?.resize(d.w, d.h, d.dpr);
  else if (d.type === "input") take(d.input);
  else if (d.type === "stop") {
    core?.stop();
    core = null;
    scope.close();
  }
};
