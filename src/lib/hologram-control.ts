/**
 * 3D ホログラムの向き・大きさ。マウスのドラッグと、カメラでの手の動き（HandControl）の両方から動かす。
 * 毎フレーム読むので React の state ではなく、ただのオブジェクトで持つ。
 */
export interface HandCursor {
  /** 画面上の位置（0〜1、鏡に映したように左右をそろえた値） */
  x: number;
  y: number;
  pinching: boolean;
}

export const holo = {
  /** 手やマウスで与えた回転の速さ（ラジアン/フレーム）。少しずつ弱まる */
  spinX: 0,
  spinY: 0,
  /** 手で動かした分のうち、まだ回していない残り（ラジアン）。毎フレーム少しずつ回して、なめらかにつなぐ */
  aimX: 0,
  aimY: 0,
  /** 大きさ（1 が標準） */
  zoom: 1,
  /** 元の向きに戻す合図（増えたら戻す） */
  resets: 0,
  /** 見えている手（0〜2）と、その位置 */
  cursors: [] as HandCursor[],
};

export const ZOOM_MIN = 0.6;
export const ZOOM_MAX = 1.7;

export function rotateBy(dx: number, dy: number) {
  holo.spinY += dx;
  holo.spinX += dy;
}

/**
 * 手の動きで回す。手の認識は 1 秒に十数回なので、そのたびに勢いを足すと「ガクッ→減速」を繰り返してカクついて見える。
 * そこで、動かした量を「残り」として貯め、描画のたびに少しずつ回して途切れなく見せる。
 */
const STEER_GAIN = 6;
export function steerBy(dx: number, dy: number) {
  holo.aimY += dx * STEER_GAIN;
  holo.aimX += dy * STEER_GAIN;
}

export function zoomBy(factor: number) {
  holo.zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, holo.zoom * factor));
}

export function resetView() {
  holo.spinX = 0;
  holo.spinY = 0;
  holo.aimX = 0;
  holo.aimY = 0;
  holo.zoom = 1;
  holo.resets++;
}
