/**
 * 大きさが変わり続けている間（返事の欄が伸びていく間など）は作り直さず、落ち着いてから 1 回だけ呼ぶ。
 * canvas は CSS で枠いっぱいに伸び縮みするので、その間も見た目は崩れない。毎フレーム作り直して重くなるのを防ぐ。
 */
export function settled(fn: () => void, ms = 140): (() => void) & { cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const run = () => {
    clearTimeout(timer);
    timer = setTimeout(fn, ms);
  };
  return Object.assign(run, { cancel: () => clearTimeout(timer) });
}

/**
 * 描く板（canvas）を作り直す価値があるほど大きさが変わったか。
 * 返事が流れ込む間、枠は少しずつ何度も縮む。そのたびに作り直すと重い（とくに 3D）ので、
 * 縦横の比がほぼ同じなら、縮むときは 40% 未満、伸びるときは 15% 未満の変化では作り直さず、CSS で伸び縮みさせるだけにする
 * （縮める分には見た目はほとんど変わらない。伸ばすとぼやけるので早めに作り直す）。
 */
export function resizeWorthIt(prev: { w: number; h: number } | null, w: number, h: number, shrink = 0.4, grow = 0.15): boolean {
  if (!prev || prev.w <= 0 || prev.h <= 0 || w <= 0 || h <= 0) return true;
  const aspectChange = Math.abs(w / h - prev.w / prev.h) / (prev.w / prev.h);
  if (aspectChange > 0.02) return true;
  const change = (w - prev.w) / prev.w;
  return change < 0 ? -change >= shrink : change >= grow;
}
