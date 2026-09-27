/**
 * F.R.I.D.A.Y. Core — 中央の発光リアクター。
 * 回転は transform のみ（GPU 合成）。発光はブラー済みの静的レイヤーで表現し、毎フレームのフィルタ計算を避ける。
 */
import type { ChatPhase } from "@/hooks/useChat";

const C = 200;
const polar = (r: number, deg: number) => {
  const a = ((deg - 90) * Math.PI) / 180;
  return [C + r * Math.cos(a), C + r * Math.sin(a)] as const;
};
const arc = (r: number, from: number, to: number) => {
  const [x1, y1] = polar(r, from);
  const [x2, y2] = polar(r, to);
  return `M${x1.toFixed(2)} ${y1.toFixed(2)} A${r} ${r} 0 ${to - from > 180 ? 1 : 0} 1 ${x2.toFixed(2)} ${y2.toFixed(2)}`;
};

/* 外周の目盛り */
const TICKS = Array.from({ length: 120 }, (_, i) => i * 3);
/* LED セグメント帯：明るさに強弱をつける */
const LEDS = Array.from({ length: 72 }, (_, i) => ({
  from: i * 5 + 0.9,
  to: i * 5 + 4.1,
  level: [1, 0.9, 0.75, 0.2, 0.95, 1, 0.4, 0.15, 0.85, 1, 0.6, 0.25][i % 12],
}));
/* 内側の放射線 */
const RAYS = Array.from({ length: 144 }, (_, i) => i * 2.5);

export function Core({ phase, compact = false }: { phase: ChatPhase; compact?: boolean }) {
  return (
    <div className={`core${compact ? " core--compact" : ""}`} data-phase={phase} aria-hidden="true">
      <div className="core__bloom" />
      <svg className="core__svg" viewBox="0 0 400 400">
        <defs>
          <radialGradient id="coreDisc" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="#07080b" />
            <stop offset="72%" stopColor="#0b0907" />
            <stop offset="100%" stopColor="#2a1203" />
          </radialGradient>
          <linearGradient id="ledGrad" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#ffd28c" />
            <stop offset="45%" stopColor="#ff9326" />
            <stop offset="100%" stopColor="#ff6a00" />
          </linearGradient>
        </defs>

        {/* 外周の細い同心円 */}
        <circle cx={C} cy={C} r="197" fill="none" stroke="#ff8a1f" strokeOpacity="0.18" />
        <circle cx={C} cy={C} r="191" fill="none" stroke="#ff8a1f" strokeOpacity="0.12" strokeDasharray="1 4" />

        {/* 目盛りリング（ゆっくり回転） */}
        {!compact && (
          <g className="core__spin core__spin--ticks">
            {TICKS.map((d) => {
              const major = d % 30 === 0;
              const [x1, y1] = polar(major ? 176 : 180, d);
              const [x2, y2] = polar(186, d);
              return (
                <line
                  key={d}
                  x1={x1}
                  y1={y1}
                  x2={x2}
                  y2={y2}
                  stroke="#ffa04a"
                  strokeOpacity={major ? 0.85 : 0.3}
                  strokeWidth={major ? 1.6 : 0.8}
                />
              );
            })}
          </g>
        )}

        {/* LED 帯：暗いベース */}
        <circle cx={C} cy={C} r="164" fill="none" stroke="#ff7a10" strokeOpacity="0.12" strokeWidth="16" />

        {/* LED 帯：明るいセグメント（逆回転） */}
        <g className="core__spin core__spin--leds">
          {LEDS.map((s, i) => (
            <path
              key={i}
              d={arc(164, s.from, s.to)}
              fill="none"
              stroke="url(#ledGrad)"
              strokeWidth="14"
              strokeOpacity={s.level}
            />
          ))}
        </g>

        {/* 走る細いアーク */}
        <g className="core__spin core__spin--arcs">
          <path d={arc(152, 10, 80)} fill="none" stroke="#ffc07a" strokeWidth="1.6" />
          <path d={arc(152, 190, 235)} fill="none" stroke="#ffc07a" strokeWidth="1.6" />
          <path d={arc(152, 120, 160)} fill="none" stroke="#ff8a1f" strokeOpacity="0.6" strokeWidth="1" />
          <path d={arc(152, 280, 340)} fill="none" stroke="#ff8a1f" strokeOpacity="0.6" strokeWidth="1" />
        </g>
        {/* 太く光るメインリング */}
        <circle className="core__torus" cx={C} cy={C} r="140" fill="none" stroke="#ff8a1f" strokeWidth="9" />
        <circle cx={C} cy={C} r="140" fill="none" stroke="#ffe1b0" strokeOpacity="0.85" strokeWidth="2" />

        {/* 内側のディスク */}
        <circle cx={C} cy={C} r="126" fill="url(#coreDisc)" />

        {/* 放射状の細線 */}
        {!compact && (
          <g className="core__rays">
            {RAYS.map((d) => {
              const long = d % 15 === 0;
              const [x1, y1] = polar(long ? 96 : 104, d);
              const [x2, y2] = polar(122, d);
              return <line key={d} x1={x1} y1={y1} x2={x2} y2={y2} stroke="#ff8a1f" strokeOpacity={long ? 0.5 : 0.18} strokeWidth="0.7" />;
            })}
          </g>
        )}

        {/* 内側の発光リム */}
        <circle className="core__rim" cx={C} cy={C} r="126" fill="none" stroke="#ffb458" strokeWidth="3.5" />
        <circle cx={C} cy={C} r="118" fill="none" stroke="#ff8a1f" strokeOpacity="0.35" strokeWidth="1" />
        <circle cx={C} cy={C} r="92" fill="none" stroke="#ff8a1f" strokeOpacity="0.14" strokeWidth="1" strokeDasharray="2 5" />
      </svg>

      {!compact && (
        <div className="core__label">
          <div className="core__title">F.R.I.D.A.Y.</div>
          <div className="core__model">Mark3</div>
          <div className="core__tagline">YOUR AI. YOUR FUTURE.</div>
        </div>
      )}
    </div>
  );
}
