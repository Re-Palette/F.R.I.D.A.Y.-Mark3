/**
 * 性能の低いパソコン（薄型タブレット向けの省電力 CPU など）か。
 * そうなら、見た目はそのままで、3D・粒子・ホログラムの描く細かさとコマ数を最初から抑える
 *（描いてから「重い」と分かって落とすのでは、その間カクつくため）。
 *   - CPU のコア（スレッド）が 4 つ以下、または メモリが 4GB 以下
 *   - 画面からの指定：localStorage "friday.low-power" = "1"（常に軽く）/ "0"（常に通常）
 */
let cached: boolean | null = null;

export function isLowPowerDevice(): boolean {
  if (cached !== null) return cached;
  if (typeof navigator === "undefined") return false;
  let forced: string | null = null;
  try {
    forced = localStorage.getItem("friday.low-power");
  } catch {
    /* 使えなくてもよい */
  }
  const cores = navigator.hardwareConcurrency || 0;
  const memory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 0;
  cached = forced === "1" || forced === "0" ? forced === "1" : (cores > 0 && cores <= 4) || (memory > 0 && memory <= 4);
  // 画面の側（CSS）でも分かるように印を付ける
  if (cached && typeof document !== "undefined") document.documentElement.dataset.lowPower = "";
  return cached;
}
