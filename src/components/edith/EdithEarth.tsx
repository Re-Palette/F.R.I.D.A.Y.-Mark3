"use client";

/**
 * GOD'S EYE VIEW の 3D 地球儀（CesiumJS）。EARTH のときに .eview__slot の中に描く。
 *   - 地球の画像の土台は Cesium に同梱の Natural Earth II（パブリックドメイン。/cesium/ から配る）。
 *     その上に、ON のときだけ、API キー不要の外部の画像を重ねる（lib/earth/imagery.ts）：
 *     詳細な衛星写真（Sentinel-2 cloudless）・今日の地球（NASA GIBS）・雨雲レーダー（RainViewer）。
 *     Cesium ion・立体の地形は使わない（地形は楕円体）。重ねた画像のクレジットは地球儀の上にリンク付きで出す
 *   - 写真のような 3D の街：Google Photorealistic 3D Tiles（キーが設定されているときだけ）。ON の間は地球の画像を隠し
 *     （Google の地図と他社の地図を混ぜない）、Google のロゴ・クレジットを画面に出す。1 回読み込んだら作り直さない（料金の節約）
 *   - 飛行機：OpenSky の報告位置から、速度と向きで 1 秒ごとに推定して動かす（報告の時刻は詳細に出す）
 *   - ドラッグで回す・ホイール／ピンチで寄る・引く・右ドラッグ／2 本指で傾ける。クリックで地震・衛星を選ぶ
 *   - 地震：USGS の発表の位置に、規模ごとの大きさ・色の点。衛星：軌道要素から satellite.js で 1 秒ごとに計算した推定位置
 *   - 選んだものへの追従（カメラが付いていく）と解除。地点へ移動
 *   - 地球儀は 1 つだけ作る（何度描き直しても作り直さない）。隠れている間は描画を止める。
 *     画面を離れる（このコンポーネントを外す）と、地球儀・イベント・タイマーをすべて片付ける
 *   - WebGL が使えない・描画に失敗したときは、地球儀の代わりに理由を出す（画面のほかの部分は壊さない）
 */
import { memo, useEffect, useMemo, useRef, useState } from "react";
import type * as CesiumNS from "cesium";
import { loadCesium, webglAvailable, type CesiumModule } from "@/lib/earth/cesium-loader";
import { magBand, type QuakePoint } from "@/lib/earth/quakes";
import { makeSatrec, satPosition, SAT_TICK_MS, type OrbitElement } from "@/lib/earth/satellites";
import { GIBS_CREDIT, GIBS_MAX_LEVEL, gibsUrl, RADAR_CREDIT, RADAR_MAX_LEVEL, S2_CREDIT, S2_MAX_LEVEL, S2_URL, type ImageryCredit } from "@/lib/earth/imagery";
import { aircraftPositionAt, type Aircraft, type BBox } from "@/lib/earth/aircraft";
import { TRAFFIC_MAX_LEVEL, TRAFFIC_MIN_LEVEL, type Bus, type Ship } from "@/lib/earth/transport";

export type EarthViewStatus = "loading" | "ready" | "unsupported" | "error";

export interface EarthFlyTo {
  lat: number;
  lon: number;
  /** カメラの高さ（m） */
  height?: number;
  /** 変わるたびに移動する */
  key: number;
  /** 斜めから見下ろす（度。例 -35）。指定すると、その地点を中心に斜めから見る */
  pitch?: number;
}

interface Props {
  /** EARTH を表示しているか（隠れている間は描画を止める） */
  active: boolean;
  quakes: QuakePoint[];
  showQuakes: boolean;
  sats: OrbitElement[];
  showSats: boolean;
  satLimit: number;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  /** 追従している対象（null で解除） */
  trackedId: string | null;
  onTrackLost?: () => void;
  autoRotate: boolean;
  flyTo: EarthFlyTo | null;
  /** 変わるたびに初期の視点へ */
  resetKey: number;
  onStatus?: (s: EarthViewStatus, message?: string) => void;
  /** 重ねる画像（無ければ同梱の画像だけ） */
  imagery?: EarthImagery;
  /** 重ねた画像の一部を読み込めなかった（種類ごと） */
  onImageryError?: (kind: ImageryKind) => void;
  /** 写真のような 3D の街（Google のキー。null なら出さない） */
  city3dKey?: string | null;
  /** 3D の街の状態 */
  onCity3d?: (s: "off" | "loading" | "ready" | "error", message?: string) => void;
  /** 飛行機 */
  aircraft?: Aircraft[];
  showAircraft?: boolean;
  /** 都営バス */
  buses?: Bus[];
  /** 船 */
  ships?: Ship[];
  /** 見ている範囲（動かし終わるたび。宇宙を見ているなど範囲が無ければ null） */
  onView?: (bbox: BBox | null, heightM: number) => void;
}

