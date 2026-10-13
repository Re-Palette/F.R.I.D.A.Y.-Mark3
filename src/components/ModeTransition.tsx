"use client";

/**
 * AI のモード（F.R.I.D.A.Y. / K.A.R.E.N. / E.D.I.T.H.）が切り替わるときの演出。
 *   1. 幕を閉じる（約 1 秒）：閃光・前のモードの色の残像・走査線 → 切り替え先の色の輪と名前で画面を覆う
 *   2. 覆っている間に、裏で画面を切り替える（新しい画面が描き終わるまで待つ）
 *   3. 幕を開く（約 0.9 秒）：中心から円が広がって、新しい画面が現れる
 * 会話・声の行き先（モードそのもの）はすぐ切り替わる。遅らせるのは「見せる画面」だけ。
 * 動きは transform と opacity だけで作る（GPU で動くのでカクつきにくい）。
 * ページを開いた直後（保存してあったモードに戻るとき）は演出しない。「視差効果を減らす」設定なら短いフェードだけ。
 * 拍手 2 回の起動（playBoot）でも、同じ幕で「ALL SYSTEMS ONLINE」を見せる（起動の一言に合わせて少し長め。画面は切り替えない）。
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal, flushSync } from "react-dom";
import type { AiMode } from "@/lib/ai-mode";
import { bootGreeting } from "@/lib/boot-line";
import { setScreenCovered, whenRevealReady } from "@/lib/screen-cover";

const META: Record<AiMode, { name: string; sub: string; caption: string }> = {
  friday: { name: "F.R.I.D.A.Y.", sub: "STANDARD PROTOCOL", caption: "通常モードに復帰" },
  karen: { name: "K.A.R.E.N.", sub: "CREATIVE PROTOCOL", caption: "クリエイティブモードを起動" },
  edith: { name: "E.D.I.T.H.", sub: "GLOBAL INTELLIGENCE PROTOCOL", caption: "グローバルインテリジェンスモードを起動" },
};

/*
 * 幕が閉じきる時刻（約 0.95 秒）と、幕を開け始めてよい時刻（約 1.65 秒）は、CSS の目印のアニメーション
 * （ms-cover-mark / ms-hold-mark）が終わったことで知る。時計で数えると、重い処理で画面が止まったときに
 * 幕が見える前に画面が切り替わってしまうため（アニメーションは画面が描かれた分しか進まない）。
 */
/** 念のための上限（どんなに遅くてもこの時間で片付ける） */
const SAFETY_MS = 10_000;
/** 開いた直後のモードの読み込み（保存していたモードに戻る）は演出しない */
const BOOT_QUIET_MS = 1200;
/** 新しい画面の重い準備（3D を作る）を幕の裏で待つ上限。これを過ぎたら準備の途中でも幕を開ける */
const PREPARE_WAIT_MAX_MS = 2500;

type Phase = "cover" | "reveal" | "reduced";
interface Run {
  /** 切り替え（switch）か、拍手 2 回の起動（boot） */
  kind: "switch" | "boot";
  from: AiMode;
  to: AiMode;
  key: number;
  phase: Phase;
  /** 幕を開け始めてよい時刻を過ぎた */
  held: boolean;
}

const reducedMotion = () => typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

/**
 * 見せる画面のモード（shown）と、演出の重ね（overlay）を返す。
 * 画面の出し分けには shown を使う（mode をそのまま使うと、演出の前に新しい画面が見えてしまう）。
 */
