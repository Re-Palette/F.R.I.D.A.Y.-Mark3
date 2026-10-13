/**
 * GOD'S EYE VIEW（EARTH）のレイヤーの設定（この端末だけに保存）。LOCAL FEED の設定（edith-display.ts）とは別に持つ。
 * 保存するのは、レイヤーの ON/OFF・衛星のグループと数・自動回転・地球の画像の ON/OFF だけ（位置やデータは保存しない）。
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
  /** 詳細な衛星写真（Sentinel-2 cloudless）。OFF なら同梱の Natural Earth II だけ */
  detail: boolean;
  /** 今日の地球（NASA GIBS の前日の雲の様子） */
  clouds: boolean;
  /** 雨雲レーダー（RainViewer） */
  radar: boolean;
  /** 写真のような 3D の街（Google Photorealistic 3D Tiles。キーが設定されているときだけ） */
  city3d: boolean;
  /** 飛行機（OpenSky Network。寄ったときだけ取りに行く） */
  aircraft: boolean;
  /** 道路の渋滞（TomTom。キーが設定されているときだけ） */
  traffic: boolean;
  /** 都営バスの位置（ODPT。キーが設定されていて、東京に寄ったときだけ） */
  buses: boolean;
  /** 船（AISStream。キーが設定されていて、寄ったときだけ） */
  ships: boolean;
  /** 世界のライブカメラ（Windy。寄って見ている所・ピックアップした所の近く） */
  webcams: boolean;
}

export const DEFAULT_EARTH: EarthSettings = { quakes: true, sats: true, satGroup: "stations", satLimit: SAT_LIMIT_DEFAULT, autoRotate: true, detail: true, clouds: false, radar: false, city3d: true, aircraft: true, traffic: true, buses: true, ships: true, webcams: true };

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
    detail: typeof o.detail === "boolean" ? o.detail : d.detail,
    clouds: typeof o.clouds === "boolean" ? o.clouds : d.clouds,
    radar: typeof o.radar === "boolean" ? o.radar : d.radar,
    city3d: typeof o.city3d === "boolean" ? o.city3d : d.city3d,
    aircraft: typeof o.aircraft === "boolean" ? o.aircraft : d.aircraft,
    traffic: typeof o.traffic === "boolean" ? o.traffic : d.traffic,
    buses: typeof o.buses === "boolean" ? o.buses : d.buses,
    ships: typeof o.ships === "boolean" ? o.ships : d.ships,
    webcams: typeof o.webcams === "boolean" ? o.webcams : d.webcams,
  };
}
