/**
 * ずっと動き続ける描画（3D・粒子）の、描き直しの最短間隔。
 *   - 画面の更新が 1 秒 120 回・144 回の画面（最近のノートパソコン・スマホ）では、そのまま描くと 60 回の画面の 2 倍以上の負担になる。
 *     1 秒 60 回くらいまでに抑える。60 回の画面では今までどおり毎回描く（更新の間隔のぶれで飛ばさないよう、少し短めに比べる）
 *   - ほかのアプリを使っている間（このウィンドウを操作していない間）は 1 秒 30 回くらいまでにして、パソコン全体の負担を減らす
 *   動きの速さは経過時間で計算しているので、描く回数が変わっても速さは変わらない。
 */
export const MIN_FRAME_MS = 1000 / 60 - 4;
export const MIN_FRAME_MS_UNFOCUSED = 1000 / 30 - 4;

/** 前に描いてから、まだ描かなくてよいか */
export const tooSoon = (now: number, lastDrawn: number): boolean =>
  now - lastDrawn < (typeof document !== "undefined" && !document.hasFocus() ? MIN_FRAME_MS_UNFOCUSED : MIN_FRAME_MS);
