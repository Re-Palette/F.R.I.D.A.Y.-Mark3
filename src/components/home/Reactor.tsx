"use client";

/**
 * HOME 中央のコア。区切られたリング（オレンジと灰色の目盛り）が何重にも重なり、ゆっくり回る。
 * 中心に「F.R.I.D.A.Y.」。「〇〇のホログラム」を作ったときだけ、中心に 3D ホログラムが浮かぶ。
 */
import type { ChatPhase } from "@/hooks/useChat";
import { useHoloState } from "@/lib/hologram-model";
import { Hologram } from "../Hologram";

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

/** n 個に区切ったリング。hot に入る番号はオレンジ、それ以外は灰色 */
function Segments({ r, n, gap, width, hot }: { r: number; n: number; gap: number; width: number; hot: (i: number) => boolean }) {
  const step = 360 / n;
  return (
    <>
      {Array.from({ length: n }, (_, i) => (
        <path key={i} d={arc(r, i * step + gap / 2, (i + 1) * step - gap / 2)} className={hot(i) ? "reactor__hot" : "reactor__cold"} strokeWidth={width} />
      ))}
    </>
  );
}

const inRange = (i: number, ranges: [number, number][]) => ranges.some(([a, b]) => i >= a && i <= b);

export function Reactor({ phase, speaking, active }: { phase: ChatPhase; speaking: boolean; active: boolean }) {
  const holo = useHoloState();
  const modelShown = holo.status === "ready" || holo.status === "loading";
  return (
    <div className="reactor" data-phase={phase} data-speaking={speaking || undefined} data-model={modelShown || undefined}>
      {/* 四隅の枠 */}
      <svg className="reactor__layer" viewBox="0 0 600 600" aria-hidden="true">
        <path className="reactor__bracket" d="M20 70V20H70M530 20H580V70M580 530V580H530M70 580H20V530" />
        <circle cx={C} cy={C} r="292" className="reactor__dots" strokeDasharray="1.2 7" />
      </svg>
      <svg className="reactor__layer reactor__spin reactor__spin--a" viewBox="0 0 600 600" aria-hidden="true">
        <Segments r={268} n={48} gap={2.4} width={12} hot={(i) => inRange(i, [[2, 7], [26, 29], [40, 42]])} />
      </svg>
      <svg className="reactor__layer reactor__spin reactor__spin--b" viewBox="0 0 600 600" aria-hidden="true">
        <circle cx={C} cy={C} r="246" className="reactor__dots" strokeDasharray="1.2 5" />
        <Segments r={228} n={36} gap={3} width={9} hot={(i) => inRange(i, [[31, 35], [14, 17], [22, 23]])} />
      </svg>
      <svg className="reactor__layer reactor__spin reactor__spin--c" viewBox="0 0 600 600" aria-hidden="true">
        <Segments r={196} n={60} gap={1.6} width={14} hot={(i) => inRange(i, [[4, 12], [33, 40], [52, 55]])} />
      </svg>
      <svg className="reactor__layer" viewBox="0 0 600 600" aria-hidden="true">
        <circle cx={C} cy={C} r="170" className="reactor__disc" />
        <circle cx={C} cy={C} r="170" className="reactor__rim" />
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
