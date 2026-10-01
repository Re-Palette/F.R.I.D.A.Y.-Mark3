"use client";

/**
 * 画面全体を囲む HUD の枠（HOME のときだけ見せる）。
 * 角の欠け・上のバー・内側の細い線・四隅の太い角・斜線の刻みを、実際の画面の大きさ（px）で描く
 * （引き伸ばすと角の形が崩れるため、大きさが変わるたびに描き直す）。
 */
import { useEffect, useRef, useState } from "react";

export function ScreenFrame() {
  const ref = useRef<SVGSVGElement>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const fit = () => setSize({ w: el.clientWidth, h: el.clientHeight });
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  let body = null;
  if (size && size.w > 200 && size.h > 200) {
    const { w: W, h: H } = size;
    const m = 2;
    const c = 22; // 角の欠け
    const bar = 46; // 上のバーの下端
    const i = 14; // 内側の線の距離
    const ci = 14;
    const outer = `M${m + c} ${m}H${W - m - c}L${W - m} ${m + c}V${H - m - c}L${W - m - c} ${H - m}H${m + c}L${m} ${H - m - c}V${m + c}Z`;
    const inner = `M${m + i} ${bar + 18}V${H - m - i - ci}L${m + i + ci} ${H - m - i}H${W / 2 - 230}M${W / 2 + 230} ${H - m - i}H${W - m - i - ci}L${W - m - i} ${H - m - i - ci}V${bar + 18}`;
    const topBar = `M${m + 30} ${bar}H${W * 0.3}L${W * 0.3 + 14} ${bar + 12}H${W * 0.7 - 14}L${W * 0.7} ${bar}H${W - m - 30}`;
    const L = 64;
    const corners = [
      `M${m} ${m + c + L}V${m + c}L${m + c} ${m}H${m + c + L}`,
      `M${W - m - c - L} ${m}H${W - m - c}L${W - m} ${m + c}V${m + c + L}`,
      `M${W - m} ${H - m - c - L}V${H - m - c}L${W - m - c} ${H - m}H${W - m - c - L}`,
      `M${m + c + L} ${H - m}H${m + c}L${m} ${H - m - c}V${H - m - c - L}`,
    ];
    const hatch = (x0: number, y: number, n: number) =>
      Array.from({ length: n }, (_, k) => `M${x0 + k * 7} ${y + 6}L${x0 + k * 7 + 5} ${y}`).join("");
    body = (
      <>
        {/* 光り：drop-shadow は重いので、太く薄い線を下に重ねる */}
        <path className="sframe__glow" d={outer} />
        {corners.map((d) => (
          <path key={`g${d}`} className="sframe__glow sframe__glow--corner" d={d} />
        ))}
        <path className="sframe__outer" d={outer} />
        <path className="sframe__bar" d={topBar} />
        <path className="sframe__inner" d={inner} />
        {corners.map((d) => (
          <path key={d} className="sframe__corner" d={d} />
        ))}
        <path className="sframe__hatch" d={hatch(W * 0.24, H - m - 9, 12) + hatch(W * 0.7, H - m - 9, 12) + hatch(W - m - 150, bar - 12, 10)} />
      </>
    );
  }

  return (
    <svg ref={ref} className="screen-frame" aria-hidden="true">
      {body}
    </svg>
  );
}
