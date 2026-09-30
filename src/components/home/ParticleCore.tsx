"use client";

/**
 * コアの中心で光る粒の球（canvas 2D）。F.R.I.D.A.Y. の状態で動きが変わる。
 *   待機：ゆっくり回って呼吸する／聞き取り中：表面が波打つ／考え中：速く渦を巻く
 *   検索中：光の帯が上下に走査する／処理中：縮んで広がる／返事中：中心から光の波が広がる
 * 見えていないとき・タブが裏のときは描かない。動きを減らす設定なら止まった絵を 1 枚だけ描く。
 */
import { useEffect, useRef } from "react";

export type CoreMode = "idle" | "listening" | "connect" | "think" | "search" | "create" | "speaking";

const N = 820;
const TILT = 0.38;

/** 状態ごとの回る速さ（rad/s）・明るさ */
const TUNE: Record<CoreMode, { spin: number; glow: number }> = {
  idle: { spin: 0.16, glow: 0.62 },
  listening: { spin: 0.24, glow: 0.8 },
  connect: { spin: 0.42, glow: 0.82 },
  think: { spin: 0.7, glow: 0.9 },
  search: { spin: 0.36, glow: 0.86 },
  create: { spin: 0.3, glow: 1 },
  speaking: { spin: 0.3, glow: 1 },
};

function makePoints() {
  const pts = new Float32Array(N * 4); // x, y, z, 半径の揺らぎ
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < N; i++) {
    const y = 1 - (i / (N - 1)) * 2;
    const r = Math.sqrt(1 - y * y);
    const a = i * golden;
    // 7 割は表面、3 割は内側に散らして奥行きを出す
    const depth = i % 10 < 7 ? 0.94 + Math.random() * 0.08 : 0.25 + Math.random() * 0.6;
    pts[i * 4] = Math.cos(a) * r;
    pts[i * 4 + 1] = y;
    pts[i * 4 + 2] = Math.sin(a) * r;
    pts[i * 4 + 3] = depth;
  }
  return pts;
}

export function ParticleCore({ mode, active }: { mode: CoreMode; active: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const modeRef = useRef(mode);
  modeRef.current = mode;

  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx || !active) return;
    const pts = makePoints();
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let w = 0;
    let h = 0;
    const fit = () => {
      const dpr = Math.min(1.5, window.devicePixelRatio || 1);
      w = canvas.clientWidth;
      h = canvas.clientHeight;
      canvas.width = Math.max(1, Math.round(w * dpr));
      canvas.height = Math.max(1, Math.round(h * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(canvas);

    let angle = 0;
    let glow = TUNE[modeRef.current].glow;
    let last = performance.now();
    let raf = 0;
    const cosT = Math.cos(TILT);
    const sinT = Math.sin(TILT);

    const draw = (now: number) => {
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      const m = modeRef.current;
      const tune = TUNE[m];
      angle += tune.spin * dt;
      glow += (tune.glow - glow) * Math.min(1, dt * 3); // 明るさはなめらかに変える
      const t = now / 1000;
      const cx = w / 2;
      const cy = h / 2;
      const R = Math.min(w, h) * 0.38;

      ctx.globalCompositeOperation = "source-over";
      ctx.clearRect(0, 0, w, h);
      // 中心の光
      const halo = ctx.createRadialGradient(cx, cy, 0, cx, cy, R * 1.5);
      halo.addColorStop(0, `rgba(255, 236, 205, ${0.85 * glow})`);
      halo.addColorStop(0.12, `rgba(255, 170, 80, ${0.55 * glow})`);
      halo.addColorStop(0.45, `rgba(255, 110, 20, ${0.18 * glow})`);
      halo.addColorStop(1, "rgba(255, 90, 0, 0)");
      ctx.fillStyle = halo;
      ctx.fillRect(0, 0, w, h);

      ctx.globalCompositeOperation = "lighter";
      const breath = 1 + Math.sin(t * 1.1) * 0.025;
      const scan = Math.sin(t * 1.6); // 検索中の光の帯の高さ
      const wave = (t * 0.9) % 1; // 返事中の光の波
      const cosA = Math.cos(angle);
      const sinA = Math.sin(angle);
      for (let i = 0; i < N; i++) {
        let x = pts[i * 4];
        const y0 = pts[i * 4 + 1];
        let z = pts[i * 4 + 2];
        let s = pts[i * 4 + 3] * breath;
        if (m === "think") {
          // 高さで回る角度をずらして渦を巻く
          const tw = y0 * Math.sin(t * 0.8) * 0.9;
          const c = Math.cos(tw);
          const d = Math.sin(tw);
          [x, z] = [x * c - z * d, x * d + z * c];
        } else if (m === "listening") {
          s *= 1 + 0.07 * Math.sin(t * 6 + y0 * 5 + x * 3);
        } else if (m === "connect") {
          s *= 0.9 + 0.1 * Math.sin(t * 3);
        }
        // 回転（縦軸）→ 手前へ傾ける
        const rx = x * cosA - z * sinA;
        const rz = x * sinA + z * cosA;
        const ry = y0 * cosT - rz * sinT;
        const pz = y0 * sinT + rz * cosT;
        const px = cx + rx * R * s;
        const py = cy + ry * R * s;
        const near = (pz + 1) / 2; // 0 奥 … 1 手前
        let a = (0.3 + near * 0.75) * glow;
        let size = 1 + near * 1.7;
        if (m === "search") {
          const band = Math.max(0, 1 - Math.abs(ry - scan) * 5);
          a += band * 0.8;
          size += band * 1.2;
        } else if (m === "create" || m === "speaking") {
          const dist = Math.hypot(rx, ry) * s;
          const ring = Math.max(0, 1 - Math.abs(dist - wave * 1.1) * 7);
          a += ring * 0.7;
          size += ring;
        }
        ctx.fillStyle = `rgba(255, ${Math.round(150 + near * 70)}, ${Math.round(60 + near * 60)}, ${Math.min(1, a).toFixed(3)})`;
        ctx.fillRect(px - size / 2, py - size / 2, size, size);
      }
    };

    // 30fps で十分（負荷を抑える）
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      if (document.hidden || now - last < 32) return;
      draw(now);
    };
    if (still) {
      draw(performance.now());
    } else {
      raf = requestAnimationFrame(loop);
    }
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [active]);

  return <canvas ref={ref} className="pcore" aria-hidden="true" />;
}
