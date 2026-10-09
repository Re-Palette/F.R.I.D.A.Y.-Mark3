"use client";

/**
 * コアの中心：光る太陽と、線でつながった光の点の網（canvas 2D）。F.R.I.D.A.Y. の状態で動きが変わる。
 *   待機：ゆっくり回って呼吸する／聞き取り中：網が波打つ／考え中：速く渦を巻く
 *   検索中：光の帯が上下に走査する／処理中：縮んで広がる／返事中：中心から光の波が広がる
 * 音声モードの間は、実際の声（voiceLevel）に合わせて動く：
 *   大きさ → 明るさ・大きさ・波打ちの強さ／音節の立ち上がり → 中心から光の波が 1 つ広がり、回転が一瞬速まる
 *   抑揚（声が上がる・下がる）→ 球が縦に伸びる・つぶれる／低い声 → 赤道がふくらむ／高い子音 → 表面がきらめく
 * 見えていないとき・タブが裏のときは描かない。動きを減らす設定なら止まった絵を 1 枚だけ描く。
 */
import { memo, useEffect, useRef } from "react";
import { voiceLevel } from "@/lib/voice-level";
import { settled } from "@/lib/settle";

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

/**
 * onSlow：この端末では描画が追いつかない（なめらかに動かない）と分かったときに 1 回だけ呼ぶ。
 * そのあとは自分でも軽い描き方（低い解像度・少ないコマ数）に切り替える。
 */
