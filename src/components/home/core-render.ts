/**
 * コアの中心（光る太陽と、線でつながった光の点の網）を描く本体。画面とは別の処理（Worker）でも、画面の処理の中でも同じものを使う。
 *   Worker で描くと、返事を表示している間・検索している間に画面の処理が忙しくても、球の動きがカクつかない。
 *   描く中身・動き方は ParticleCore の説明のとおり。入力（状態・声の大きさ・止めるか）は毎フレーム input() から読む。
 */

export type CoreMode = "idle" | "listening" | "connect" | "think" | "search" | "create" | "speaking";

const SHELL = 190; // 球の表面の点
const INNER = 70; // 内側の点
const N = SHELL + INNER;
const DUST = 220; // 細かい光の粒
const TILT = 0.38;
/** 球の大きさ（canvas の短い辺に対する半径の割合）。周りの太い輪（半径の約 1.38 倍）との間に、動くための余白を取る */
const RADIUS = 0.4;
/** 声に合わせて広がっても、ここまで（RADIUS × CAP ≒ canvas の端・太い輪の内側）に収める */
const CAP = 1.22;
/** 1 を超えた分をなめらかに頭打ちにする（小さな動きはそのまま、大きな動きほど抑える） */
const soft = (k: number) => (k <= 1 ? k : 1 + (CAP - 1) * Math.tanh((k - 1) / (CAP - 1)));

/** 状態ごとの回る速さ（rad/s）・明るさ */
const TUNE: Record<CoreMode, { spin: number; glow: number }> = {
  idle: { spin: 0.14, glow: 0.8 },
  listening: { spin: 0.22, glow: 0.95 },
  connect: { spin: 0.4, glow: 0.95 },
  think: { spin: 0.65, glow: 1 },
  search: { spin: 0.34, glow: 1 },
  create: { spin: 0.28, glow: 1.1 },
  speaking: { spin: 0.28, glow: 1.1 },
};

function makeNetwork() {
  const pts = new Float32Array(N * 3);
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < SHELL; i++) {
    const y = 1 - (i / (SHELL - 1)) * 2;
    const r = Math.sqrt(1 - y * y);
    pts[i * 3] = Math.cos(i * golden) * r;
    pts[i * 3 + 1] = y;
    pts[i * 3 + 2] = Math.sin(i * golden) * r;
  }
  for (let i = SHELL; i < N; i++) {
    // 内側：中心に寄りすぎない位置にばらまく
    const u = Math.random() * 2 - 1;
    const a = Math.random() * Math.PI * 2;
    const r = 0.35 + Math.random() * 0.5;
    const s = Math.sqrt(1 - u * u);
    pts[i * 3] = Math.cos(a) * s * r;
    pts[i * 3 + 1] = u * r;
    pts[i * 3 + 2] = Math.sin(a) * s * r;
  }
  // それぞれ近い 3 点と線でつなぐ（重複は除く）
  const edges: number[] = [];
  const seen = new Set<number>();
  for (let i = 0; i < N; i++) {
    const near: [number, number][] = [];
    for (let j = 0; j < N; j++) {
      if (i === j) continue;
      const dx = pts[i * 3] - pts[j * 3];
      const dy = pts[i * 3 + 1] - pts[j * 3 + 1];
      const dz = pts[i * 3 + 2] - pts[j * 3 + 2];
      near.push([dx * dx + dy * dy + dz * dz, j]);
    }
    near.sort((a, b) => a[0] - b[0]);
    for (const [, j] of near.slice(0, 3)) {
      const key = Math.min(i, j) * N + Math.max(i, j);
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push(i, j);
    }
  }
  const dust = new Float32Array(DUST * 3);
  for (let i = 0; i < DUST; i++) {
    const a = Math.random() * Math.PI * 2;
    const r = Math.sqrt(Math.random()) * 1.05;
    dust[i * 3] = Math.cos(a) * r;
    dust[i * 3 + 1] = Math.sin(a) * r;
    dust[i * 3 + 2] = Math.random();
  }
  return { pts, edges: Uint16Array.from(edges), dust };
}

export interface CoreVoice {
  value: number;
  low: number;
  mid: number;
  high: number;
  inflection: number;
  onset: number;
  onsets: number;
  talking: boolean;
}

export interface CoreInput {
  mode: CoreMode;
  voice: CoreVoice;
  /** 描かない（タブが裏・切り替えの演出が覆っている・画面に出ていない） */
  paused: boolean;
  /** ローカル AI（PC の CPU）が答えを作っている（1 秒 30 回に抑えて CPU を空ける） */
  localBusy: boolean;
}

