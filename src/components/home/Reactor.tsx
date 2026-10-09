"use client";

/**
 * HOME 中央の F.R.I.D.A.Y. CORE（リファレンス準拠の細い線の HUD）。
 *   外周：点線の輪・外向きの三角マーカー・斜めの光る括弧・破線の輪（ゆっくり回る。回す層は 2 枚だけ）
 *   太いオレンジの輪（上下の長い弧と左右の短い弧）・細い同心円・十字の細線・左右へ伸びる線
 *   中心：光る太陽と、つながった光の点の網（ParticleCore。状態で動きが変わる）
 * 「〇〇のホログラム」を作ったときだけ、中心に 3D ホログラムが浮かぶ。
 */
import { memo } from "react";
import type { ChatPhase, ChatStage } from "@/hooks/useChat";
import type { VoiceState } from "@/hooks/useVoice";
import { useHoloState } from "@/lib/hologram-model";
import { Hologram } from "../Hologram";
import { ParticleCore, type CoreMode } from "./ParticleCore";
import { MODE_LABEL } from "./readouts";

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

/** いまの状態（待機・聞き取り・接続・考え中・検索・返事の作成・読み上げ） */
export function coreMode(phase: ChatPhase, stage: ChatStage, voiceState: VoiceState): CoreMode {
  if (phase === "streaming") return "create";
  if (phase === "waiting") return stage ?? "think";
  if (voiceState === "speaking") return "speaking";
  if (voiceState === "listening") return "listening";
  return "idle";
}

/** 外向きの三角（上・右・下・左） */
const TRIANGLES = [0, 90, 180, 270].map((d) => {
  const [x, y] = polar(284, d);
  return { d, x, y };
});

/** 斜めの光る括弧 */
const BRACKETS = [30, 60, 120, 150, 210, 240, 300, 330];

export const Reactor = memo(function Reactor({
  phase,
  stage,
  voiceState,
  active,
  onSlow,
}: {
  phase: ChatPhase;
  stage: ChatStage;
  voiceState: VoiceState;
  active: boolean;
  /** 描画が追いつかない端末だと分かったとき（HOME を軽い表示に切り替える） */
  onSlow?: () => void;
}) {
  const holo = useHoloState();
  const modelShown = holo.status === "ready" || holo.status === "loading";
  const speaking = voiceState === "speaking";
  const mode = coreMode(phase, stage, voiceState);
  return (
    <div
      className="reactor"
      data-phase={phase}
      data-mode={mode}
      data-speaking={speaking || undefined}
      data-model={modelShown || undefined}
      role="img"
      aria-label={`F.R.I.D.A.Y. CORE — ${MODE_LABEL[mode]}`}
    >
      {/* 静止：十字の細線・左右へ伸びる線・細い同心円・三角マーカー */}
      <svg className="reactor__layer" viewBox="0 0 600 600" aria-hidden="true">
        {/* 立体感のためのグラデーション（光は左上から） */}
        <defs>
          {/* 太い輪：管のように、中ほどが光って内側・外側の縁が暗い（中心からの距離だけで決まるので、回っても光の位置が崩れない） */}
          <radialGradient id="rx-ring-grad" gradientUnits="userSpaceOnUse" cx={C} cy={C} r="226">
            <stop offset="0.966" stopColor="#b84800" />
            <stop offset="0.979" stopColor="#ffd08a" />
            <stop offset="0.986" stopColor="#ff9a2e" />
            <stop offset="1" stopColor="#c85400" />
          </radialGradient>
          <radialGradient id="rx-ring-hot" gradientUnits="userSpaceOnUse" cx={C} cy={C} r="226">
            <stop offset="0.966" stopColor="#d86400" />
            <stop offset="0.979" stopColor="#fff0cc" />
            <stop offset="0.986" stopColor="#ffb558" />
            <stop offset="1" stopColor="#e06a00" />
          </radialGradient>
          {/* 細い同心円：左上が明るく、右下へ行くほど暗い */}
          <linearGradient id="rx-light" gradientUnits="userSpaceOnUse" x1="90" y1="90" x2="510" y2="510">
            <stop offset="0" stopColor="#ffd9a6" stopOpacity="0.95" />
            <stop offset="0.5" stopColor="#ff9a3a" stopOpacity="0.5" />
            <stop offset="1" stopColor="#ff7a10" stopOpacity="0.14" />
          </linearGradient>
          <linearGradient id="rx-tri-grad" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#ffe0a8" />
            <stop offset="0.55" stopColor="#ff9a2e" />
            <stop offset="1" stopColor="#c45000" />
          </linearGradient>
        </defs>
        <path className="rx__hair" d="M300 70V530M70 300H530" />
        <path className="rx__link" d="M8 300H-190M592 300H790" />
        <circle cx={C} cy={C} r="236" className="rx__thin" />
        <circle cx={C} cy={C} r="200" className="rx__thin rx__thin--hi" />
        <circle cx={C} cy={C} r="150" className="rx__faint" />
        {TRIANGLES.map((t) => (
          <path key={t.d} className="rx__tri" d={`M${f(t.x)} ${f(t.y)} l-9 12 h18 z`} transform={`rotate(${t.d} ${f(t.x)} ${f(t.y)}) translate(0 -8)`} />
        ))}
      </svg>

      <svg className="reactor__layer rx__spin rx__spin--dash" viewBox="0 0 600 600" aria-hidden="true">
        <circle cx={C} cy={C} r="258" className="rx__dash" />
      </svg>

      {/* 太いオレンジの輪・点線の輪・斜めの括弧（ひとまとめにしてゆっくり回す。回す層を減らして軽く） */}
      <svg className="reactor__layer rx__spin rx__spin--ring" viewBox="0 0 600 600" aria-hidden="true">
        <circle cx={C} cy={C} r="292" className="rx__dots" />
        {BRACKETS.map((d) => {
          const [x1, y1] = polar(262, d - 4);
          const [x2, y2] = polar(274, d);
          const [x3, y3] = polar(262, d + 4);
          return <path key={d} className="rx__bracket" d={`M${f(x1)} ${f(y1)}L${f(x2)} ${f(y2)}L${f(x3)} ${f(y3)}`} />;
        })}
        {/* 光り：drop-shadow は重いので、太く薄い線を下に重ねる */}
        <path className="rx__ring-glow" d={arc(222, -62, 62)} />
        <path className="rx__ring-glow" d={arc(222, 118, 242)} />
        <path className="rx__ring" d={arc(222, -62, 62)} />
        <path className="rx__ring" d={arc(222, 118, 242)} />
        <path className="rx__ring rx__ring--thin" d={arc(222, 70, 110)} />
        <path className="rx__ring rx__ring--thin" d={arc(222, 250, 290)} />
      </svg>

      {/* 中心の光る太陽と光の点の網（作ったホログラムを出している間は隠す） */}
      <div className="reactor__core">
        <ParticleCore mode={mode} active={active && !modelShown} onSlow={onSlow} />
      </div>

      <div className="reactor__holo">
        <Hologram phase={phase} speaking={speaking} active={active} modelOnly />
      </div>
    </div>
  );
});
