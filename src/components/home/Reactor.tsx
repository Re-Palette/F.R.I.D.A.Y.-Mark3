"use client";

/**
 * HOME 中央の F.R.I.D.A.Y. CORE（平面の HUD ＋ ほんの少しの奥行き）。
 *   外周：細い HUD リング・角度マーカー・回路ライン／回る目盛り
 *   区切りリング 3 層（一部のセグメントが周期的に点灯）／周回する光の粒
 *   中心：ガラスの円・スキャンライン・状態を示す弧・F.R.I.D.A.Y. と状態の文字
 * 考え中・返答中は発光が強まり、声を聞いている間は内側のリングが脈打つ。
 * 「〇〇のホログラム」を作ったときだけ、中心に 3D ホログラムが浮かぶ。
 */
import type { ChatPhase, ChatStage } from "@/hooks/useChat";
import type { VoiceState } from "@/hooks/useVoice";
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
const ray = (r1: number, r2: number, deg: number) => {
  const [x1, y1] = polar(r1, deg);
  const [x2, y2] = polar(r2, deg);
  return `M${f(x1)} ${f(y1)}L${f(x2)} ${f(y2)}`;
};

/** n 個に区切ったリング。hot はオレンジ、blink は周期的に点灯（遅れをずらして流れるように） */
function Segments({ r, n, gap, width, hot, blink }: { r: number; n: number; gap: number; width: number; hot: (i: number) => boolean; blink?: (i: number) => boolean }) {
  const step = 360 / n;
  return (
    <>
      {Array.from({ length: n }, (_, i) => {
        const b = blink?.(i);
        return (
          <path
            key={i}
            d={arc(r, i * step + gap / 2, (i + 1) * step - gap / 2)}
            className={hot(i) ? "reactor__hot" : b ? "reactor__cold reactor__blink" : "reactor__cold"}
            style={b ? { animationDelay: `${((i * 0.37) % 4).toFixed(2)}s` } : undefined}
            strokeWidth={width}
          />
        );
      })}
    </>
  );
}

const inRange = (i: number, ranges: [number, number][]) => ranges.some(([a, b]) => i >= a && i <= b);

/** 外周の回路ライン（外へ伸びて折れ、先に点） */
const CIRCUITS = [32, 58, 122, 148, 212, 238, 302, 328].map((d, k) => {
  const [x1, y1] = polar(278, d);
  const [x2, y2] = polar(292, d);
  const bend = k % 2 ? 8 : -8;
  const [x3, y3] = polar(292, d + bend);
  return { d: `M${f(x1)} ${f(y1)}L${f(x2)} ${f(y2)}L${f(x3)} ${f(y3)}`, dot: [x3, y3] as const };
});

const STATUS: Record<string, string> = {
  idle: "STANDBY",
  listening: "LISTENING",
  connect: "LINKING",
  think: "THINKING",
  search: "SEARCHING",
  create: "GENERATING",
  speaking: "SPEAKING",
};

