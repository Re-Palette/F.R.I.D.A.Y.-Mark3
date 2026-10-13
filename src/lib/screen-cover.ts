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

/*
 * 幕を開けるのを少し待ってもらう仕組み。新しい画面の重い準備（3D の地球儀を作る・初めて描く）を幕の裏で済ませ、
 * 幕が開く動きの途中で画面が止まらないようにする。待つのは準備が終わるまで（演出の側で上限を決める）。
 */
const holds = new Set<symbol>();
const waiters = new Set<() => void>();

/** 幕を開けるのを待ってもらう。返す関数を呼ぶと待つのをやめる（何度呼んでもよい） */
export function holdReveal(): () => void {
  const id = Symbol("hold");
  holds.add(id);
  return () => {
    if (!holds.delete(id) || holds.size) return;
    for (const fn of [...waiters]) fn();
  };
}

/** 待ってもらっている準備が無くなったら fn を呼ぶ（もう無ければすぐ）。返す関数で取り消す */
export function whenRevealReady(fn: () => void): () => void {
  if (!holds.size) {
    fn();
    return () => {};
  }
  const once = () => {
    waiters.delete(once);
    fn();
  };
  waiters.add(once);
  return () => waiters.delete(once);
}