export type ImageryKind = "detail" | "clouds" | "radar" | "traffic";
export interface EarthImagery {
  detail: boolean;
  clouds: boolean;
  /** 今日の地球に使う日（UTC。YYYY-MM-DD） */
  cloudsDate: string;
  /** 雨雲レーダーのタイルの URL の型（無ければ出さない） */
  radarUrl: string | null;
  /** 道路の渋滞のタイルの URL の型（このサイトを通す。無ければ出さない） */
  trafficUrl?: string | null;
  /** 渋滞の画像を取りに行く範囲（見ている範囲。この外の画像は取りに行かない） */
  trafficRect?: BBox | null;
}

const TRAFFIC_CREDIT: ImageryCredit = { text: "Traffic data © TomTom", links: [{ label: "tomtom.com", href: "https://www.tomtom.com" }] };

/** 初期の視点：宇宙から地球を見下ろす（日本の上空） */
const HOME = { lon: 139.7, lat: 25, height: 11_000_000 };
/** 追従するときのカメラの位置（対象から見て南・上方。近づきすぎないように） */
const TRACK_VIEW = { south: 2_500_000, up: 2_500_000 };
const SAT_COLOR = "#5cf2ff";
const SAT_SELECTED = "#ffffff";
const ROTATE_RAD_PER_SEC = 0.035;
/** 操作した後、自動回転を止めておく時間 */
const IDLE_BEFORE_ROTATE_MS = 8000;
/** 自動回転の描き直しの最短間隔（ms。少し短めにして 60Hz の画面で 30 回／秒になるように） */
const ROTATE_FRAME_MS = 30;
/** 寄れる近さ：同梱の画像だけなら遠め（それでも、バス・船・渋滞が見える近さまでは寄れる）、詳細な衛星写真があれば近くまで */
const MIN_ZOOM_BASIC = 20_000;
const MIN_ZOOM_DETAIL = 2_000;
/** 重ねる画像の透明度 */
const CLOUDS_ALPHA = 0.88;
const RADAR_ALPHA = 0.72;
/** 3D の街のときに寄れる近さ */
const MIN_ZOOM_CITY = 60;
/** この距離より近いときは、点を建物に隠さない（遠いときは地球の裏の点を隠すため深度を見る） */
const NEAR_NO_DEPTH = 200_000;
const AIR_COLOR = "#ffd27a";
const BUS_COLOR = "#7dffa8";
const SHIP_COLOR = "#6fd6ff";
/** 船の形（上が北。向きに合わせて回す） */
const SHIP_SVG = `data:image/svg+xml;utf8,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><path d="M12 2 L18 20 L12 16.5 L6 20 Z" fill="#6fd6ff" stroke="#00121a" stroke-width="1.2"/></svg>')}`;
/** 飛行機の形（上が北。向きに合わせて回す） */
const PLANE_SVG = `data:image/svg+xml;utf8,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><path d="M16 2 L18.2 12 L29 17 L29 19.6 L18.2 17 L17.6 25 L21 27.6 L21 29.4 L16 28 L11 29.4 L11 27.6 L14.4 25 L13.8 17 L3 19.6 L3 17 L13.8 12 Z" fill="#ffd27a" stroke="#1a0d00" stroke-width="1.1"/></svg>')}`;