export function Reactor({
  phase,
  stage,
  voiceState,
  active,
}: {
  phase: ChatPhase;
  stage: ChatStage;
  voiceState: VoiceState;
  active: boolean;
}) {
  const holo = useHoloState();
  const modelShown = holo.status === "ready" || holo.status === "loading";
  const speaking = voiceState === "speaking";
  const mode = phase === "streaming" ? "create" : phase === "waiting" ? (stage ?? "think") : speaking ? "speaking" : voiceState === "listening" ? "listening" : "idle";
  return (
    <div className="reactor" data-phase={phase} data-mode={mode} data-speaking={speaking || undefined} data-model={modelShown || undefined}>
      {/* 静止の外周：四隅の枠・細い HUD リング・角度マーカー・回路ライン */}
      <svg className="reactor__layer" viewBox="0 0 600 600" aria-hidden="true">
        <path className="reactor__bracket" d="M20 70V20H70M530 20H580V70M580 530V580H530M70 580H20V530" />
        <circle cx={C} cy={C} r="297" className="reactor__thin" />
        {[0, 90, 180, 270].map((d) => {
          const [x, y] = polar(297, d);
          return <path key={d} className="reactor__marker" d={`M${f(x)} ${f(y)} l-6 -9 h12 z`} transform={`rotate(${d + 180} ${f(x)} ${f(y)})`} />;
        })}
        {[45, 135, 225, 315].map((d) => (
          <path key={d} className="reactor__arcmark" d={arc(297, d - 8, d + 8)} />
        ))}
        {CIRCUITS.map((c, i) => (
          <g key={i} className="reactor__circuit">
            <path d={c.d} />
            <circle cx={f(c.dot[0])} cy={f(c.dot[1])} r="2.2" style={{ animationDelay: `${(i * 0.6).toFixed(1)}s` }} />
          </g>
        ))}
      </svg>

      {/* 回る細い目盛り */}
      <svg className="reactor__layer reactor__spin reactor__spin--ticks" viewBox="0 0 600 600" aria-hidden="true">
        {Array.from({ length: 144 }, (_, i) => i * 2.5).map((d) => (
          <path key={d} d={ray(d % 15 === 0 ? 281 : 284, 288, d)} className={d % 15 === 0 ? "reactor__tick reactor__tick--major" : "reactor__tick"} />
        ))}
      </svg>

      {/* 区切りリング 3 層 */}
      <svg className="reactor__layer reactor__spin reactor__spin--a" viewBox="0 0 600 600" aria-hidden="true">
        <Segments r={268} n={48} gap={2.4} width={12} hot={(i) => inRange(i, [[2, 7], [26, 29], [40, 42]])} blink={(i) => i % 7 === 3} />
      </svg>
      <svg className="reactor__layer reactor__spin reactor__spin--b" viewBox="0 0 600 600" aria-hidden="true">
        <circle cx={C} cy={C} r="246" className="reactor__dots" strokeDasharray="1.2 5" />
        <Segments r={228} n={36} gap={3} width={9} hot={(i) => inRange(i, [[31, 35], [14, 17], [22, 23]])} blink={(i) => i % 5 === 1} />
      </svg>
      <svg className="reactor__layer reactor__spin reactor__spin--c" viewBox="0 0 600 600" aria-hidden="true">
        <Segments r={196} n={60} gap={1.6} width={14} hot={(i) => inRange(i, [[4, 12], [33, 40], [52, 55]])} />
      </svg>

      {/* 周回する光の粒 */}
      <svg className="reactor__layer reactor__spin reactor__spin--orbit" viewBox="0 0 600 600" aria-hidden="true">
        {[20, 140, 260].map((d, i) => {
          const [x, y] = polar(246, d);
          return <circle key={d} cx={f(x)} cy={f(y)} r={i === 0 ? 3.2 : 2.2} className="reactor__particle" />;
        })}
      </svg>
      <svg className="reactor__layer reactor__spin reactor__spin--orbit2" viewBox="0 0 600 600" aria-hidden="true">
        {[80, 300].map((d) => {
          const [x, y] = polar(211, d);
          return <circle key={d} cx={f(x)} cy={f(y)} r="1.8" className="reactor__particle reactor__particle--dim" />;
        })}
      </svg>

      {/* 中心のガラスの円・状態の弧（声を聞いている間は脈打つ） */}
      <svg className="reactor__layer" viewBox="0 0 600 600" aria-hidden="true">
        <defs>
          <radialGradient id="reactor-glass" cx="50%" cy="42%" r="60%">
            <stop offset="0" stopColor="#140b05" />
            <stop offset="0.75" stopColor="#060403" />
            <stop offset="1" stopColor="#020101" />
          </radialGradient>
        </defs>
        <circle cx={C} cy={C} r="170" fill="url(#reactor-glass)" />
        <circle cx={C} cy={C} r="170" className="reactor__rim" />
        <circle cx={C} cy={C} r="160" className="reactor__inner" />
        <path className="reactor__cross" d="M300 132V146M300 454V468M132 300H146M454 300H468" />
      </svg>
      <svg className="reactor__layer reactor__status" viewBox="0 0 600 600" aria-hidden="true">
        <circle cx={C} cy={C} r="178" className="reactor__statusring" pathLength="100" />
      </svg>
      <div className="reactor__sweep" aria-hidden="true" />
      <div className="reactor__scan" aria-hidden="true">
        <i />
      </div>

      {/* 作ったホログラムだけを中心に浮かべる（普段は何も描かない） */}
      <div className="reactor__holo">
        <Hologram phase={phase} speaking={speaking} active={active} modelOnly />
      </div>

      <div className="reactor__label">
        <span className="reactor__kicker">AI ASSISTANT</span>
        <b className="reactor__name">F.R.I.D.A.Y.</b>
        <span className="reactor__tag">FOR A BETTER TOMORROW</span>
        <span className="reactor__state">
          <i />
          {STATUS[mode]}
        </span>
      </div>
    </div>
  );
}
