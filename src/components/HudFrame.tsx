"use client";

/**
 * HUD フレーム — 角を斜めに切り落としたメカニカルな枠。
 * 親要素の実寸に合わせて SVG をピクセル単位で描くので、線が常にシャープ（歪まない）。
 * 親要素は position: relative / isolation: isolate であること（.hud クラスで付与）。
 */
import { useId, useLayoutEffect, useRef, useState } from "react";

interface Props {
  /** 左上・右下の大きな切り欠き */
  cut?: number;
  /** 右上・左下の小さな切り欠き */
  small?: number;
  /** 下辺の目盛り */
  ticks?: boolean;
  /** 右上の状態 LED ブロック */
  leds?: boolean;
  /** 上辺中央のノッチ（タブ） */
  notch?: boolean;
}

interface Size {
  w: number;
  h: number;
}

const O = 0.5; // 1px 線をピクセルグリッドに合わせる

export function HudFrame({ cut = 14, small = 5, ticks = true, leds = false, notch = false }: Props) {
  const ref = useRef<SVGSVGElement>(null);
  const [size, setSize] = useState<Size | null>(null);
  const gid = `hudg${useId().replace(/[^a-zA-Z0-9]/g, "")}`;

  useLayoutEffect(() => {
    const el = ref.current?.parentElement;
    if (!el) return;
    const update = () =>
      setSize((s) => {
        const w = el.offsetWidth;
        const h = el.offsetHeight;
        return s && s.w === w && s.h === h ? s : { w, h };
      });
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  let body = null;
  if (size && size.w > 2 * cut && size.h > 2 * cut) {
    const { w, h } = size;
    const r = w - O;
    const b = h - O;
    const s = small;
    const n = Math.min(90, w * 0.22); // ノッチ幅
    const nx = w / 2;

    const outline = [
      `M${cut} ${O}`,
      ...(notch ? [`H${nx - n / 2 - 6}`, `L${nx - n / 2} ${O + 4}`, `H${nx + n / 2}`, `L${nx + n / 2 + 6} ${O}`] : []),
      `H${r - s}`,
      `L${r} ${O + s}`,
      `V${b - cut}`,
      `L${r - cut} ${b}`,
      `H${O + s}`,
      `L${O} ${b - s}`,
      `V${O + cut}`,
      "Z",
    ].join(" ");

    // 内側の細い二重線（3px 内側）
    const i = 3.5;
    const inner = [
      `M${cut + i * 0.6} ${i}`,
      `H${r - s - i * 0.4}`,
      `L${r - i} ${s + i * 0.4}`,
      `V${b - cut - i * 0.6}`,
      `L${r - cut - i * 0.6} ${b - i}`,
      `H${s + i * 0.4}`,
      `L${i} ${b - s - i * 0.4}`,
      `V${cut + i * 0.6}`,
      "Z",
    ].join(" ");
    const accentTL = `M${O} ${O + cut + 22} V${O + cut} L${cut} ${O} H${cut + 56}`;
    const accentBR = `M${r - cut - 48} ${b} H${r - cut} L${r} ${b - cut} V${b - cut - 22}`;

    body = (
      <>
        <defs>
          <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" className="hud-frame__glass-top" />
            <stop offset="0.35" className="hud-frame__glass-mid" />
            <stop offset="1" className="hud-frame__glass-bottom" />
          </linearGradient>
        </defs>
        <path className="hud-frame__fill" d={outline} />
        <path className="hud-frame__glass" d={outline} fill={`url(#${gid})`} />
        <path className="hud-frame__line" d={outline} />
        <path className="hud-frame__inner" d={inner} />
        <path className="hud-frame__accent" d={accentTL} />
        <path className="hud-frame__accent" d={accentBR} />
        {ticks && (
          <g className="hud-frame__ticks">
            {Array.from({ length: 7 }, (_, i) => {
              const x = O + s + 12 + i * 6;
              return <line key={i} x1={x} y1={b - (i % 3 === 0 ? 6 : 3.5)} x2={x} y2={b} />;
            })}
          </g>
        )}
        {/* 四隅のボルトと、右上の通気口（メカニカルな部品らしさ） */}
        {w > 90 && h > 50 && (
          <g className="hud-frame__bolts">
            {[
              [cut * 0.55 + 7, 7],
              [r - 8, s + 8],
              [r - cut * 0.55 - 7, b - 7],
              [8, b - s - 8],
            ].map(([x, y], k) => (
              <g key={k}>
                <circle cx={x} cy={y} r="2.4" />
                <path d={`M${x - 1.4} ${y}H${x + 1.4}`} />
              </g>
            ))}
          </g>
        )}
        {w > 160 && (
          <g className="hud-frame__vents">
            {[0, 1, 2, 3].map((k) => (
              <path key={k} d={`M${r - s - 30 + k * 5} ${b - 3} l4 -6`} />
            ))}
          </g>
        )}
        {leds && (
          <g className="hud-frame__leds">
            {[0, 1, 2].map((i) => (
              <path key={i} d={`M${r - s - 44 + i * 12} ${O + 3} h8 l-2 3 h-8 z`} />
            ))}
          </g>
        )}
      </>
    );
  }

  return (
    <svg ref={ref} className="hud-frame" width={size?.w ?? 0} height={size?.h ?? 0} aria-hidden="true">
      {body}
    </svg>
  );
}
