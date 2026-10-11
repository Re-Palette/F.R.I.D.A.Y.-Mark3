"use client";

/**
 * AI のモード（F.R.I.D.A.Y. / K.A.R.E.N. / E.D.I.T.H.）が切り替わるときの演出。
 *   一瞬の閃光 → 前のモードの色が走査線とともに消える → 切り替え先の色で輪が回りながら名前が浮かぶ
 *   → 中心から円が広がって、新しい画面が現れる（約 1.9 秒）
 * 操作のじゃまをしない（クリックは下の画面に通る）。「視差効果を減らす」設定なら短いフェードだけ。
 * ページを開いた直後（保存してあったモードに戻るとき）は演出しない。
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { AiMode } from "@/lib/ai-mode";

const META: Record<AiMode, { name: string; sub: string; caption: string }> = {
  friday: { name: "F.R.I.D.A.Y.", sub: "STANDARD PROTOCOL", caption: "通常モードに復帰" },
  karen: { name: "K.A.R.E.N.", sub: "CREATIVE PROTOCOL", caption: "クリエイティブモードを起動" },
  edith: { name: "E.D.I.T.H.", sub: "GLOBAL INTELLIGENCE PROTOCOL", caption: "グローバルインテリジェンスモードを起動" },
};

/**
 * 演出は CSS の最後のアニメーション（ms-out）が終わったら片付ける。
 * 切り替え先の画面の準備で動きが遅れても途中で消えないように、時間では切らない（念のための上限だけ）。
 */
const SAFETY_MS = 8000;
/** 開いた直後のモードの読み込み（保存していたモードに戻る）は演出しない */
const BOOT_QUIET_MS = 1200;

export function ModeTransition({ mode }: { mode: AiMode }) {
  const prev = useRef(mode);
  const mountedAt = useRef(0);
  const [run, setRun] = useState<{ from: AiMode; to: AiMode; key: number } | null>(null);

  useEffect(() => {
    mountedAt.current = performance.now();
  }, []);

  // 画面が描かれる前に重ねる（新しい画面が一瞬見えてしまわないように）
  useLayoutEffect(() => {
    if (prev.current === mode) return;
    const from = prev.current;
    prev.current = mode;
    if (!mountedAt.current || performance.now() - mountedAt.current < BOOT_QUIET_MS) return;
    setRun({ from, to: mode, key: Date.now() });
  }, [mode]);

  useEffect(() => {
    if (!run) return;
    const t = setTimeout(() => setRun(null), SAFETY_MS);
    return () => clearTimeout(t);
  }, [run]);

  if (!run) return null;
  const m = META[run.to];
  return createPortal(
    <div
      key={run.key}
      className="mswitch"
      data-from={run.from}
      data-to={run.to}
      aria-hidden="true"
      onAnimationEnd={(e) => {
        if (e.target === e.currentTarget && e.animationName === "ms-out") setRun(null);
      }}
    >
      <div className="mswitch__bg" />
      <div className="mswitch__grid" />
      <div className="mswitch__ghost" />
      <div className="mswitch__scan" />
      <div className="mswitch__flash" />
      <span className="mswitch__bracket mswitch__bracket--l" />
      <span className="mswitch__bracket mswitch__bracket--r" />
      <div className="mswitch__core">
        <svg className="mswitch__rings" viewBox="0 0 200 200">
          <circle cx="100" cy="100" r="96" className="ms-r1" />
          <circle cx="100" cy="100" r="86" className="ms-r2" />
          <g className="ms-ticks">
            {Array.from({ length: 60 }, (_, i) => {
              const a = (i * 6 * Math.PI) / 180;
              const r1 = i % 5 === 0 ? 72 : 76;
              return <line key={i} x1={100 + Math.cos(a) * r1} y1={100 + Math.sin(a) * r1} x2={100 + Math.cos(a) * 80} y2={100 + Math.sin(a) * 80} />;
            })}
          </g>
          <circle cx="100" cy="100" r="64" className="ms-r3" />
          <path d="M100 52 L141.6 76 V124 L100 148 L58.4 124 V76 Z" className="ms-hex" />
        </svg>
        <div className="mswitch__text">
          <small>PROTOCOL SWITCH</small>
          <b>
            {Array.from(m.name).map((ch, i) => (
              <span key={i} style={{ ["--i" as string]: i }}>{ch}</span>
            ))}
          </b>
          <span className="mswitch__sub">{m.sub}</span>
          <span className="mswitch__bar"><i /></span>
          <em>{m.caption}</em>
        </div>
      </div>
      <div className="mswitch__iris" />
    </div>,
    document.body,
  );
}
