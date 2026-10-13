/**
 * CesiumJS をこのサイトの /cesium/ から読み込む（ブラウザだけ。scripts/copy-cesium.mjs が public/cesium/ にコピーしたもの）。
 *   - ページの JS には含めない（EARTH を初めて開いたときにだけ読む。初めの読み込みを重くしない）
 *   - 何度呼ばれても 1 回だけ読む（失敗したら、次に呼ばれたとき読み直す）
 *   - 外部の CDN・Cesium ion は使わない
 */
import type * as CesiumNS from "cesium";

export type CesiumModule = typeof CesiumNS;

type WinWithCesium = Window & { Cesium?: CesiumModule; CESIUM_BASE_URL?: string };

export const CESIUM_BASE_URL = "/cesium/";
let loading: Promise<CesiumModule> | null = null;

export function loadCesium(): Promise<CesiumModule> {
  if (typeof window === "undefined") return Promise.reject(new Error("ブラウザでだけ使えます"));
  const w = window as WinWithCesium;
  if (w.Cesium) return Promise.resolve(w.Cesium);
  if (loading) return loading;
  loading = new Promise<CesiumModule>((resolve, reject) => {
    w.CESIUM_BASE_URL = CESIUM_BASE_URL;
    const s = document.createElement("script");
    s.src = `${CESIUM_BASE_URL}Cesium.js`;
    s.async = true;
    s.dataset.edithCesium = "";
    s.onload = () => (w.Cesium ? resolve(w.Cesium) : reject(new Error("3D 地球儀の部品を読み込めませんでした")));
    s.onerror = () => reject(new Error("3D 地球儀の部品を読み込めませんでした"));
    document.head.appendChild(s);
  }).catch((err: unknown) => {
    loading = null;
    document.querySelector("script[data-edith-cesium]")?.remove();
    throw err;
  });
  return loading;
}

/** WebGL が使えるか（ページの中で 1 回だけ調べる） */
export { webglAvailable } from "@/lib/webgl";
