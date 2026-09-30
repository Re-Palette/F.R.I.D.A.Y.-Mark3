"use client";

/**
 * HOME 中央の AI コア。アークリアクター風の多層リング（外側 3 層 + Core の 5 層）、
 * 目盛り・方位・照準線、周りを回る粒子、外へ伸びるエネルギー線、足元の投影台。
 * 中心の Core には 3D ホログラムが入る。回転は transform のみ（GPU 合成）で、HOME 以外では止める。
 */
import type { ChatPhase } from "@/hooks/useChat";
import { Core } from "../Core";

const C = 300;
const polar = (r: number, deg: number) => {
  const a = ((deg - 90) * Math.PI) / 180;
  return [C + r * Math.cos(a), C + r * Math.sin(a)] as const;
};
const f = (n: number) => n.toFixed(1);
const arc = (r: number, from: number, to: number) => {
  const [x1, y1] = polar(r, from);
  const [x2, y2] = polar(r, to);
  return `M${f(x1)} ${f(y1)} A${r} ${r} 0 ${to - from > 180 ? 1 : 0} 1 ${f(x2)} ${f(y2)}`;
};
const tick = (r1: number, r2: number, deg: number) => {
  const [x1, y1] = polar(r1, deg);
  const [x2, y2] = polar(r2, deg);
  return `M${f(x1)} ${f(y1)}L${f(x2)} ${f(y2)}`;
};

const TICKS = Array.from({ length: 120 }, (_, i) => i * 3);
const SEGMENTS = Array.from({ length: 12 }, (_, i) => i * 30);
const PARTICLES = Array.from({ length: 22 }, (_, i) => ({
  r: 38 + ((i * 37) % 11), // % of core radius
  dur: 14 + ((i * 7) % 13),
  delay: -((i * 1.7) % 14),
  size: 1.5 + ((i * 3) % 3) * 0.6,
  rev: i % 3 === 0,
}));
const BEAMS = [22, 67, 112, 158, 202, 248, 292, 338];

export function AiCore({ phase, speaking, active, status }: { phase: ChatPhase; speaking: boolean; active: boolean; status: string }) {
  return (
    <div className="aicore" data-phase={phase} data-speaking={speaking || undefined} aria-hidden="true">
      {/* 外側のリング（静止の目盛り・方位 / ゆっくり回る 3 層） */}
      <svg className="aicore__layer" viewBox="0 0 600 600">
        <circle cx={C} cy={C} r="297" className="aicore__line" strokeOpacity="0.25" />
        {[0, 90, 180, 270].map((d) => {
          const [x, y] = polar(286, d);
          return (
            <g key={d}>
              <path d={arc(290, d - 9, d + 9)} className="aicore__hi" strokeWidth="2.2" />
              <text x={f(x)} y={f(y)} className="aicore__deg" textAnchor="middle" dominantBaseline="middle">
                {String(d).padStart(3, "0")}
              </text>
            </g>
          );
        })}
        {/* 照準線 */}
        <g className="aicore__line" strokeOpacity="0.3">
          <path d="M0 300H36M564 300H600M300 0V36M300 564V600" />
          <path d="M12 294V306M24 296V304M588 294V306M576 296V304M294 12H306M296 24H304M294 588H306M296 576H304" />
        </g>
      </svg>
      <svg className="aicore__layer aicore__spin aicore__spin--ticks" viewBox="0 0 600 600">
        {TICKS.map((d) => (
          <path key={d} d={tick(d % 15 === 0 ? 268 : 272, 278, d)} className="aicore__line" strokeOpacity={d % 15 === 0 ? 0.85 : 0.3} strokeWidth={d % 15 === 0 ? 1.4 : 0.8} />
        ))}
      </svg>
      <svg className="aicore__layer aicore__spin aicore__spin--segments" viewBox="0 0 600 600">
        {SEGMENTS.map((d, i) => (
          <path key={d} d={arc(258, d + 3, d + (i % 3 === 0 ? 24 : 14))} className="aicore__seg" strokeWidth={i % 3 === 0 ? 5 : 3} strokeOpacity={i % 3 === 0 ? 0.9 : 0.45} />
        ))}
      </svg>
      <svg className="aicore__layer aicore__spin aicore__spin--orbit" viewBox="0 0 600 600">
        <circle cx={C} cy={C} r="246" className="aicore__line" strokeOpacity="0.45" strokeDasharray="1.5 6" />
        <circle cx={f(polar(246, 40)[0])} cy={f(polar(246, 40)[1])} r="3.2" className="aicore__node" />
        <circle cx={f(polar(246, 220)[0])} cy={f(polar(246, 220)[1])} r="2.2" className="aicore__node aicore__node--cyan" />
      </svg>

      {/* 外へ伸びるエネルギー線 */}
      <div className="aicore__beams">
        {BEAMS.map((d, i) => (
          <i key={d} style={{ transform: `rotate(${d}deg)`, animationDelay: `${-i * 0.45}s` }} />
        ))}
      </div>

      {/* 中心のリアクター（5 層 + 3D ホログラム） */}
      <div className="aicore__reactor">
        <Core phase={phase} speaking={speaking} active={active} />
      </div>

      {/* 周りを回る光の粒 */}
      <div className="aicore__particles">
        {PARTICLES.map((p, i) => (
          <span
            key={i}
            style={
              {
                "--r": `${p.r}%`,
                "--s": `${p.size}px`,
                animationDuration: `${p.dur}s`,
                animationDelay: `${p.delay}s`,
                animationDirection: p.rev ? "reverse" : "normal",
              } as React.CSSProperties
            }
          />
        ))}
      </div>

      <div className="aicore__tag aicore__tag--top">
        <b>AI CORE</b>
        <span>{status}</span>
      </div>

      {/* 足元の投影台 */}
      <div className="aicore__platform">
        <i />
        <i />
        <i />
      </div>
    </div>
  );
}