export const QUIET_VOICE: CoreVoice = { value: 0, low: 0, mid: 0, high: 0, inflection: 0, onset: 0, onsets: 0, talking: false };

type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
type AnyCanvas = HTMLCanvasElement | OffscreenCanvas;

export interface CoreOptions {
  cool: boolean;
  /** 性能の低いパソコン（最初から解像度を等倍にする） */
  lowPower: boolean;
  /** 最初のコマの間隔（0 = 画面の更新ごと。32 = 1 秒 30 回） */
  frameGap: number;
  /** 動きを減らす設定：止まった絵を 1 枚だけ描く */
  still: boolean;
  input: () => CoreInput;
  /** 描くのが追いつかないと分かったとき（1 回だけ） */
  onSlow: () => void;
  /** 前に描いてから、まだ描かなくてよいか（ほかのアプリを使っている間はコマ数を減らすなど） */
  tooSoon: (now: number, last: number) => boolean;
  makeCanvas: () => AnyCanvas;
  raf: (cb: (now: number) => void) => number;
  caf: (id: number) => void;
  /** 1 枚描くたびに呼ぶ（なめらかさを測る用） */
  onFrame?: (now: number) => void;
}

export interface CoreRenderer {
  /** 表示の大きさ（CSS の px）と画素の細かさ */
  resize(w: number, h: number, dpr: number): void;
  stop(): void;
}

