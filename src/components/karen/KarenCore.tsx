"use client";

/**
 * K.A.R.E.N. の中央の球（待機中）。F.R.I.D.A.Y. と同じ光の点の網の球（ParticleCore）を青い色合いで描き、
 * 周りに速さの違う円形のメカニカルなリング（途切れ・目盛りつき）を重ねる。
 * 声を聞いている間は少し明るく（ParticleCore の聞き取りの動き＋リングの発光）。動きを減らす設定なら止める。
 */
import { memo } from "react";
import { ParticleCore, type CoreMode } from "../home/ParticleCore";

const C = 300;
const polar = (r: number, deg: number) => {
  const a = ((deg - 90) * Math.PI) / 180;
  return [C + r * Math.cos(a), C + r * Math.sin(a)] as const;
};
const arc = (r: number, from: number, to: number) => {
  const [x1, y1] = polar(r, from);
  const [x2, y2] = polar(r, to);
  return `M${x1.toFixed(1)} ${y1.toFixed(1)} A${r} ${r} 0 ${to - from > 180 ? 1 : 0} 1 ${x2.toFixed(1)} ${y2.toFixed(1)}`;
};
const TICKS = Array.from({ length: 72 }, (_, i) => i * 5);

export const KarenCore = memo(function KarenCore({ mode, active, leaving }: { mode: CoreMode; active: boolean; leaving: boolean }) {
  return (
    <div className="kcore" data-mode={mode} data-leaving={leaving || undefined} aria-label="K.A.R.E.N. CORE" role="img">
      <svg className="kcore__layer kcore__spin kcore__spin--slow" viewBox="0 0 600 600" aria-hidden="true">
        <circle cx={C} cy={C} r="286" className="kr__dots" />
        {TICKS.map((d) => {
          const [x1, y1] = polar(270, d);
          const [x2, y2] = polar(d % 30 === 0 ? 258 : 264, d);
          return <path key={d} className={d % 30 === 0 ? "kr__tick kr__tick--major" : "kr__tick"} d={`M${x1.toFixed(1)} ${y1.toFixed(1)}L${x2.toFixed(1)} ${y2.toFixed(1)}`} />;
        })}
      </svg>
      <svg className="kcore__layer kcore__spin kcore__spin--rev" viewBox="0 0 600 600" aria-hidden="true">
        <path className="kr__ring-glow" d={arc(232, -70, 70)} />
        <path className="kr__ring-glow" d={arc(232, 110, 250)} />
        <path className="kr__ring" d={arc(232, -70, 70)} />
        <path className="kr__ring" d={arc(232, 110, 250)} />
        <path className="kr__ring kr__ring--thin" d={arc(232, 78, 102)} />
        <path className="kr__ring kr__ring--thin" d={arc(232, 258, 282)} />
      </svg>
      <svg className="kcore__layer kcore__spin kcore__spin--fast" viewBox="0 0 600 600" aria-hidden="true">
        <circle cx={C} cy={C} r="250" className="kr__dash" />
        <path className="kr__ring kr__ring--hair" d={arc(212, 20, 160)} />
        <path className="kr__ring kr__ring--hair" d={arc(212, 200, 340)} />
      </svg>
      <svg className="kcore__layer" viewBox="0 0 600 600" aria-hidden="true">
        <circle cx={C} cy={C} r="200" className="kr__thin" />
        <circle cx={C} cy={C} r="150" className="kr__faint" />
      </svg>
      <div className="kcore__sphere">
        <ParticleCore mode={mode} active={active && !leaving} cool />
      </div>
      {/* 球が消えるときに中央から方眼へ広がる光の粒 */}
      {leaving && (
        <div className="kcore__burst" aria-hidden="true">
          {Array.from({ length: 28 }, (_, i) => (
            <i key={i} style={{ "--a": `${(i * 360) / 28}deg`, "--d": `${0.9 + (i % 4) * 0.25}`, animationDelay: `${(i % 5) * 30}ms` } as React.CSSProperties} />
          ))}
        </div>
      )}
    </div>
  );
});
