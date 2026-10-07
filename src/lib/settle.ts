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
