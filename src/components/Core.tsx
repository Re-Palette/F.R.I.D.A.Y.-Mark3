/**
 * F.R.I.D.A.Y. Core — 中央の発光リング。
 * アニメーションは transform / opacity のみ（GPU 合成で軽量）。
 */
import type { ChatPhase } from "@/hooks/useChat";

const TICKS = Array.from({ length: 72 }, (_, i) => i);
const SEGMENTS = Array.from({ length: 12 }, (_, i) => i);

export function Core({ phase, compact = false }: { phase: ChatPhase; compact?: boolean }) {
  return (
    <div className={`core${compact ? " core--compact" : ""}`} data-phase={phase} aria-hidden={compact}>
      <div className="core__halo" />
      <svg className="core__svg" viewBox="0 0 400 400">
        <defs>
          <radialGradient id="coreGlow" cx="50%" cy="50%" r="50%">
            <stop offset="55%" stopColor="#ff8a1f" stopOpacity="0" />
            <stop offset="78%" stopColor="#ff8a1f" stopOpacity="0.28" />
            <stop offset="100%" stopColor="#ff8a1f" stopOpacity="0" />
          </radialGradient>
          <linearGradient id="arcGrad" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#ffd08a" />
            <stop offset="50%" stopColor="#ff8a1f" />
            <stop offset="100%" stopColor="#e85d04" />
          </linearGradient>
        </defs>

        <circle cx="200" cy="200" r="196" fill="url(#coreGlow)" />

        {/* 外周の目盛り（ゆっくり回転） */}
        <g className="core__ring core__ring--ticks">
          {TICKS.map((i) => (
            <line
              key={i}
              x1="200"
              y1={i % 6 === 0 ? 8 : 14}
              x2="200"
              y2="22"
              stroke="#ff9a3c"
              strokeOpacity={i % 6 === 0 ? 0.9 : 0.35}
              strokeWidth={i % 6 === 0 ? 2 : 1}
              transform={`rotate(${i * 5} 200 200)`}
            />
          ))}
        </g>

        {/* セグメントリング（逆回転） */}
        <g className="core__ring core__ring--segments">
          {SEGMENTS.map((i) => (
            <path
              key={i}
              d="M200 40 A160 160 0 0 1 263 53"
              stroke="url(#arcGrad)"
              strokeWidth={i % 3 === 0 ? 14 : 8}
              strokeOpacity={i % 3 === 0 ? 0.95 : 0.55}
              fill="none"
              transform={`rotate(${i * 30} 200 200)`}
            />
          ))}
        </g>

        {/* 破線リング */}
        <g className="core__ring core__ring--dash">
          <circle cx="200" cy="200" r="138" fill="none" stroke="#ff8a1f" strokeOpacity="0.5" strokeWidth="1.5" strokeDasharray="2 7" />
          <path d="M200 62 A138 138 0 0 1 338 200" fill="none" stroke="#ffb347" strokeWidth="2.5" strokeOpacity="0.9" />
        </g>

        {/* 内側の発光リング */}
        <circle className="core__inner" cx="200" cy="200" r="118" fill="none" stroke="#ff8a1f" strokeWidth="3" />
        <circle cx="200" cy="200" r="110" fill="#07090d" fillOpacity="0.85" />
        <circle cx="200" cy="200" r="110" fill="none" stroke="#ff8a1f" strokeOpacity="0.25" />
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
