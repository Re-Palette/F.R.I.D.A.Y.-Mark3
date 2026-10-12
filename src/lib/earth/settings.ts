/**
 * GOD'S EYE VIEW（EARTH）のレイヤーの設定（この端末だけに保存）。LOCAL FEED の設定（edith-display.ts）とは別に持つ。
 * 保存するのは、レイヤーの ON/OFF・衛星のグループと数・自動回転だけ（位置やデータは保存しない）。
 * 壊れた値・知らない値は既定に戻す。
 */
import { isSatGroup, SAT_LIMIT_DEFAULT, SAT_LIMIT_MAX, type SatGroup } from "./satellites";

export const EARTH_SETTINGS_KEY = "friday.edith-earth.v1";

export interface EarthSettings {
  /** 地震のレイヤー */
  quakes: boolean;
  /** 人工衛星のレイヤー */
  sats: boolean;
  satGroup: SatGroup;
  /** 描く衛星の数 */
  satLimit: number;
  /** 地球をゆっくり回す（操作している間・追従している間は止める） */
  autoRotate: boolean;
}

export const DEFAULT_EARTH: EarthSettings = { quakes: true, sats: true, satGroup: "stations", satLimit: SAT_LIMIT_DEFAULT, autoRotate: true };

export function parseEarthSettings(raw: unknown): EarthSettings {
  const o = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const d = DEFAULT_EARTH;
  const limit = typeof o.satLimit === "number" && Number.isFinite(o.satLimit) ? Math.round(o.satLimit) : d.satLimit;
  return {
    quakes: typeof o.quakes === "boolean" ? o.quakes : d.quakes,
    sats: typeof o.sats === "boolean" ? o.sats : d.sats,
    satGroup: isSatGroup(o.satGroup) ? o.satGroup : d.satGroup,
    satLimit: Math.min(SAT_LIMIT_MAX, Math.max(1, limit)),
    autoRotate: typeof o.autoRotate === "boolean" ? o.autoRotate : d.autoRotate,
  };
}
