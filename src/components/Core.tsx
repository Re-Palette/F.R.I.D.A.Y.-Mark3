/**
 * F.R.I.D.A.Y. Core — 中央のリアクター（多層メカニカルリング）。
 * 回転は transform のみ（GPU 合成）。発光は静的レイヤーで表現し、毎フレームのフィルタ計算を避ける。
 */
import type { ChatPhase } from "@/hooks/useChat";
import { Hologram } from "./Hologram";

const C = 200;
const polar = (r: number, deg: number) => {
  const a = ((deg - 90) * Math.PI) / 180;
  return [C + r * Math.cos(a), C + r * Math.sin(a)] as const;
};
const f = (n: number) => n.toFixed(2);
const arc = (r: number, from: number, to: number) => {
  const [x1, y1] = polar(r, from);
  const [x2, y2] = polar(r, to);
  return `M${f(x1)} ${f(y1)} A${r} ${r} 0 ${to - from > 180 ? 1 : 0} 1 ${f(x2)} ${f(y2)}`;
};
const radial = (r1: number, r2: number, deg: number) => {
  const [x1, y1] = polar(r1, deg);
  const [x2, y2] = polar(r2, deg);
  return `M${f(x1)} ${f(y1)} L${f(x2)} ${f(y2)}`;
};

/* 外周スケール（2°刻み、10°ごとに長い目盛り） */
const SCALE = Array.from({ length: 180 }, (_, i) => i * 2);
/* LED 帯：120 セグメント、明るさに周期的な強弱 */
const LED_LEVELS = [1, 1, 0.9, 0.7, 0.25, 0.15, 0.85, 1, 0.95, 0.4, 0.2, 0.6];
const LEDS = Array.from({ length: 120 }, (_, i) => ({ from: i * 3 + 0.5, to: i * 3 + 2.5, level: LED_LEVELS[i % 12] }));
/* 内側の放射線 */
const RAYS = Array.from({ length: 120 }, (_, i) => i * 3);
/* 四隅のクランプ（留め具）アーク */
const CLAMPS = [45, 135, 225, 315];

const LedGrad = () => (
  <defs>
    <linearGradient id="ledGrad" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stopColor="#ffd9a0" />
      <stop offset="50%" stopColor="#ff9326" />
      <stop offset="100%" stopColor="#ff6a00" />
    </linearGradient>
  </defs>
);

/**
 * 構造: 静止した土台 SVG + 回転する独立レイヤー（SVG 要素ごと回す）。
 * 回転レイヤーは GPU 上の合成レイヤーとして回るだけなので、毎フレームの再描画が起きない。
 */
export function Core({
  phase,
  compact = false,
  speaking = false,
  active = true,
}: {
  phase: ChatPhase;
  compact?: boolean;
  /** F.R.I.D.A.Y. が話している（ホログラムが声に合わせて脈打つ） */
  speaking?: boolean;
  /** 画面に出ている（隠れている間は 3D の描画を止める） */
  active?: boolean;
}) {
  return (
    <div className={`core${compact ? " core--compact" : ""}`} data-phase={phase} data-holo={!compact || undefined} aria-hidden="true">
      <div className="core__bloom" />

      {/* 土台（静止） */}
      <svg className="core__layer" viewBox="0 0 400 400">
        <defs>
          <radialGradient id="coreDisc" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="#060709" />
            <stop offset="75%" stopColor="#0a0908" />
            <stop offset="100%" stopColor="#261003" />
          </radialGradient>
        </defs>

        <circle cx={C} cy={C} r="196" className="core__line" strokeOpacity="0.35" />
        {!compact &&
          CLAMPS.map((d) => (
            <g key={d} className="core__clamp">
              <path d={arc(192, d - 26, d + 26)} strokeWidth="3.2" />
              <path d={radial(186, 198, d - 26)} strokeWidth="1.4" />
              <path d={radial(186, 198, d + 26)} strokeWidth="1.4" />
            </g>
          ))}

        <circle cx={C} cy={C} r="170" fill="none" stroke="#ff7a10" strokeOpacity="0.1" strokeWidth="11" />

        {/* メインの発光リング */}
        <circle className="core__torus" cx={C} cy={C} r="140" fill="none" stroke="#ff8a1f" strokeWidth="6" />
        <circle cx={C} cy={C} r="140" fill="none" stroke="#ffe6c2" strokeOpacity="0.9" strokeWidth="1.4" />

        {/* 内側ディスク */}
        <circle cx={C} cy={C} r="132" fill="url(#coreDisc)" />
        {!compact && (
          <g>
            {RAYS.map((d) => (
              <path
                key={d}
                d={radial(d % 15 === 0 ? 108 : 118, 128, d)}
                className="core__line"
                strokeOpacity={d % 15 === 0 ? 0.55 : 0.2}
                strokeWidth="0.7"
              />
            ))}
            <g className="core__line" strokeOpacity="0.28" strokeWidth="0.7">
              <path d="M72 200 H132 M268 200 H328 M200 72 V96 M200 304 V328" />
              <path d="M132 196 V204 M268 196 V204 M196 96 H204 M196 304 H204" />
            </g>
            <circle cx={C} cy={C} r="100" className="core__line" strokeOpacity="0.16" strokeDasharray="1 5" />
          </g>
        )}
        <circle className="core__rim" cx={C} cy={C} r="132" fill="none" stroke="#ffb458" strokeWidth="2.2" />
      </svg>

      {/* 外周スケール（ゆっくり回転） */}
      {!compact && (
        <svg className="core__layer core__spin core__spin--scale" viewBox="0 0 400 400">
          {SCALE.map((d) => {
            const major = d % 10 === 0;
            return (
              <path
                key={d}
                d={radial(major ? 180 : 183, 187, d)}
                className="core__tick"
                strokeOpacity={major ? 0.9 : 0.35}
                strokeWidth={major ? 1.3 : 0.7}
              />
            );
          })}
        </svg>
      )}

      {/* LED 帯（逆回転） */}
      <svg className="core__layer core__spin core__spin--leds" viewBox="0 0 400 400">
        <LedGrad />
        {LEDS.map((s, i) => (
          <path key={i} d={arc(170, s.from, s.to)} fill="none" stroke="url(#ledGrad)" strokeWidth="9" strokeOpacity={s.level} />
        ))}
      </svg>

      {/* 切り欠き付きリング + 三角マーカー */}
      <svg className="core__layer core__spin core__spin--notch" viewBox="0 0 400 400">
        {[0, 120, 240].map((d) => (
          <g key={d}>
            <path d={arc(158, d + 8, d + 112)} className="core__line" strokeOpacity="0.8" strokeWidth="1.4" />
            <path
              d={`M${f(polar(153, d + 60)[0])} ${f(polar(153, d + 60)[1])} L${f(polar(146, d + 56)[0])} ${f(polar(146, d + 56)[1])} L${f(polar(146, d + 64)[0])} ${f(polar(146, d + 64)[1])} Z`}
              className="core__marker"
            />
          </g>
        ))}
      </svg>

      {/* 走る細いアーク */}
      <svg className="core__layer core__spin core__spin--arcs" viewBox="0 0 400 400">
        <path d={arc(148, 20, 95)} className="core__hi" strokeWidth="1.6" />
        <path d={arc(148, 200, 250)} className="core__hi" strokeWidth="1.6" />
      </svg>

      {!compact && <Hologram phase={phase} speaking={speaking} active={active} />}

      <div className="core__rimglow" />
      {!compact && <div className="core__sweep" />}

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
