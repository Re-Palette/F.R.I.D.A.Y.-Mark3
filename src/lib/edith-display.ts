/**
 * E.D.I.T.H. の表示設定（右の DISPLAY パネル・下の VISUAL PRESETS）と、太陽の高度の計算。
 *   - 表示設定はこの端末だけに保存する（壊れた値・知らない値は既定に戻す）
 *   - 映像（God's Eye View）に効く設定は、映像を入れる枠に CSS 変数・data 属性として渡す
 */

export type DisplayLayout = "tactical" | "minimal";
export type DisplayAllocation = "elastic" | "weighted";

export interface DisplaySettings {
  /** 円のまわりの計器（目盛り・光る弧・LIVE 表示） */
  hud: boolean;
  /** tactical：飾りの計器も出す ／ minimal：飾りを減らす */
  layout: DisplayLayout;
  /** 映像の上の目印を間引く（映像の接続後に使う） */
  sparse: boolean;
  /** 目印の密度 0〜100（映像の接続後に使う） */
  density: number;
  /** 目印の配置（映像の接続後に使う） */
  allocation: DisplayAllocation;
  /** 円のふちを暗くぼかす量 0〜100 */
  fade: number;
  /** 円の外側の光 0〜100 */
  outside: number;
  /** 背景の星 */
  celestial: boolean;
  /** 映像を明るく光らせる */
  bloom: boolean;
  /** 映像をくっきりさせる */
  sharpen: boolean;
  /** くっきりさせる量 0〜100 */
  sharpenAmt: number;
  /** 映像を斜めに傾けて立体的に見せる */
  threeD: boolean;
  /** 左右のパネルを隠して映像だけにする */
  clean: boolean;
}

export const DEFAULT_DISPLAY: DisplaySettings = {
  hud: true,
  layout: "tactical",
  sparse: false,
  density: 0,
  allocation: "elastic",
  fade: 16,
  outside: 0,
  celestial: false,
  bloom: false,
  sharpen: true,
  sharpenAmt: 49,
  threeD: false,
  clean: false,
};

export const PRESETS = [
  { key: "tactical", label: "TACTICAL", values: {} },
  { key: "cinematic", label: "CINEMATIC", values: { bloom: true, celestial: true, fade: 42, outside: 35, sharpenAmt: 30 } },
  { key: "minimal", label: "MINIMAL", values: { hud: false, layout: "minimal", fade: 0, outside: 0, bloom: false, celestial: false } },
] as const satisfies readonly { key: string; label: string; values: Partial<DisplaySettings> }[];
export type PresetKey = (typeof PRESETS)[number]["key"];

/** プリセットを当てた設定（いつも既定から作るので、前の設定が残らない。CLEAN UI だけは今のまま） */
export function applyPreset(key: PresetKey, current: DisplaySettings): DisplaySettings {
  const p = PRESETS.find((x) => x.key === key) ?? PRESETS[0];
  return { ...DEFAULT_DISPLAY, ...(p.values as Partial<DisplaySettings>), clean: current.clean };
}

export function nextPreset(key: PresetKey): PresetKey {
  const i = PRESETS.findIndex((p) => p.key === key);
  return PRESETS[(i + 1) % PRESETS.length].key;
}

const pct = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? Math.min(100, Math.max(0, Math.round(v))) : d);
const bool = (v: unknown, d: boolean) => (typeof v === "boolean" ? v : d);

/** 保存してあった値を読む（形の違う値・範囲外の値は既定や端に直す） */
export function parseDisplay(raw: unknown): DisplaySettings {
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const d = DEFAULT_DISPLAY;
  return {
    hud: bool(o.hud, d.hud),
    layout: o.layout === "minimal" || o.layout === "tactical" ? o.layout : d.layout,
    sparse: bool(o.sparse, d.sparse),
    density: pct(o.density, d.density),
    allocation: o.allocation === "weighted" || o.allocation === "elastic" ? o.allocation : d.allocation,
    fade: pct(o.fade, d.fade),
    outside: pct(o.outside, d.outside),
    celestial: bool(o.celestial, d.celestial),
    bloom: bool(o.bloom, d.bloom),
    sharpen: bool(o.sharpen, d.sharpen),
    sharpenAmt: pct(o.sharpenAmt, d.sharpenAmt),
    threeD: bool(o.threeD, d.threeD),
    clean: bool(o.clean, d.clean),
  };
}

/**
 * 太陽の高度（度。地平線より下はマイナス）。誤差はおよそ 1° 以内の簡易計算。
 * 日時と緯度・経度から計算するだけで、外部のデータは使わない。
 */
export function solarElevation(date: Date, lat: number, lon: number): number {
  const rad = Math.PI / 180;
  const n = date.getTime() / 86_400_000 + 2440587.5 - 2451545.0;
  const L = (280.46 + 0.9856474 * n) % 360;
  const g = ((357.528 + 0.9856003 * n) % 360) * rad;
  const lambda = (L + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * rad;
  const eps = (23.439 - 0.0000004 * n) * rad;
  const dec = Math.asin(Math.sin(eps) * Math.sin(lambda));
  const ra = Math.atan2(Math.cos(eps) * Math.sin(lambda), Math.cos(lambda));
  const gmst = (((18.697374558 + 24.06570982441908 * n) % 24) + 24) % 24;
  const ha = (gmst * 15 + lon) * rad - ra;
  const el = Math.asin(Math.sin(lat * rad) * Math.sin(dec) + Math.cos(lat * rad) * Math.cos(dec) * Math.cos(ha));
  return el / rad;
}