export function useModeTransition(mode: AiMode): { shown: AiMode; overlay: ReactNode; playBoot: () => void } {
  const [shown, setShown] = useState<AiMode>(mode);
  const [run, setRun] = useState<Run | null>(null);
  const prev = useRef(mode);
  const mountedAt = useRef(0);

  useEffect(() => {
    mountedAt.current = performance.now();
  }, []);

  // モードが変わったら、画面を描く前に幕を出す（新しい画面はまだ見せない）
  useLayoutEffect(() => {
    if (prev.current === mode) return;
    const from = prev.current;
    prev.current = mode;
    if (!mountedAt.current || performance.now() - mountedAt.current < BOOT_QUIET_MS) {
      setShown(mode);
      setRun(null);
      return;
    }
    if (reducedMotion()) {
      setShown(mode);
      setRun({ kind: "switch", from, to: mode, key: Date.now(), phase: "reduced", held: true });
      return;
    }
    setRun({ kind: "switch", from, to: mode, key: Date.now(), phase: "cover", held: false });
  }, [mode]);

  /**
   * 拍手 2 回の起動の演出（いまの画面のまま。切り替えの途中なら、そちらを優先する）。
   * 画面が裏から前に出てくる途中で呼ばれるので、幕は最初から不透明で出し、下の画面もすぐ隠す
   * （前に出た瞬間に F.R.I.D.A.Y. の画面が一瞬見えないように。React の描画を待たずに隠す）。
   */
  const playBoot = useCallback(() => {
    const m = prev.current;
    const reduced = reducedMotion();
    if (!reduced) setScreenCovered(true);
    flushSync(() =>
      setRun((r) => (r && r.kind === "switch" ? r : { kind: "boot", from: m, to: m, key: Date.now(), phase: reduced ? "reduced" : "cover", held: reduced })),
    );
  }, []);

  // 新しい画面ができて、名前を見せる時間も過ぎて、重い準備（3D を作る）も済んだら：
  // 下の画面を描き始め（幕の裏で 2 フレーム描かせてから）、幕を開ける（準備が長引いても上限で開ける）
  useEffect(() => {
    if (!run || run.phase !== "cover" || !run.held || shown !== run.to) return;
    const ids: number[] = [];
    let started = false;
    const after = (n: number, f: () => void) => {
      if (n <= 0) return f();
      ids.push(requestAnimationFrame(() => after(n - 1, f)));
    };
    const open = () => {
      if (started) return;
      started = true;
      after(2, () => {
        setScreenCovered(false);
        after(2, () => setRun((r) => (r && r.key === run.key ? { ...r, phase: "reveal" } : r)));
      });
    };
    const cap = window.setTimeout(open, PREPARE_WAIT_MAX_MS);
    const cancelWait = whenRevealReady(open);
    return () => {
      cancelWait();
      clearTimeout(cap);
      ids.forEach(cancelAnimationFrame);
    };
  }, [run, shown]);

  // 演出が終わったら（どんな終わり方でも）、下の画面を必ず描くように戻す
  useEffect(() => {
    if (!run || run.phase === "reduced") setScreenCovered(false);
  }, [run]);
  useEffect(() => () => setScreenCovered(false), []);

  // 念のための上限
  const runKey = run?.key;
  useEffect(() => {
    if (runKey === undefined) return;
    const t = setTimeout(() => {
      setShown(prev.current);
      setRun((r) => (r && r.key === runKey ? null : r));
    }, SAFETY_MS);
    return () => clearTimeout(t);
  }, [runKey]);

  const overlay = run
    ? createPortal(
        <Overlay
          run={run}
          // 幕が不透明になったら、下の画面を描くのを止める（処理を演出に譲る）
          onOpaque={() => setScreenCovered(true)}
          // 幕が閉じきったら、裏で画面を切り替える
          onCovered={() => setShown(run.to)}
          onHeld={() => setRun((r) => (r && r.key === run.key ? { ...r, held: true } : r))}
          onDone={() => setRun((r) => (r && r.key === run.key ? null : r))}
        />,
        document.body,
      )
    : null;
  return { shown, overlay, playBoot };
}

function Overlay({ run, onOpaque, onCovered, onHeld, onDone }: { run: Run; onOpaque: () => void; onCovered: () => void; onHeld: () => void; onDone: () => void }) {
  const m = META[run.to];
  const boot = run.kind === "boot";
  return (
    <div
      key={run.key}
      className="mswitch"
      data-kind={run.kind}
      data-from={run.from}
      data-to={run.to}
      data-phase={run.phase}
      aria-hidden="true"
      onAnimationEnd={(e) => {
        if (e.animationName === "ms-cover-mark") onCovered();
        else if (e.target === e.currentTarget && e.animationName === "ms-in" && run.phase === "cover") onOpaque();
        else if (e.animationName === "ms-hold-mark") onHeld();
        else if (e.target === e.currentTarget && e.animationName === "ms-out") onDone();
      }}
    >
      {/* 時間の目印（見えない）。幕が閉じきった・開け始めてよい、を知らせる */}
      <i className="mswitch__mark mswitch__mark--cover" />
      <i className="mswitch__mark mswitch__mark--hold" />
      {/* 幕：丸い穴のまわりを大きな影で塗る。穴を広げると（transform だけで）新しい画面が見えてくる */}
      <div className="mswitch__shutter" />
      <div className="mswitch__tint" />
      <div className="mswitch__grid" />
      <div className="mswitch__ghost" />
      <div className="mswitch__scan" />
      <div className="mswitch__flash" />
      <div className="mswitch__fx">
        <span className="mswitch__bracket mswitch__bracket--l" />
        <span className="mswitch__bracket mswitch__bracket--r" />
        <div className="mswitch__core">
          <svg className="ms-ring ms-ring--1" viewBox="0 0 200 200">
            <circle cx="100" cy="100" r="96" />
          </svg>
          <svg className="ms-ring ms-ring--2" viewBox="0 0 200 200">
            <circle cx="100" cy="100" r="86" />
          </svg>
          <svg className="ms-ring ms-ring--ticks" viewBox="0 0 200 200">
            {Array.from({ length: 60 }, (_, i) => {
              const a = (i * 6 * Math.PI) / 180;
              const r1 = i % 5 === 0 ? 72 : 76;
              return <line key={i} x1={100 + Math.cos(a) * r1} y1={100 + Math.sin(a) * r1} x2={100 + Math.cos(a) * 80} y2={100 + Math.sin(a) * 80} />;
            })}
          </svg>
          <svg className="ms-ring ms-ring--core" viewBox="0 0 200 200">
            <circle cx="100" cy="100" r="64" className="ms-r3" />
            <path d="M100 52 L141.6 76 V124 L100 148 L58.4 124 V76 Z" className="ms-hex" />
          </svg>
          <div className="mswitch__text">
            <small>{boot ? "SYSTEM BOOT" : "PROTOCOL SWITCH"}</small>
            <b>
              {Array.from(m.name).map((ch, i) => (
                <span key={i} style={{ ["--i" as string]: i }}>{ch}</span>
              ))}
            </b>
            <span className="mswitch__sub">{boot ? "ALL SYSTEMS ONLINE" : m.sub}</span>
            <span className="mswitch__bar"><i /></span>
            <em>{boot ? `${bootGreeting()}, sir.` : m.caption}</em>
          </div>
        </div>
      </div>
      <div className="mswitch__iris" />
    </div>
  );
}
