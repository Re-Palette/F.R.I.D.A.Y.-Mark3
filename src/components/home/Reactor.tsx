"use client";

/**
 * HOME 中央のコア（メカニカルなリアクター）。
 *   金属の外枠（ボルト・固定金具）／歯車の歯／角度の目盛り盤／厚みと光沢のある区切りリング 3 層／
 *   削り出しの縁取り／中心のガラス面と「F.R.I.D.A.Y.」
 * 「〇〇のホログラム」を作ったときだけ、中心に 3D ホログラムが浮かぶ。回転は transform のみ。
 */
import type { ChatPhase } from "@/hooks/useChat";
import { useHoloState } from "@/lib/hologram-model";
import { Hologram } from "../Hologram";

const C = 300;
const rad = (deg: number) => ((deg - 90) * Math.PI) / 180;
const pt = (r: number, deg: number) => [C + r * Math.cos(rad(deg)), C + r * Math.sin(rad(deg))] as const;
const f = (n: number) => n.toFixed(2);

/** 扇形の板（内半径 r1・外半径 r2、角度 a〜b） */
function sector(r1: number, r2: number, a: number, b: number) {
  const [x1, y1] = pt(r2, a);
  const [x2, y2] = pt(r2, b);
  const [x3, y3] = pt(r1, b);
  const [x4, y4] = pt(r1, a);
  const large = b - a > 180 ? 1 : 0;
  return `M${f(x1)} ${f(y1)}A${r2} ${r2} 0 ${large} 1 ${f(x2)} ${f(y2)}L${f(x3)} ${f(y3)}A${r1} ${r1} 0 ${large} 0 ${f(x4)} ${f(y4)}Z`;
}
const line = (r1: number, r2: number, deg: number) => {
  const [x1, y1] = pt(r1, deg);
  const [x2, y2] = pt(r2, deg);
  return `M${f(x1)} ${f(y1)}L${f(x2)} ${f(y2)}`;
};

/** 区切られた厚みのある板のリング。hot の番号はオレンジに光る */
function Plates({ r1, r2, n, gap, hot }: { r1: number; r2: number; n: number; gap: number; hot: (i: number) => boolean }) {
  const step = 360 / n;
  return (
    <>
      {Array.from({ length: n }, (_, i) => {
        const a = i * step + gap / 2;
        const b = (i + 1) * step - gap / 2;
        const on = hot(i);
        return (
          <g key={i}>
            <path d={sector(r1, r2, a, b)} fill={on ? "url(#rx-hot)" : "url(#rx-cold)"} className={on ? "rx-plate rx-plate--hot" : "rx-plate"} />
            {/* 上の縁のハイライト（面取り） */}
            <path d={sector(r2 - 1.4, r2, a + 0.3, b - 0.3)} className={on ? "rx-bevel rx-bevel--hot" : "rx-bevel"} />
          </g>
        );
      })}
    </>
  );
}

/** 歯車の歯の輪郭 */
function gear(r: number, teeth: number, depth: number) {
  const step = 360 / teeth;
  let d = "";
  for (let i = 0; i < teeth; i++) {
    const a = i * step;
    const pts = [pt(r, a), pt(r + depth, a + step * 0.12), pt(r + depth, a + step * 0.42), pt(r, a + step * 0.54)];
    d += (i === 0 ? "M" : "L") + pts.map(([x, y]) => `${f(x)} ${f(y)}`).join("L");
    const [ex, ey] = pt(r, a + step);
    d += `A${r} ${r} 0 0 1 ${f(ex)} ${f(ey)}`;
  }
  return d + "Z";
}

const inRange = (i: number, ranges: [number, number][]) => ranges.some(([a, b]) => i >= a && i <= b);
const BOLTS = Array.from({ length: 12 }, (_, i) => i * 30 + 15);
const CLAMPS = [45, 135, 225, 315];
const DEGREES = Array.from({ length: 12 }, (_, i) => i * 30);