export const ParticleCore = memo(function ParticleCore({ mode, active, onSlow }: { mode: CoreMode; active: boolean; onSlow?: () => void }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const slowRef = useRef(onSlow);
  slowRef.current = onSlow;

  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx || !active) return;
    const { pts, edges, dust } = makeNetwork();
    const sx = new Float32Array(N);
    const sy = new Float32Array(N);
    const sn = new Float32Array(N);
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let w = 0;
    let h = 0;
    let lite = false;
    /** 1 回描くのに時間がかかる端末では、コマ数ではなく解像度を下げる（動きのなめらかさは落とさない） */
    let lowRes = false;
    // 毎回作ると重い「にじむ光・同心円・細かい粒」と「太陽」は、大きさが変わったときだけ別の canvas に描いておく
    const back = document.createElement("canvas");
    const sun = document.createElement("canvas");
    // 球の立体感（左上の照り・縁の光・右下の影）。網の上に重ねる
    const shade = document.createElement("canvas");
    const prerender = (R: number) => {
      const size = Math.ceil(R * 2.3);
      back.width = back.height = size;
      const b = back.getContext("2d")!;
      const c = size / 2;
      const halo = b.createRadialGradient(c, c, 0, c, c, R * 1.1);
      halo.addColorStop(0, "rgba(255, 160, 50, 0.75)");
      halo.addColorStop(0.4, "rgba(255, 110, 10, 0.35)");
      halo.addColorStop(1, "rgba(255, 80, 0, 0)");
      b.fillStyle = halo;
      b.fillRect(0, 0, size, size);
      b.lineWidth = 0.8;
      b.strokeStyle = "rgba(255, 160, 70, 0.22)";
      for (const k of [0.3, 0.55, 0.8]) {
        b.beginPath();
        b.arc(c, c, R * k, 0, Math.PI * 2);
        b.stroke();
      }
      for (let i = 0; i < DUST; i++) {
        b.fillStyle = `rgba(255, 170, 80, ${(0.15 + dust[i * 3 + 2] * 0.3).toFixed(2)})`;
        b.fillRect(c + dust[i * 3] * R - 0.6, c + dust[i * 3 + 1] * R - 0.6, 1.2, 1.2);
      }
      const sr = Math.ceil(R * 0.6);
      sun.width = sun.height = sr * 2;
      const g = sun.getContext("2d")!;
      const grad = g.createRadialGradient(sr, sr, 0, sr, sr, sr);
      grad.addColorStop(0, "rgba(255, 255, 235, 1)");
      grad.addColorStop(0.12, "rgba(255, 236, 160, 1)");
      grad.addColorStop(0.35, "rgba(255, 170, 50, 0.75)");
      grad.addColorStop(0.7, "rgba(255, 120, 10, 0.3)");
      grad.addColorStop(1, "rgba(255, 100, 0, 0)");
      g.fillStyle = grad;
      g.fillRect(0, 0, sr * 2, sr * 2);

      // 光は左上から：右下を少し暗く、縁に細い光の輪（ガラスの球のふち）、左上に小さな照り
      const hs = Math.ceil(R * 1.05);
      shade.width = shade.height = hs * 2;
      const d = shade.getContext("2d")!;
      d.beginPath();
      d.arc(hs, hs, R, 0, Math.PI * 2);
      d.clip();
      const dark = d.createRadialGradient(hs - R * 0.35, hs - R * 0.4, R * 0.2, hs - R * 0.1, hs - R * 0.12, R * 1.25);
      dark.addColorStop(0, "rgba(0, 0, 0, 0)");
      dark.addColorStop(0.55, "rgba(0, 0, 0, 0)");
      dark.addColorStop(1, "rgba(20, 6, 0, 0.42)");
      d.fillStyle = dark;
      d.fillRect(0, 0, hs * 2, hs * 2);
      const rim = d.createRadialGradient(hs, hs, R * 0.82, hs, hs, R);
      rim.addColorStop(0, "rgba(255, 170, 80, 0)");
      rim.addColorStop(0.85, "rgba(255, 180, 90, 0.16)");
      rim.addColorStop(1, "rgba(255, 210, 150, 0.04)");
      d.fillStyle = rim;
      d.fillRect(0, 0, hs * 2, hs * 2);
      const spec = d.createRadialGradient(hs - R * 0.42, hs - R * 0.46, 0, hs - R * 0.42, hs - R * 0.46, R * 0.42);
      spec.addColorStop(0, "rgba(255, 246, 225, 0.26)");
      spec.addColorStop(0.4, "rgba(255, 220, 170, 0.08)");
      spec.addColorStop(1, "rgba(255, 200, 140, 0)");
      d.fillStyle = spec;
      d.fillRect(0, 0, hs * 2, hs * 2);
    };
    const fit = () => {
      const dpr = lite || lowRes ? 1 : Math.min(1.25, window.devicePixelRatio || 1);
      w = canvas.clientWidth;
      h = canvas.clientHeight;
      canvas.width = Math.max(1, Math.round(w * dpr));
      canvas.height = Math.max(1, Math.round(h * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      prerender(Math.max(1, Math.min(w, h) * RADIUS));
    };
    fit();
    // 返事の欄が伸びていく間などは作り直さず、大きさが落ち着いてから 1 回だけ描き直しの準備をする
    const fitLater = settled(fit);
    const ro = new ResizeObserver(fitLater);
    ro.observe(canvas);

    let angle = 0;
    let glow = TUNE[modeRef.current].glow;
    /** 音節の立ち上がりごとに出す光の波（出た時刻） */
    const ripples: number[] = [];
    let seenOnsets = voiceLevel.onsets;
    /**
     * 聞き取り中・返事中の波の進み具合（位相）。抑揚で波の速さを変えるので、時刻 × 速さではなく、毎フレーム足していく。
     * （時刻 × 速さだと、画面を開いてからの秒数が大きいほど、速さが少し変わっただけで波の位置が大きく飛んで暴れる）
     */
    let listenPhase = 0;
    let speakPhase = 0;
    const RIPPLE_S = 0.75;
    let last = performance.now();
    let raf = 0;
    const cosT = Math.cos(TILT);
    const sinT = Math.sin(TILT);
    const NODE = [
      { lo: -1, hi: 0.45, size: 1.6, color: "rgba(255, 170, 80, 0.45)" },
      { lo: 0.45, hi: 0.8, size: 2.3, color: "rgba(255, 200, 110, 0.75)" },
      { lo: 0.8, hi: 9, size: 3, color: "rgba(255, 238, 170, 1)" },
    ];

    const draw = (now: number) => {
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      // お知らせを読み上げているときも（音声会話でなくても）話している動きにする
      const m: CoreMode = modeRef.current === "idle" && voiceLevel.talking ? "speaking" : modeRef.current;
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
        ctx.strokeStyle = `rgba(255, 150, 50, ${alpha})`;
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
    //   - 画面の更新（requestAnimationFrame）の間隔を 3 秒ごとに測り、平均 22ms を超えたら（45fps 未満）画面の飾りの動きを止めて余裕を回す
    //   - 2 回続けて平均 45ms を超えたら（20fps 未満）、この端末には重いと判断して軽い描き方（30fps）にする
    let gap = 0;
    let drawAvg = 0;
    let prev = 0;
    let sum = 0;
    let frames = 0;
    let windowStart = 0;
    let strikes = 0;
    /** 画面全体が重いと分かって、飾りの動きを止めてもらった */
    let eased = false;
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      if (document.hidden) {
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
            slowRef.current?.(); // 画面の飾りの動きを止めて、全体をなめらかに
          }
          sum = frames = 0;
          windowStart = now;
          if (strikes >= 2) {
            lite = true;
            gap = 32;
            fit();
            slowRef.current?.();
          }
        }
      }
      // ローカル AI（PC の CPU）が答えを作っている間は、1 秒 30 回に抑えて CPU を空ける（それ以上減らすとカクついて見える）
      // 画面の更新の間隔（約 16.7ms）より少し短く比べて、更新 1 回分の誤差でコマを飛ばさないようにする
      const wait = document.body.dataset.localBusy !== undefined ? 32 : gap;
      if (wait && now - last < wait - 4) return;
      const t0 = performance.now();
      draw(now);
      drawAvg = drawAvg * 0.95 + (performance.now() - t0) * 0.05;
      if (!lowRes && !lite && drawAvg > 8) {
        lowRes = true;
        fit();
      }
    };
    if (still) {
      draw(performance.now());
    } else {
      raf = requestAnimationFrame(loop);
    }
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      fitLater.cancel();
    };
  }, [active]);

  return <canvas ref={ref} className="pcore" aria-hidden="true" />;
});