export function startCore(canvas: AnyCanvas, opts: CoreOptions): CoreRenderer | null {
  const ctx = canvas.getContext("2d") as Ctx2D | null;
  if (!ctx) return null;
  const { cool } = opts;
  const { pts, edges, dust } = makeNetwork();
  const col = (r: number, g: number, b: number, a: number) => (cool ? `rgba(${b}, ${g}, ${r}, ${a})` : `rgba(${r}, ${g}, ${b}, ${a})`);
  const sx = new Float32Array(N);
  const sy = new Float32Array(N);
  const sn = new Float32Array(N);
  let w = 0;
  let h = 0;
  let lite = false;
  /** 1 回描くのに時間がかかる端末では、コマ数ではなく解像度を下げる（動きのなめらかさは落とさない） */
  // 性能の低いパソコンでは、初めから解像度を等倍にする（見た目は同じ。描く量が減る）
  let lowRes = opts.lowPower;
  // 毎回作ると重い「にじむ光・同心円・細かい粒」と「太陽」は、大きさが変わったときだけ別の canvas に描いておく
  const back = opts.makeCanvas();
  const sun = opts.makeCanvas();
  // 球の立体感（左上の照り・縁の光・右下の影）。網の上に重ねる
  const shade = opts.makeCanvas();
  const prerender = (R: number) => {
    const size = Math.ceil(R * 2.3);
    back.width = back.height = size;
    const b = back.getContext("2d") as Ctx2D;
    const c = size / 2;
    const halo = b.createRadialGradient(c, c, 0, c, c, R * 1.1);
    halo.addColorStop(0, col(255, 160, 50, 0.75));
    halo.addColorStop(0.4, col(255, 110, 10, 0.35));
    halo.addColorStop(1, col(255, 80, 0, 0));
    b.fillStyle = halo;
    b.fillRect(0, 0, size, size);
    b.lineWidth = 0.8;
    b.strokeStyle = col(255, 160, 70, 0.22);
    for (const k of [0.3, 0.55, 0.8]) {
      b.beginPath();
      b.arc(c, c, R * k, 0, Math.PI * 2);
      b.stroke();
    }
    for (let i = 0; i < DUST; i++) {
      b.fillStyle = col(255, 170, 80, +(0.15 + dust[i * 3 + 2] * 0.3).toFixed(2));
      b.fillRect(c + dust[i * 3] * R - 0.6, c + dust[i * 3 + 1] * R - 0.6, 1.2, 1.2);
    }
    const sr = Math.ceil(R * 0.6);
    sun.width = sun.height = sr * 2;
    const g = sun.getContext("2d") as Ctx2D;
    const grad = g.createRadialGradient(sr, sr, 0, sr, sr, sr);
    grad.addColorStop(0, col(255, 255, 235, 1));
    grad.addColorStop(0.12, col(255, 236, 160, 1));
    grad.addColorStop(0.35, col(255, 170, 50, 0.75));
    grad.addColorStop(0.7, col(255, 120, 10, 0.3));
    grad.addColorStop(1, col(255, 100, 0, 0));
    g.fillStyle = grad;
    g.fillRect(0, 0, sr * 2, sr * 2);

    // 光は左上から：右下を少し暗く、縁に細い光の輪（ガラスの球のふち）、左上に小さな照り
    const hs = Math.ceil(R * 1.05);
    shade.width = shade.height = hs * 2;
    const d = shade.getContext("2d") as Ctx2D;
    d.beginPath();
    d.arc(hs, hs, R, 0, Math.PI * 2);
    d.clip();
    const dark = d.createRadialGradient(hs - R * 0.35, hs - R * 0.4, R * 0.2, hs - R * 0.1, hs - R * 0.12, R * 1.25);
    dark.addColorStop(0, col(0, 0, 0, 0));
    dark.addColorStop(0.55, col(0, 0, 0, 0));
    dark.addColorStop(1, col(20, 6, 0, 0.42));
    d.fillStyle = dark;
    d.fillRect(0, 0, hs * 2, hs * 2);
    const rim = d.createRadialGradient(hs, hs, R * 0.82, hs, hs, R);
    rim.addColorStop(0, col(255, 170, 80, 0));
    rim.addColorStop(0.85, col(255, 180, 90, 0.16));
    rim.addColorStop(1, col(255, 210, 150, 0.04));
    d.fillStyle = rim;
    d.fillRect(0, 0, hs * 2, hs * 2);
    const spec = d.createRadialGradient(hs - R * 0.42, hs - R * 0.46, 0, hs - R * 0.42, hs - R * 0.46, R * 0.42);
    spec.addColorStop(0, col(255, 246, 225, 0.26));
    spec.addColorStop(0.4, col(255, 220, 170, 0.08));
    spec.addColorStop(1, col(255, 200, 140, 0));
    d.fillStyle = spec;
    d.fillRect(0, 0, hs * 2, hs * 2);
  };
  let cssDpr = 1;
  const fit = () => {
    const dpr = lite || lowRes ? 1 : Math.min(1.25, cssDpr || 1);
    canvas.width = Math.max(1, Math.round(w * dpr));
    canvas.height = Math.max(1, Math.round(h * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    prerender(Math.max(1, Math.min(w, h) * RADIUS));
  };

  let angle = 0;
  let glow = TUNE[opts.input().mode].glow;
  /** 音節の立ち上がりごとに出す光の波（出た時刻） */
  const ripples: number[] = [];
  let seenOnsets = opts.input().voice.onsets;
  /**
   * 聞き取り中・返事中の波の進み具合（位相）。抑揚で波の速さを変えるので、時刻 × 速さではなく、毎フレーム足していく。
   * （時刻 × 速さだと、画面を開いてからの秒数が大きいほど、速さが少し変わっただけで波の位置が大きく飛んで暴れる）
   */
  let listenPhase = 0;
  let speakPhase = 0;
  const RIPPLE_S = 0.75;
  let last = performance.now();
  const cosT = Math.cos(TILT);
  const sinT = Math.sin(TILT);
  const NODE = [
    { lo: -1, hi: 0.45, size: 1.6, color: col(255, 170, 80, 0.45) },
    { lo: 0.45, hi: 0.8, size: 2.3, color: col(255, 200, 110, 0.75) },
    { lo: 0.8, hi: 9, size: 3, color: col(255, 238, 170, 1) },
  ];

  const draw = (now: number) => {
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    const input = opts.input();
    const voiceLevel = input.voice;
    // お知らせを読み上げているときも（音声会話でなくても）話している動きにする
    const m: CoreMode = input.mode === "idle" && voiceLevel.talking ? "speaking" : input.mode;
    const tune = TUNE[m];
    // 声の大きさ（音声モードの間だけ。0〜1）。声に合わせて明るく・大きく脈打つ
    const lv = voiceLevel.value;
    const { low, mid, high, inflection, onset } = voiceLevel;
    const g = Math.min(1, lv * 2.5); // 声が出ているほど、声の中身（抑揚など）を強く映す
    // 音節が立ち上がるたびに、回転が一瞬速まる
    angle += (tune.spin + lv * 0.25 + onset * 1.4) * dt;
    glow += (tune.glow + lv * 0.35 + inflection * 0.12 * g - glow) * Math.min(1, dt * 3); // 明るさはなめらかに変える
    const t = now / 1000;
    // 音節の立ち上がりごとに光の波を 1 つ出す（古いものは消す）
    if (voiceLevel.onsets !== seenOnsets) {
      seenOnsets = voiceLevel.onsets;
      ripples.push(t);
      if (ripples.length > 4) ripples.shift();
    }
    while (ripples.length && t - ripples[0] > RIPPLE_S) ripples.shift();
    // 抑揚：声が上がると縦に伸び、下がると少しつぶれる
    listenPhase = (listenPhase + dt * (6 + inflection * 2)) % (Math.PI * 2);
    speakPhase = (speakPhase + dt * (9 + inflection * 3)) % (Math.PI * 2);
    const stretchY = 1 + inflection * 0.1 * g;
    const stretchX = 1 - inflection * 0.04 * g;
    const cx = w / 2;
    const cy = h / 2;
    const R = Math.min(w, h) * RADIUS;
    const breath = 1 + Math.sin(t * 1.1) * 0.02 + lv * (m === "speaking" ? 0.1 : 0.07);
    const scan = Math.sin(t * 1.6); // 検索中の光の帯の高さ
    const wave = (t * 0.9) % 1; // 返事中の光の波

    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = 1;
    ctx.clearRect(0, 0, w, h);

    // にじむ光・同心円・細かい粒（描いておいた絵を呼吸に合わせて少し拡大して貼る）
    ctx.globalAlpha = Math.min(1, glow);
    const bs = back.width * breath;
    ctx.drawImage(back, cx - bs / 2, cy - bs / 2, bs, bs);
    ctx.globalAlpha = 1;

    // 網の点を回して画面上の位置を出す
    const cosA = Math.cos(angle);
    const sinA = Math.sin(angle);
    for (let i = 0; i < N; i++) {
      let x = pts[i * 3];
      const y0 = pts[i * 3 + 1];
      let z = pts[i * 3 + 2];
      let s = breath;
      if (g > 0.01) {
        // 低い声は赤道をふくらませ、高い子音は表面の点をきらめかせる
        s *= 1 + low * 0.07 * g * (1 - y0 * y0) + high * 0.05 * g * Math.sin(t * 17 + i * 1.7);
      }
      let ring = 0;
      if (ripples.length) {
        // 音節の光の波：中心から外へ広がる輪の近くの点を押し出して光らせる
        const d = Math.hypot(x, y0, z);
        for (const r0 of ripples) {
          const a = (t - r0) / RIPPLE_S;
          const near = Math.exp(-(((d - a * 1.25) * 5) ** 2)) * (1 - a);
          ring = Math.max(ring, near);
        }
        s *= 1 + ring * 0.09;
      }
      if (m === "think") {
        const tw = y0 * Math.sin(t * 0.8) * 0.9;
        const c = Math.cos(tw);
        const d = Math.sin(tw);
        [x, z] = [x * c - z * d, x * d + z * c];
      } else if (m === "listening") {
        // 聞いている間は、声が大きいほど表面が大きく波打つ
        s *= 1 + (0.03 + lv * 0.12 + mid * 0.1) * Math.sin(listenPhase + y0 * 5 + x * 3);
      } else if (m === "speaking") {
        // 話している間は、声の大きさに合わせて中心から外へ波が広がるように脈打つ
        const d = Math.hypot(x, y0, z);
        s *= 1 + lv * 0.1 + (0.015 + lv * 0.08 + mid * 0.07) * Math.sin(speakPhase - d * 5);
      } else if (m === "connect") {
        s *= 0.9 + 0.1 * Math.sin(t * 3);
      }
      const rx = x * cosA - z * sinA;
      const rz = x * sinA + z * cosA;
      const ry = y0 * cosT - rz * sinT;
      const pz = y0 * sinT + rz * cosT;
      // どれだけ動いても、周りの輪から飛び出さないように頭打ちにする
      sx[i] = cx + rx * R * soft(s * stretchX);
      sy[i] = cy + ry * R * soft(s * stretchY);
      let n = (pz + 1) / 2 + ring * 0.7; // 0 奥 … 1 手前（音節の光の波の上は明るく）
      if (m === "search") n += Math.max(0, 1 - Math.abs(ry * s - scan) * 5) * 0.9;
      else if (m === "create" || m === "speaking") n += Math.max(0, 1 - Math.abs(Math.hypot(rx, ry) * s - wave * 1.1) * 7) * 0.8;
      sn[i] = n;
    }

    // 線と点は、明るさ 3 段階ごとにまとめて描く（色の切り替えを減らして軽く）
    ctx.globalAlpha = Math.min(1, glow);
    for (const [lo, hi, alpha] of [
      [-1, 0.45, 0.16],
      [0.45, 0.8, 0.34],
      [0.8, 9, 0.6],
    ] as const) {
      ctx.strokeStyle = col(255, 150, 50, alpha);
      ctx.lineWidth = alpha > 0.5 ? 1.1 : 0.8;
      ctx.beginPath();
      for (let e = 0; e < edges.length; e += 2) {
        const a = edges[e];
        const b = edges[e + 1];
        const n = (sn[a] + sn[b]) / 2;
        if (n < lo || n >= hi) continue;
        ctx.moveTo(sx[a], sy[a]);
        ctx.lineTo(sx[b], sy[b]);
      }
      ctx.stroke();
    }
    for (const k of NODE) {
      ctx.fillStyle = k.color;
      const hs = k.size / 2;
      for (let i = 0; i < N; i++) {
        if (sn[i] < k.lo || sn[i] >= k.hi) continue;
        ctx.fillRect(sx[i] - hs, sy[i] - hs, k.size, k.size);
      }
    }

    // 球の立体感（照り・縁の光・影）。球と一緒に呼吸する
    const hz = shade.width * breath;
    ctx.drawImage(shade, cx - hz / 2, cy - hz / 2, hz, hz);

    // 中心の太陽（描いておいた絵を脈に合わせて拡大して貼る。ここだけ光を足し合わせる）
    ctx.globalCompositeOperation = "lighter";
    ctx.globalAlpha = Math.min(1, glow);
    const ss = sun.width * (1 + Math.sin(t * 2.2) * 0.04 * glow + lv * 0.25 + onset * 0.15);
    ctx.drawImage(sun, cx - ss / 2, cy - ss / 2, ss, ss);
    ctx.globalAlpha = 1;
  };

  // なめらかに見えるよう、いつも毎フレーム（画面の更新ごと）描く。コマを飛ばすと動きがカクつくので、重いときは先に解像度を下げる。
  //   - 1 回描くのに 8ms を超えるようなら、解像度を下げる（コマ数はそのまま）
  //   - 画面の更新の間隔を 3 秒ごとに測り、平均 22ms を超えたら（45fps 未満）画面の飾りの動きを止めて余裕を回す
  //   - 2 回続けて平均 45ms を超えたら（20fps 未満）、この端末には重いと判断して軽い描き方（30fps）にする
  let gap = opts.frameGap;
  let drawAvg = 0;
  let prev = 0;
  let sum = 0;
  let frames = 0;
  let windowStart = 0;
  let strikes = 0;
  let eased = false;
  let raf = 0;
  let stopped = false;
  const loop = (now: number) => {
    if (stopped) return;
    raf = opts.raf(loop);
    const input = opts.input();
    // 裏にある間・切り替えの演出が覆っている間は描かない（重さの見張りも数えない）
    if (input.paused || !w || !h) {
      prev = 0;
      return;
    }
    if (!lite) {
      if (prev) {
        sum += now - prev;
        frames++;
      } else windowStart = now;
      prev = now;
      if (now - windowStart > 3000 && frames) {
        const avg = sum / frames;
        strikes = avg > 45 ? strikes + 1 : 0;
        if (avg > 22 && !eased) {
          eased = true;
          opts.onSlow(); // 画面の飾りの動きを止めて、全体をなめらかに
        }
        sum = frames = 0;
        windowStart = now;
        if (strikes >= 2) {
          lite = true;
          gap = 32;
          fit();
          opts.onSlow();
        }
      }
    }
    // ローカル AI（PC の CPU）が答えを作っている間は、1 秒 30 回に抑えて CPU を空ける（それ以上減らすとカクついて見える）
    // 画面の更新の間隔（約 16.7ms）より少し短く比べて、更新 1 回分の誤差でコマを飛ばさないようにする
    const wait = input.localBusy ? 32 : gap;
    if (wait ? now - last < wait - 4 : opts.tooSoon(now, last)) return;
    const t0 = performance.now();
    draw(now);
    opts.onFrame?.(now);
    drawAvg = drawAvg * 0.95 + (performance.now() - t0) * 0.05;
    if (!lowRes && !lite && drawAvg > 8) {
      lowRes = true;
      fit();
    }
  };

  return {
    resize(nw, nh, dpr) {
      w = nw;
      h = nh;
      cssDpr = dpr;
      fit();
      if (opts.still) draw(performance.now());
      else if (!raf) raf = opts.raf(loop);
    },
    stop() {
      stopped = true;
      opts.caf(raf);
    },
  };
}

/** なめらかさを測る（描いた枚数・いちばん空いた間隔を 2 秒ごとに知らせる。確かめる用） */
export function frameStats(report: (s: { fps: number; maxGap: number }) => void): (now: number) => void {
  let from = 0;
  let prev = 0;
  let frames = 0;
  let max = 0;
  return (now) => {
    if (prev) max = Math.max(max, now - prev);
    prev = now;
    frames++;
    if (!from) from = now;
    if (now - from >= 2000) {
      report({ fps: Math.round((frames * 1000) / (now - from)), maxGap: Math.round(max) });
      from = now;
      frames = 0;
      max = 0;
    }
  };
}
