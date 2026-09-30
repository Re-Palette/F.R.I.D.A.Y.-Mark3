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

export function zoomBy(factor: number) {
  holo.zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, holo.zoom * factor));
}

export function resetView() {
  holo.spinX = 0;
  holo.spinY = 0;
  holo.zoom = 1;
  holo.resets++;
}
