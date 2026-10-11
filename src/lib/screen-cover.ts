/**
 * モード切り替え・拍手の起動の演出が、画面をすっかり覆っている間の印。
 *   覆っている間は、下の画面を描かない（html[data-screen-covered] で隠す）・重い描画（3D・粒子）を止める。
 *   演出がなめらかに動くように、画面の処理を演出に譲るため。幕を開ける少し前に戻して、新しい画面を先に描いておく。
 */
let covered = false;

export function isScreenCovered(): boolean {
  return covered;
}

export function setScreenCovered(v: boolean): void {
  if (covered === v) return;
  covered = v;
  if (typeof document === "undefined") return;
  if (v) document.documentElement.dataset.screenCovered = "";
  else delete document.documentElement.dataset.screenCovered;
}
