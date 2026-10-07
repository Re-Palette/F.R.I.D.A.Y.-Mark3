/**
 * memo の比べ方：見えていない画面（hidden のまま）は、何が変わっても描き直さない。
 * 返事が流れてくる間、裏の画面まで 1 秒に何十回も描き直して重くなるのを防ぐ（見えたときに最新を描く）。
 */
export function skipWhileHidden<P extends { hidden: boolean }>(prev: Readonly<P>, next: Readonly<P>): boolean {
  if (prev.hidden && next.hidden) return true;
  const keys = Object.keys(next) as (keyof P)[];
  return keys.length === Object.keys(prev).length && keys.every((k) => Object.is(prev[k], next[k]));
}