export function Reactor({ phase, speaking, active }: { phase: ChatPhase; speaking: boolean; active: boolean }) {
  const holo = useHoloState();
  const modelShown = holo.status === "ready" || holo.status === "loading";
  return (
    <div className="reactor" data-phase={phase} data-speaking={speaking || undefined} data-model={modelShown || undefined}>
      {/* 静止：金属の外枠・固定金具・ボルト・四隅の枠 */}
      <svg className="reactor__layer" viewBox="0 0 600 600" aria-hidden="true">
        <defs>
          <linearGradient id="rx-metal" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#3a3d44" />
            <stop offset="0.35" stopColor="#1b1d22" />
            <stop offset="0.55" stopColor="#2c2f36" />
            <stop offset="1" stopColor="#0d0e11" />
          </linearGradient>
          <linearGradient id="rx-metal-hi" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#5a5e67" />
            <stop offset="1" stopColor="#1a1c21" />
          </linearGradient>
          <linearGradient id="rx-hot" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#ffc07a" />
            <stop offset="0.45" stopColor="#ff8a1f" />
            <stop offset="1" stopColor="#b44a00" />
          </linearGradient>
          <linearGradient id="rx-cold" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#4a4540" />
            <stop offset="1" stopColor="#1f1d1b" />
          </linearGradient>
          <radialGradient id="rx-glass" cx="50%" cy="38%" r="65%">
            <stop offset="0" stopColor="#1a1410" />
            <stop offset="0.7" stopColor="#060607" />
            <stop offset="1" stopColor="#000" />
          </radialGradient>
          <radialGradient id="rx-bolt" cx="35%" cy="30%" r="70%">
            <stop offset="0" stopColor="#9aa0aa" />
            <stop offset="0.5" stopColor="#3b3f47" />
            <stop offset="1" stopColor="#111216" />
          </radialGradient>
        </defs>
        <path className="rx-bracket" d="M18 74V18H74M526 18H582V74M582 526V582H526M74 582H18V526" />
        {/* 外枠（金属のリング） */}
        <circle cx={C} cy={C} r="286" className="rx-housing" />
        <circle cx={C} cy={C} r="296" className="rx-edge" />
        <circle cx={C} cy={C} r="276" className="rx-edge rx-edge--in" />
        {/* 固定金具 */}
        {CLAMPS.map((d) => (
          <g key={d}>
            <path d={sector(270, 300, d - 11, d + 11)} fill="url(#rx-metal-hi)" className="rx-clamp" />
            <path d={line(272, 298, d - 7)} className="rx-groove" />
            <path d={line(272, 298, d + 7)} className="rx-groove" />
          </g>
        ))}
        {/* ボルト */}
        {BOLTS.map((d) => {
          const [x, y] = pt(286, d);
          return (
            <g key={d}>
              <circle cx={f(x)} cy={f(y)} r="4.2" fill="url(#rx-bolt)" className="rx-bolt" />
              <path d={`M${f(x - 2.4)} ${f(y)}H${f(x + 2.4)}`} className="rx-bolt__slot" transform={`rotate(${d} ${f(x)} ${f(y)})`} />
            </g>
          );
        })}
      </svg>

      {/* 歯車の歯（ゆっくり回る） */}
      <svg className="reactor__layer reactor__spin reactor__spin--gear" viewBox="0 0 600 600" aria-hidden="true">
        <path d={gear(258, 72, 8)} fill="url(#rx-metal)" className="rx-gear" />
      </svg>

      {/* 角度の目盛り盤（逆回転） */}
      <svg className="reactor__layer reactor__spin reactor__spin--dial" viewBox="0 0 600 600" aria-hidden="true">
        <circle cx={C} cy={C} r="252" className="rx-dial" />
        {Array.from({ length: 180 }, (_, i) => i * 2).map((d) => (
          <path key={d} d={line(d % 10 === 0 ? 238 : 244, 250, d)} className={d % 30 === 0 ? "rx-tick rx-tick--major" : "rx-tick"} />
        ))}
        {DEGREES.map((d) => {
          const [x, y] = pt(228, d);
          return (
            <text key={d} x={f(x)} y={f(y)} className="rx-num" textAnchor="middle" dominantBaseline="middle" transform={`rotate(${d} ${f(x)} ${f(y)})`}>
              {String(d).padStart(3, "0")}
            </text>
          );
        })}
      </svg>

      {/* 厚みのある区切りリング 3 層 */}
      <svg className="reactor__layer reactor__spin reactor__spin--a" viewBox="0 0 600 600" aria-hidden="true">
        <Plates r1={202} r2={218} n={40} gap={2.2} hot={(i) => inRange(i, [[2, 7], [21, 24], [33, 35]])} />
      </svg>
      <svg className="reactor__layer reactor__spin reactor__spin--b" viewBox="0 0 600 600" aria-hidden="true">
        <circle cx={C} cy={C} r="197" className="rx-seam" />
        <Plates r1={184} r2={194} n={30} gap={3} hot={(i) => inRange(i, [[25, 29], [11, 13], [17, 18]])} />
      </svg>
      <svg className="reactor__layer reactor__spin reactor__spin--c" viewBox="0 0 600 600" aria-hidden="true">
        <Plates r1={164} r2={180} n={60} gap={1.4} hot={(i) => inRange(i, [[4, 12], [33, 40], [52, 55]])} />
      </svg>

      {/* 削り出しの縁取りと、中心のガラス面 */}
      <svg className="reactor__layer" viewBox="0 0 600 600" aria-hidden="true">
        <circle cx={C} cy={C} r="160" fill="url(#rx-metal)" className="rx-bezel" />
        {Array.from({ length: 48 }, (_, i) => i * 7.5).map((d) => (
          <path key={d} d={line(151, 158, d)} className="rx-knurl" />
        ))}
        <circle cx={C} cy={C} r="148" fill="url(#rx-glass)" />
        <circle cx={C} cy={C} r="148" className="reactor__rim" />
        <circle cx={C} cy={C} r="140" className="rx-inner" />
        <path className="rx-cross" d="M300 158V176M300 424V442M158 300H176M424 300H442" />
      </svg>
      <div className="reactor__sweep" aria-hidden="true" />

      {/* 作ったホログラムだけを中心に浮かべる（普段は何も描かない） */}
      <div className="reactor__holo">
        <Hologram phase={phase} speaking={speaking} active={active} modelOnly />
      </div>

      <div className="reactor__label">
        <span className="reactor__kicker">AI ASSISTANT</span>
        <b className="reactor__name">F.R.I.D.A.Y.</b>
        <span className="reactor__tag">FOR A BETTER TOMORROW</span>
      </div>
    </div>
  );
}