function EdithEarthImpl(p: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const creditRef = useRef<HTMLDivElement>(null);
  const cesiumRef = useRef<CesiumModule | null>(null);
  const viewerRef = useRef<CesiumNS.Viewer | null>(null);
  const quakeEntities = useRef(new Map<string, CesiumNS.Entity>());
  const satEntities = useRef(new Map<string, CesiumNS.Entity>());
  const orbitEntity = useRef<CesiumNS.Entity | null>(null);
  const lastInteract = useRef(0);
  /** 重ねた画像の層（種類ごと。URL が変わったら作り直す） */
  const overlays = useRef(new Map<ImageryKind, { url: string; layer: CesiumNS.ImageryLayer; off: () => void }>());
  const airEntities = useRef(new Map<string, CesiumNS.Entity>());
  const busEntities = useRef(new Map<string, CesiumNS.Entity>());
  const shipEntities = useRef(new Map<string, CesiumNS.Entity>());
  const cityTileset = useRef<{ key: string; tileset: CesiumNS.Cesium3DTileset | null; loading: boolean } | null>(null);
  const [cityOn, setCityOn] = useState(false);
  const propsRef = useRef(p);
  propsRef.current = p;
  const [status, setStatus] = useState<EarthViewStatus>("loading");
  const [message, setMessage] = useState<string>("");
  const [ready, setReady] = useState(false);

  const report = (s: EarthViewStatus, m = "") => {
    setStatus(s);
    setMessage(m);
    propsRef.current.onStatus?.(s, m);
  };

  /* ---------- 地球儀を 1 つだけ作る・外すときに片付ける ---------- */
  useEffect(() => {
    let disposed = false;
    const host = hostRef.current;
    if (!host) return;
    if (!webglAvailable()) {
      report("unsupported", "このブラウザ・端末では WebGL が使えないため、3D 地球儀を表示できません。");
      return;
    }
    report("loading");
    let handler: CesiumNS.ScreenSpaceEventHandler | null = null;
    const offs: (() => void)[] = [];
    void loadCesium()
      .then((C) => {
        if (disposed || viewerRef.current) return;
        cesiumRef.current = C;
        let viewer: CesiumNS.Viewer;
        try {
          viewer = new C.Viewer(host, {
            // 地球の画像：Cesium に同梱の Natural Earth II（パブリックドメイン）。外部の地図サービス・Cesium ion は使わない
            baseLayer: C.ImageryLayer.fromProviderAsync(C.TileMapServiceImageryProvider.fromUrl(C.buildModuleUrl("Assets/Textures/NaturalEarthII"))),
            terrainProvider: new C.EllipsoidTerrainProvider(),
            baseLayerPicker: false,
            geocoder: false,
            homeButton: false,
            sceneModePicker: false,
            navigationHelpButton: false,
            animation: false,
            timeline: false,
            fullscreenButton: false,
            infoBox: false,
            selectionIndicator: false,
            vrButton: false,
            skyBox: false,
            showRenderLoopErrors: false,
            requestRenderMode: true,
            maximumRenderTimeChange: Infinity,
            creditContainer: creditRef.current ?? undefined,
            contextOptions: { webgl: { alpha: true } },
          });
        } catch {
          report("error", "3D 地球儀を作れませんでした（WebGL の初期化に失敗）。");
          return;
        }
        if (disposed) {
          viewer.destroy();
          return;
        }
        viewerRef.current = viewer;
        const scene = viewer.scene;
        scene.backgroundColor = C.Color.TRANSPARENT;
        if (scene.sun) scene.sun.show = false;
        if (scene.moon) scene.moon.show = false;
        scene.globe.baseColor = C.Color.fromCssColorString("#120a2c");
        scene.globe.showGroundAtmosphere = true;
        // 同梱の画像は解像度が低いので、寄りすぎないようにする（詳細な衛星写真を重ねたら近くまで寄れる）
        scene.screenSpaceCameraController.minimumZoomDistance = MIN_ZOOM_BASIC;
        scene.screenSpaceCameraController.maximumZoomDistance = 60_000_000;
        const base = viewer.imageryLayers.get(0);
        if (base) {
          base.brightness = 0.92;
          base.saturation = 0.9;
        }
        viewer.camera.setView({ destination: C.Cartesian3.fromDegrees(HOME.lon, HOME.lat, HOME.height) });
        // 描画に失敗した：地球儀の代わりに理由を出す（画面のほかの部分はそのまま）
        offs.push(scene.renderError.addEventListener(() => report("error", "3D 地球儀の描画に失敗しました。")));
        // クリックで選ぶ（何も無いところは選ばない）・操作したら自動回転を少し止める
        handler = new C.ScreenSpaceEventHandler(scene.canvas);
        handler.setInputAction((e: { position: CesiumNS.Cartesian2 }) => {
          lastInteract.current = performance.now();
          const picked = scene.pick(e.position) as { id?: CesiumNS.Entity } | undefined;
          const id = picked?.id instanceof C.Entity ? picked.id.id : null;
          if (id && /^(quake|sat|air|bus|ship):/.test(id)) propsRef.current.onSelect(id);
        }, C.ScreenSpaceEventType.LEFT_CLICK);
        for (const t of [C.ScreenSpaceEventType.LEFT_DOWN, C.ScreenSpaceEventType.WHEEL, C.ScreenSpaceEventType.PINCH_START, C.ScreenSpaceEventType.RIGHT_DOWN]) {
          handler.setInputAction(() => (lastInteract.current = performance.now()), t);
        }
        // 見ている範囲を知らせる（動かし終わるたび。飛行機などを、見ている所だけ取りに行くため）
        const reportView = () => {
          const rect = viewer.camera.computeViewRectangle(scene.globe.ellipsoid);
          const h = viewer.camera.positionCartographic.height;
          if (!rect) return propsRef.current.onView?.(null, h);
          const d = C.Math.toDegrees;
          let lomin = d(rect.west);
          let lomax = d(rect.east);
          if (lomax < lomin) [lomin, lomax] = [-180, 180]; // 日付変更線をまたぐときは広く扱う（狭くないので取りに行かない）
          propsRef.current.onView?.({ lamin: Math.max(-90, d(rect.south)), lomin, lamax: Math.min(90, d(rect.north)), lomax }, h);
        };
        offs.push(viewer.camera.moveEnd.addEventListener(reportView));
        reportView();
        setReady(true);
        report("ready");
        scene.requestRender();
      })
      .catch((err: unknown) => {
        if (!disposed) report("error", err instanceof Error ? err.message : "3D 地球儀を読み込めませんでした。");
      });
    return () => {
      disposed = true;
      offs.splice(0).forEach((f) => f());
      handler?.destroy();
      const v = viewerRef.current;
      viewerRef.current = null;
      quakeEntities.current.clear();
      satEntities.current.clear();
      overlays.current.forEach((o) => o.off());
      overlays.current.clear();
      airEntities.current.clear();
      busEntities.current.clear();
      shipEntities.current.clear();
      cityTileset.current = null;
      orbitEntity.current = null;
      if (v && !v.isDestroyed()) v.destroy();
      setReady(false);
    };
    // 地球儀は 1 度だけ作る（props の変化では作り直さない）
  }, []);

  /* ---------- 隠れている間は描画を止める ---------- */
  useEffect(() => {
    const v = viewerRef.current;
    if (!v || !ready) return;
    v.useDefaultRenderLoop = p.active;
    if (p.active) {
      v.resize();
      v.scene.requestRender();
    }
  }, [p.active, ready]);

  /* ---------- 重ねる画像（詳細な衛星写真・今日の地球・雨雲レーダー） ---------- */
  const img = p.imagery;
  useEffect(() => {
    const v = viewerRef.current;
    const C = cesiumRef.current;
    if (!v || !C || !ready) return;
    const tr = img?.trafficRect;
    const want: { kind: ImageryKind; url: string | null; max: number; min?: number; rect?: BBox | null; credit: ImageryCredit; alpha: number }[] = [
      { kind: "detail", url: img?.detail ? S2_URL : null, max: S2_MAX_LEVEL, credit: S2_CREDIT, alpha: 1 },
      { kind: "clouds", url: img?.clouds && img.cloudsDate ? gibsUrl(img.cloudsDate) : null, max: GIBS_MAX_LEVEL, credit: GIBS_CREDIT, alpha: CLOUDS_ALPHA },
      // 渋滞：寄ったときの段階だけ取りに行く（引いた画面では取りに行かない）
      { kind: "traffic", url: img?.trafficUrl && tr ? img.trafficUrl : null, max: TRAFFIC_MAX_LEVEL, min: TRAFFIC_MIN_LEVEL, rect: tr, credit: TRAFFIC_CREDIT, alpha: 0.95 },
      { kind: "radar", url: img?.radarUrl ?? null, max: RADAR_MAX_LEVEL, credit: RADAR_CREDIT, alpha: RADAR_ALPHA },
    ];
    const map = overlays.current;
    for (const w of want) {
      const cur = map.get(w.kind);
      // 同じ URL・同じ範囲なら作り直さない（範囲が変わったら、その範囲だけの層に作り直す）
      const sig = w.url ? `${w.url}|${w.rect ? `${w.rect.lamin},${w.rect.lomin},${w.rect.lamax},${w.rect.lomax}` : ""}` : null;
      if (cur && cur.url === sig) continue;
      if (cur) {
        cur.off();
        v.imageryLayers.remove(cur.layer, true);
        map.delete(w.kind);
      }
      if (!w.url) continue;
      const provider = new C.UrlTemplateImageryProvider({
        url: w.url,
        maximumLevel: w.max,
        minimumLevel: w.min ?? 0,
        tilingScheme: new C.WebMercatorTilingScheme(),
        credit: new C.Credit(w.credit.text),
        ...(w.rect ? { rectangle: C.Rectangle.fromDegrees(w.rect.lomin, w.rect.lamin, w.rect.lomax, w.rect.lamax) } : {}),
      });
      const kind = w.kind;
      let reported = false;
      const off = provider.errorEvent.addEventListener(() => {
        if (reported) return;
        reported = true;
        propsRef.current.onImageryError?.(kind);
      });
      const layer = v.imageryLayers.addImageryProvider(provider);
      layer.alpha = w.alpha;
      map.set(w.kind, { url: sig!, layer, off });
    }
    // 重ねる順番：土台 → 詳細な衛星写真 → 今日の地球 → 雨雲レーダー
    for (const k of ["detail", "clouds", "traffic", "radar"] as const) {
      const o = map.get(k);
      if (o) v.imageryLayers.raiseToTop(o.layer);
    }
    v.scene.screenSpaceCameraController.minimumZoomDistance = cityOn ? MIN_ZOOM_CITY : img?.detail ? MIN_ZOOM_DETAIL : MIN_ZOOM_BASIC;
    v.scene.requestRender();
  }, [img?.detail, img?.clouds, img?.cloudsDate, img?.radarUrl, img?.trafficUrl, img?.trafficRect?.lamin, img?.trafficRect?.lomin, img?.trafficRect?.lamax, img?.trafficRect?.lomax, ready, cityOn]);

  /* ---------- 都営バス・船（報告の位置のまま。動かさない） ---------- */
  useEffect(() => {
    const v = viewerRef.current;
    const C = cesiumRef.current;
    if (!v || !C || !ready) return;
    const sync = <T,>(map: Map<string, CesiumNS.Entity>, list: T[], idOf: (x: T) => string, make: (x: T) => CesiumNS.Entity.ConstructorOptions, pos: (x: T) => CesiumNS.Cartesian3, rot?: (x: T) => number | null) => {
      const want = new Set(list.map(idOf));
      for (const [id, e] of map) {
        if (!want.has(id)) {
          v.entities.remove(e);
          map.delete(id);
        }
      }
      for (const x of list) {
        const id = idOf(x);
        const e = map.get(id);
        if (!e) map.set(id, v.entities.add({ id, ...make(x) }));
        else {
          e.position = new C.ConstantPositionProperty(pos(x));
          const r = rot?.(x);
          if (e.billboard && r !== null && r !== undefined) e.billboard.rotation = new C.ConstantProperty(-C.Math.toRadians(r));
        }
      }
    };
    sync(
      busEntities.current,
      p.buses ?? [],
      (b) => `bus:${b.id}`,
      (b) => ({
        name: b.route ?? "都営バス",
        position: new C.ConstantPositionProperty(C.Cartesian3.fromDegrees(b.lon, b.lat, 3)),
        point: { pixelSize: 7, color: C.Color.fromCssColorString(BUS_COLOR), outlineColor: C.Color.BLACK.withAlpha(0.6), outlineWidth: 1, disableDepthTestDistance: NEAR_NO_DEPTH },
        label: { text: b.route ?? "BUS", font: "10px monospace", fillColor: C.Color.fromCssColorString(BUS_COLOR), showBackground: true, backgroundColor: C.Color.fromCssColorString("#120a2c").withAlpha(0.75), pixelOffset: new C.Cartesian2(0, -14), distanceDisplayCondition: new C.DistanceDisplayCondition(0, 25_000), disableDepthTestDistance: NEAR_NO_DEPTH },
      }),
      (b) => C.Cartesian3.fromDegrees(b.lon, b.lat, 3),
    );
    sync(
      shipEntities.current,
      p.ships ?? [],
      (x) => `ship:${x.mmsi}`,
      (x) => ({
        name: x.name ?? x.mmsi,
        position: new C.ConstantPositionProperty(C.Cartesian3.fromDegrees(x.lon, x.lat, 0)),
        billboard: { image: SHIP_SVG, width: 16, height: 16, rotation: -C.Math.toRadians(x.heading ?? 0), alignedAxis: C.Cartesian3.UNIT_Z, disableDepthTestDistance: NEAR_NO_DEPTH },
        label: { text: x.name ?? x.mmsi, font: "10px monospace", fillColor: C.Color.fromCssColorString(SHIP_COLOR), showBackground: true, backgroundColor: C.Color.fromCssColorString("#120a2c").withAlpha(0.75), pixelOffset: new C.Cartesian2(0, -14), distanceDisplayCondition: new C.DistanceDisplayCondition(0, 120_000), disableDepthTestDistance: NEAR_NO_DEPTH },
      }),
      (x) => C.Cartesian3.fromDegrees(x.lon, x.lat, 0),
      (x) => x.heading,
    );
    v.scene.requestRender();
  }, [p.buses, p.ships, ready]);

  /* ---------- 写真のような 3D の街（Google Photorealistic 3D Tiles） ---------- */
  useEffect(() => {
    const v = viewerRef.current;
    const C = cesiumRef.current;
    if (!v || !C || !ready) return;
    const key = p.city3dKey ?? null;
    const cur = cityTileset.current;
    const show = (on: boolean) => {
      if (cityTileset.current?.tileset) cityTileset.current.tileset.show = on;
      // Google の 3D の街を出している間は、ほかの地図（地球の画像）を隠す（Google の地図と他社の地図を混ぜない）
      v.scene.globe.show = !on;
      setCityOn(on);
      v.scene.requestRender();
    };
    if (!key) {
      show(false);
      propsRef.current.onCity3d?.("off");
      return;
    }
    if (cur && cur.key === key) {
      if (cur.tileset) {
        show(true);
        propsRef.current.onCity3d?.("ready");
      }
      return;
    }
    // 1 回だけ読み込む（読み込むたびに Google の利用が数えられるため、OFF にしても作り直さず隠すだけ）
    cityTileset.current = { key, tileset: null, loading: true };
    propsRef.current.onCity3d?.("loading");
    let cancelled = false;
    C.createGooglePhotorealistic3DTileset({ key, onlyUsingWithGoogleGeocoder: true }, { showCreditsOnScreen: true })
      .then((ts) => {
        if (cancelled || v.isDestroyed() || cityTileset.current?.key !== key) return void ts.destroy();
        v.scene.primitives.add(ts);
        cityTileset.current = { key, tileset: ts, loading: false };
        show(propsRef.current.city3dKey === key);
        propsRef.current.onCity3d?.("ready");
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        cityTileset.current = null;
        show(false);
        propsRef.current.onCity3d?.("error", err instanceof Error ? err.message.slice(0, 160) : "3D の街を読み込めませんでした");
      });
    return () => {
      cancelled = true;
    };
  }, [p.city3dKey, ready]);

  /* ---------- 飛行機（報告位置から 1 秒ごとに推定して動かす） ---------- */
  useEffect(() => {
    const v = viewerRef.current;
    const C = cesiumRef.current;
    if (!v || !C || !ready) return;
    const map = airEntities.current;
    const list = p.showAircraft ? (p.aircraft ?? []) : [];
    const want = new Set(list.map((a) => `air:${a.icao24}`));
    for (const [id, e] of map) {
      if (!want.has(id)) {
        v.entities.remove(e);
        map.delete(id);
      }
    }
    if (!list.length) {
      v.scene.requestRender();
      return;
    }
    const update = () => {
      const at = Date.now();
      for (const a of list) {
        const id = `air:${a.icao24}`;
        const pos = aircraftPositionAt(a, at);
        const cart = C.Cartesian3.fromDegrees(pos.lon, pos.lat, Math.max(0, a.altM ?? 0));
        const selected = id === propsRef.current.selectedId;
        let e = map.get(id);
        if (!e) {
          e = v.entities.add({
            id,
            name: a.callsign ?? a.icao24,
            position: new C.ConstantPositionProperty(cart),
            viewFrom: new C.Cartesian3(0, -40_000, 30_000),
            billboard: {
              image: PLANE_SVG,
              width: 22,
              height: 22,
              rotation: -C.Math.toRadians(a.heading ?? 0),
              alignedAxis: C.Cartesian3.UNIT_Z,
              disableDepthTestDistance: NEAR_NO_DEPTH,
            },
            label: {
              text: a.callsign ?? a.icao24.toUpperCase(),
              font: "11px monospace",
              fillColor: C.Color.fromCssColorString(AIR_COLOR),
              showBackground: true,
              backgroundColor: C.Color.fromCssColorString("#120a2c").withAlpha(0.75),
              pixelOffset: new C.Cartesian2(0, -18),
              distanceDisplayCondition: new C.DistanceDisplayCondition(0, 400_000),
              disableDepthTestDistance: NEAR_NO_DEPTH,
            },
          });
          map.set(id, e);
        } else {
          (e.position as CesiumNS.ConstantPositionProperty).setValue(cart);
        }
        if (e.billboard) {
          e.billboard.rotation = new C.ConstantProperty(-C.Math.toRadians(a.heading ?? 0));
          e.billboard.scale = new C.ConstantProperty(selected ? 1.5 : 1);
        }
      }
      if (propsRef.current.active) v.scene.requestRender();
    };
    update();
    const timer = window.setInterval(update, 1000);
    return () => window.clearInterval(timer);
  }, [p.aircraft, p.showAircraft, ready]);

  /* ---------- 地震の点 ---------- */
  useEffect(() => {
    const v = viewerRef.current;
    const C = cesiumRef.current;
    if (!v || !C || !ready) return;
    const map = quakeEntities.current;
    const want = new Map<string, QuakePoint>(p.showQuakes ? p.quakes.map((q) => [`quake:${q.id}`, q]) : []);
    for (const [id, e] of map) {
      if (!want.has(id)) {
        v.entities.remove(e);
        map.delete(id);
      }
    }
    for (const [id, q] of want) {
      const band = magBand(q.mag);
      const selected = id === p.selectedId;
      const color = C.Color.fromCssColorString(band.color).withAlpha(0.88);
      const point = {
        disableDepthTestDistance: NEAR_NO_DEPTH,
        pixelSize: band.size + (selected ? 6 : 0),
        color,
        outlineColor: C.Color.WHITE.withAlpha(selected ? 1 : 0.55),
        outlineWidth: selected ? 3 : 1,
      };
      const e = map.get(id);
      if (e) {
        e.position = new C.ConstantPositionProperty(C.Cartesian3.fromDegrees(q.lon, q.lat, 0));
        e.point = new C.PointGraphics(point);
      } else {
        map.set(id, v.entities.add({ id, name: q.place, position: C.Cartesian3.fromDegrees(q.lon, q.lat, 0), point, viewFrom: new C.Cartesian3(0, -TRACK_VIEW.south, TRACK_VIEW.up) }));
      }
    }
    v.scene.requestRender();
  }, [p.quakes, p.showQuakes, p.selectedId, ready]);

  /* ---------- 衛星：軌道データの準備（取得のたびに 1 回）と、1 秒ごとの推定位置 ---------- */
  const satrecs = useMemo(() => {
    const out: { el: OrbitElement; rec: NonNullable<ReturnType<typeof makeSatrec>> }[] = [];
    for (const el of p.sats) {
      if (out.length >= p.satLimit) break;
      const rec = makeSatrec(el);
      if (rec) out.push({ el, rec });
    }
    return out;
  }, [p.sats, p.satLimit]);

  useEffect(() => {
    const v = viewerRef.current;
    const C = cesiumRef.current;
    if (!v || !C || !ready) return;
    const map = satEntities.current;
    const want = new Set(p.showSats ? satrecs.map((s) => `sat:${s.el.id}`) : []);
    for (const [id, e] of map) {
      if (!want.has(id)) {
        v.entities.remove(e);
        map.delete(id);
      }
    }
    if (!p.showSats || !satrecs.length) {
      v.scene.requestRender();
      return;
    }
    const update = () => {
      const at = Date.now();
      for (const { el, rec } of satrecs) {
        const id = `sat:${el.id}`;
        const pos = satPosition(rec, at);
        let e = map.get(id);
        if (!pos) {
          // 計算できない：描かない（作った位置は出さない）
          if (e) {
            v.entities.remove(e);
            map.delete(id);
          }
          continue;
        }
        const cart = C.Cartesian3.fromDegrees(pos.lon, pos.lat, pos.heightKm * 1000);
        const selected = id === propsRef.current.selectedId;
        if (!e) {
          e = v.entities.add({
            id,
            name: el.name,
            position: new C.ConstantPositionProperty(cart),
            viewFrom: new C.Cartesian3(0, -TRACK_VIEW.south, TRACK_VIEW.up),
            point: { pixelSize: 7, color: C.Color.fromCssColorString(SAT_COLOR), outlineColor: C.Color.BLACK.withAlpha(0.6), outlineWidth: 1 },
          });
          map.set(id, e);
        } else {
          (e.position as CesiumNS.ConstantPositionProperty).setValue(cart);
        }
        if (e.point) {
          e.point.pixelSize = new C.ConstantProperty(selected ? 12 : 7);
          e.point.color = new C.ConstantProperty(C.Color.fromCssColorString(selected ? SAT_SELECTED : SAT_COLOR));
        }
        e.label = selected
          ? new C.LabelGraphics({ text: el.name, font: "12px sans-serif", fillColor: C.Color.WHITE, pixelOffset: new C.Cartesian2(0, -18), showBackground: true, backgroundColor: C.Color.fromCssColorString("#120a2c").withAlpha(0.8) })
          : undefined;
      }
      if (propsRef.current.active) v.scene.requestRender();
    };
    update();
    const timer = window.setInterval(update, SAT_TICK_MS);
    return () => window.clearInterval(timer);
  }, [satrecs, p.showSats, ready]);

  /* ---------- 選んだ衛星の、これから約 1 周分の推定の軌跡 ---------- */
  useEffect(() => {
    const v = viewerRef.current;
    const C = cesiumRef.current;
    if (!v || !C || !ready) return;
    if (orbitEntity.current) {
      v.entities.remove(orbitEntity.current);
      orbitEntity.current = null;
    }
    const s = p.selectedId?.startsWith("sat:") ? satrecs.find((x) => `sat:${x.el.id}` === p.selectedId) : undefined;
    if (!s || !p.showSats) {
      v.scene.requestRender();
      return;
    }
    const draw = () => {
      if (orbitEntity.current) v.entities.remove(orbitEntity.current);
      const now = Date.now();
      const periodMin = Math.min(200, 1440 / Math.max(1, Number(s.el.omm.MEAN_MOTION)));
      const pts: CesiumNS.Cartesian3[] = [];
      for (let m = 0; m <= periodMin; m += 1) {
        const pos = satPosition(s.rec, now + m * 60_000);
        if (pos) pts.push(C.Cartesian3.fromDegrees(pos.lon, pos.lat, pos.heightKm * 1000));
      }
      orbitEntity.current = pts.length > 1 ? v.entities.add({ id: "orbit-path", polyline: { positions: pts, width: 1.5, material: C.Color.fromCssColorString(SAT_COLOR).withAlpha(0.55) } }) : null;
      v.scene.requestRender();
    };
    draw();
    const timer = window.setInterval(draw, 60_000);
    return () => window.clearInterval(timer);
  }, [p.selectedId, satrecs, p.showSats, ready]);

  /* ---------- 追従と解除 ---------- */
  useEffect(() => {
    const v = viewerRef.current;
    if (!v || !ready) return;
    const target = p.trackedId ? (quakeEntities.current.get(p.trackedId) ?? satEntities.current.get(p.trackedId) ?? airEntities.current.get(p.trackedId) ?? busEntities.current.get(p.trackedId) ?? shipEntities.current.get(p.trackedId)) : undefined;
    if (p.trackedId && !target) {
      // 追従の対象が描かれていない（レイヤーを OFF にした・データから消えた）：解除する
      v.trackedEntity = undefined;
      propsRef.current.onTrackLost?.();
      return;
    }
    v.trackedEntity = target;
    v.scene.requestRender();
  }, [p.trackedId, ready, p.showQuakes, p.showSats, p.quakes, satrecs, p.aircraft, p.showAircraft, p.buses, p.ships]);

  /* ---------- 地点へ移動・初期の視点 ---------- */
  useEffect(() => {
    const v = viewerRef.current;
    const C = cesiumRef.current;
    if (!v || !C || !ready || !p.flyTo) return;
    v.trackedEntity = undefined;
    lastInteract.current = performance.now();
    if (p.flyTo.pitch !== undefined) {
      // 斜めから見下ろす：その地点を中心に、距離 height・角度 pitch で
      const target = C.Cartesian3.fromDegrees(p.flyTo.lon, p.flyTo.lat, 0);
      v.camera.flyToBoundingSphere(new C.BoundingSphere(target, 50), { offset: new C.HeadingPitchRange(0, C.Math.toRadians(p.flyTo.pitch), p.flyTo.height ?? 2_000), duration: 2 });
      return;
    }
    v.camera.flyTo({ destination: C.Cartesian3.fromDegrees(p.flyTo.lon, p.flyTo.lat, p.flyTo.height ?? 3_500_000), duration: 1.6 });
  }, [p.flyTo?.key, ready]);

  useEffect(() => {
    const v = viewerRef.current;
    const C = cesiumRef.current;
    if (!v || !C || !ready || p.resetKey === 0) return;
    v.trackedEntity = undefined;
    v.camera.flyTo({ destination: C.Cartesian3.fromDegrees(HOME.lon, HOME.lat, HOME.height), duration: 1.4 });
  }, [p.resetKey, ready]);

  /* ---------- 自動回転（表示中・操作していない・追従していない・視差効果を減らす設定でないときだけ） ---------- */
  useEffect(() => {
    const v = viewerRef.current;
    const C = cesiumRef.current;
    if (!v || !C || !ready || !p.active || !p.autoRotate || p.trackedId) return;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    let raf = 0;
    let last = performance.now();
    const step = (t: number) => {
      // ゆっくり回るだけなので、描き直しは 1 秒に 30 回まで（毎フレーム描くと、ほかの動きの分の力が足りなくなる）
      if (t - last < ROTATE_FRAME_MS) {
        raf = requestAnimationFrame(step);
        return;
      }
      const dt = Math.min(0.1, (t - last) / 1000);
      last = t;
      if (!document.hidden && t - lastInteract.current > IDLE_BEFORE_ROTATE_MS && !v.isDestroyed()) {
        v.camera.rotate(C.Cartesian3.UNIT_Z, -ROTATE_RAD_PER_SEC * dt);
        v.scene.requestRender();
      }
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [p.active, p.autoRotate, p.trackedId, ready]);

  const credits = [img?.detail && S2_CREDIT, img?.clouds && GIBS_CREDIT, img?.trafficUrl && TRAFFIC_CREDIT, img?.radarUrl && RADAR_CREDIT].filter((c): c is ImageryCredit => Boolean(c));
  return (
    <div className="eearth" data-status={status} data-city={cityOn || undefined} aria-label="3D 地球儀（ドラッグで回す・ホイールやピンチで拡大縮小）">
      <div ref={hostRef} className="eearth__canvas" />
      {/* 重ねた画像のクレジット（リンク付き。見える場所に出す） */}
      {status === "ready" && !cityOn && credits.length > 0 && (
        <p className="eearth__imgcredit">
          {credits.map((c) => (
            <span key={c.text}>
              {c.text}
              {c.links.map((l) => (
                <a key={l.href} href={l.href} target="_blank" rel="noopener noreferrer">
                  {l.label}
                </a>
              ))}
            </span>
          ))}
        </p>
      )}
      {/* 地図・3D の部品の帰属（Cesium の表示。見た目は小さく、EARTH パネルにも書く） */}
      {/* Cesium のクレジット（Google の 3D の街のときは、Google のロゴ・クレジットを画面に出す決まり） */}
      <div ref={creditRef} className="eearth__credits" aria-hidden={!cityOn} />
      {status !== "ready" && (
        <div className="efeed__state eearth__state" role={status === "loading" ? "status" : "alert"} data-tone={status === "loading" ? undefined : "error"}>
          {status === "loading" && <span className="efeed__scan" aria-hidden="true" />}
          <b>{status === "loading" ? "LOADING EARTH…" : status === "unsupported" ? "WEBGL UNAVAILABLE" : "EARTH ERROR"}</b>
          <small>{status === "loading" ? "3D 地球儀を準備しています" : message}</small>
        </div>
      )}
    </div>
  );
}

const sameImagery = (a?: EarthImagery, b?: EarthImagery) =>
  a === b ||
  (!!a &&
    !!b &&
    a.detail === b.detail &&
    a.clouds === b.clouds &&
    a.cloudsDate === b.cloudsDate &&
    a.radarUrl === b.radarUrl &&
    a.trafficUrl === b.trafficUrl &&
    a.trafficRect?.lamin === b.trafficRect?.lamin &&
    a.trafficRect?.lomin === b.trafficRect?.lomin &&
    a.trafficRect?.lamax === b.trafficRect?.lamax &&
    a.trafficRect?.lomax === b.trafficRect?.lomax);

/**
 * 表示に関わる値が変わったときだけ描き直す（返答が流れ込むたびに親が描き直されても、地球儀は描き直さない）。
 * 呼び出し（on〜）は中で最新のものを参照しないので（状態を変えるだけ）、比べない
 */
export const EdithEarth = memo(EdithEarthImpl, (a, b) => {
  for (const k of Object.keys({ ...a, ...b }) as (keyof Props)[]) {
    if (k === "imagery") {
      if (!sameImagery(a.imagery, b.imagery)) return false;
    } else if (typeof a[k] === "function" || typeof b[k] === "function") {
      if (typeof a[k] !== typeof b[k]) return false;
    } else if (!Object.is(a[k], b[k])) return false;
  }
  return true;
});
