"use client";

/**
 * GOD'S EYE VIEW（EARTH）のレイヤーのデータ（地震・衛星の軌道データ）を、/api/edith/earth から定期的に取る。
 *   - EARTH を表示していて、そのレイヤーが ON のときだけ取りに行く（OFF・隠れている・オフラインの間は取りに行かない）
 *   - 取得に失敗しても、前に取れたデータは残し、状態を STALE にする（作ったデータは出さない）
 *   - 地震と衛星は別々に取る（片方の失敗は、もう片方に影響しない）
 *   - 衛星だけ：
 *     ・失敗の応答に「最後に取れたデータ」が付いていて、画面にまだデータが無ければ、それを STALE として出す
 *       （取得時刻は、サーバーが実際に CelesTrak から取った時刻のまま。新しいデータとしては扱わない）
 *     ・サーバーが「しばらく取りに来ないで」と答えたら、その期限をこの端末にも覚えておき、その間はサーバーに尋ねない（補助）。
 *       期限が過ぎたら、ふだんどおりサーバーに尋ねるだけ（強制の取り直しはしない。取りに行くかはサーバーが決める）
 *     ・正常に取れた最後のデータ（1 グループ分・最大 150 機・約 300KB まで）をこの端末に保存し、画面を開き直したときに出す。
 *       読み出すときに形を確かめ直し、7 日より古いもの・壊れたものは使わない。取得時刻は元のまま
 *     ・失敗の応答や端末の保存から出したデータは、時計のずれに関係なく必ず STALE（LIVE にしない）。
 *       実際に取れた応答が届くまで STALE のまま
 *     ・保存から出すのは端末の中だけ。そのためにサーバーや CelesTrak へ問い合わせることはない
 */
import { useEffect, useRef, useState } from "react";
import { createPoller, fetchLayerJson, type PollResult } from "@/lib/earth/poller";
import { EMPTY_FETCH, layerStatus, type LayerFetchState, type LayerStatus } from "@/lib/earth/status";
import { parseQuakesResponse, QUAKE_POLL_MS, QUAKE_STALE_MS, type QuakesResponse } from "@/lib/earth/quakes";
import { parseRadarResponse, RADAR_POLL_MS, RADAR_STALE_MS, RAINVIEWER_MAPS_URL, type RadarResponse } from "@/lib/earth/imagery";
import { BUS_MAX_VIEW_AREA, BUS_POLL_MS, BUS_STALE_MS, bboxOverlaps, parseBusesResponse, parseShipsResponse, SHIP_MAX_AREA, SHIP_POLL_MS, SHIP_STALE_MS, TOEI_AREA, type BusesResponse, type ShipsResponse } from "@/lib/earth/transport";
import { parseWebcamsResponse, WEBCAM_POLL_MS, WEBCAM_STALE_MS, type WebcamsResponse } from "@/lib/earth/webcams";
import { AIRCRAFT_MAX_AREA, AIRCRAFT_POLL_MS, AIRCRAFT_STALE_MS, bboxArea, bboxKey, parseAircraftResponse, roundBBox, type AircraftResponse, type BBox } from "@/lib/earth/aircraft";
import {
  parseSatellitesResponse,
  SAT_LIMIT_MAX,
  parseSatHold,
  SAT_HOLD_KEY,
  SAT_POLL_MS,
  SAT_STALE_MS,
  satHoldActive,
  satHoldFromFail,
  type SatellitesFail,
  type SatellitesOk,
  type SatellitesResponse,
  type SatFailReason,
  type SatFailScope,
  type SatGroup,
  type SatHold,
} from "@/lib/earth/satellites";

type QuakesOk = Extract<QuakesResponse, { ok: true }>;
type RadarOk = Extract<RadarResponse, { ok: true }>;
type AircraftOk = Extract<AircraftResponse, { ok: true }>;
type BusesOk = Extract<BusesResponse, { ok: true }>;
type ShipsOk = Extract<ShipsResponse, { ok: true }>;
type WebcamsOk = Extract<WebcamsResponse, { ok: true }>;

/** 外部サービスの設定の有無（/api/edith/earth/config）。キーは Google の 3D の街のものだけ（ブラウザが直接使うため） */
export interface EarthConfig {
  google3dKey: string | null;
  services: { opensky: "auth" | "anonymous"; tomtom: boolean; odpt: boolean; ais: boolean; webcams: boolean };
}
export function parseEarthConfig(raw: unknown): EarthConfig | null {
  const r = raw as { google3dKey?: unknown; services?: Record<string, unknown> } | null;
  if (!r || typeof r !== "object" || !r.services || typeof r.services !== "object") return null;
  const s = r.services;
  return {
    google3dKey: typeof r.google3dKey === "string" && /^[A-Za-z0-9_-]{20,80}$/.test(r.google3dKey) ? r.google3dKey : null,
    services: { opensky: s.opensky === "auth" ? "auth" : "anonymous", tomtom: s.tomtom === true, odpt: s.odpt === true, ais: s.ais === true, webcams: s.webcams === true },
  };
}

/** EARTH を開いたときに 1 回だけ設定を読む（失敗したら null のまま。キーの要るものは使わない） */
function useEarthConfig(active: boolean): EarthConfig | null {
  const [cfg, setCfg] = useState<EarthConfig | null>(null);
  const tried = useRef(false);
  useEffect(() => {
    if (!active || tried.current) return;
    tried.current = true;
    const ctrl = new AbortController();
    fetch("/api/edith/earth/config", { cache: "no-store", credentials: "same-origin", signal: ctrl.signal })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => setCfg(parseEarthConfig(j)))
      .catch(() => {
        tried.current = false;
      });
    return () => ctrl.abort();
  }, [active]);
  return cfg;
}
type SatsOk = Extract<SatellitesResponse, { ok: true }>;

/** 取れていない理由（衛星だけ。地震では null） */
export interface LayerFailInfo {
  reason: SatFailReason | null;
  scope?: SatFailScope;
  retryAt?: string | null;
}

export interface LayerData<T> {
  data: T | null;
  fetch: LayerFetchState;
  status: LayerStatus;
  fail: LayerFailInfo | null;
}

/** 失敗の応答・端末の保存から出したデータの状態：LIVE・NO DATA にはしない（時計のずれに関係なく STALE） */
export function restoredStatus(s: LayerStatus): LayerStatus {
  return s === "LIVE" || s === "NO DATA" ? "STALE" : s;
}

/* ---------- 正常に取れた最後の衛星データの保存（端末の中だけ） ---------- */

export const SAT_LAST_KEY = "friday.edith-earth-sat-last.v1";
/** 保存する衛星の数の上限（画面で一度に描ける数と同じ） */
export const SAT_SAVED_MAX_ELEMENTS = SAT_LIMIT_MAX;
/** 保存する大きさの上限（文字数）。超えるものは保存しない */
export const SAT_SAVED_MAX_CHARS = 300_000;
/** これより古い保存は使わない（軌道要素が古いと推定位置の誤差が大きい） */
export const SAT_SAVED_MAX_AGE_MS = 7 * 24 * 60 * 60_000;

/** 保存する形にする（衛星の表示に必要な項目だけ。0 件・大きすぎるものは null） */
export function serializeSavedSats(d: SatellitesOk): string | null {
  if (!d.elements.length) return null;
  const elements = d.elements.slice(0, SAT_SAVED_MAX_ELEMENTS).map((e) => ({ id: e.id, name: e.name, intlId: e.intlId, epoch: e.epoch, omm: e.omm }));
  const text = JSON.stringify({ v: 1, data: { ok: true, source: "CelesTrak", group: d.group, fetchedAt: d.fetchedAt, elements } });
  return text.length <= SAT_SAVED_MAX_CHARS ? text : null;
}

/** 保存を読み、形を確かめ直す（壊れている・別のグループ・古すぎる・未来すぎる → null） */
export function parseSavedSats(raw: string | null, group: SatGroup, now: number): SatellitesOk | null {
  if (!raw || raw.length > SAT_SAVED_MAX_CHARS) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return null;
  }
  const o = obj as { v?: unknown; data?: unknown } | null;
  if (!o || typeof o !== "object" || o.v !== 1) return null;
  const d = parseSatellitesResponse(o.data);
  if (!d || !d.ok || d.group !== group || d.elements.length === 0) return null;
  const at = Date.parse(d.fetchedAt);
  if (!Number.isFinite(at) || Math.abs(now - at) > SAT_SAVED_MAX_AGE_MS) return null;
  return { ...d, elements: d.elements.slice(0, SAT_SAVED_MAX_ELEMENTS) };
}

type StoreLike = { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void };

/** 読み出し（使えない・壊れている → null。例外は外に出さない） */
export function readSavedSats(store: StoreLike | null, group: SatGroup, now: number): SatellitesOk | null {
  try {
    return store ? parseSavedSats(store.getItem(SAT_LAST_KEY), group, now) : null;
  } catch {
    return null;
  }
}

/** 正常に取れたデータを保存する（保存できなくても何もしない）。0 件なら、そのグループの古い保存を消す */
export function writeSavedSats(store: StoreLike | null, d: SatellitesOk): void {
  try {
    if (!store) return;
    const text = serializeSavedSats(d);
    if (text) store.setItem(SAT_LAST_KEY, text);
    else if (!d.elements.length) {
      const old = parseSavedSats(store.getItem(SAT_LAST_KEY), d.group, Date.parse(d.fetchedAt));
      if (old) store.removeItem(SAT_LAST_KEY);
    }
  } catch {
    /* 保存できなくても動く */
  }
}

const localStore = (): StoreLike | null => {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
};

/** レイヤーごとの追加の扱い（衛星で使う。地震では使わない） */
interface LayerExtras<D> {
  /** レイヤーを始めたときの状態（端末に停止の記録・保存したデータがあるとき）。data は必ず STALE で出す */
  initial?: () => { fetch: LayerFetchState; fail: LayerFailInfo | null; data?: D | null } | null;
  /** 失敗の応答から、最後に取れたデータ・その実際の取得時刻・理由を取り出す */
  fromFailure?: (payload: unknown) => { last: D | null; okAt: number | null; count: number; info: LayerFailInfo | null } | null;
  /** 結果ごとに呼ぶ（端末側の停止の記録） */
  onOutcome?: (r: PollResult<D>) => void;
}

function useOnlineVisible() {
  const [online, setOnline] = useState(true);
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    const upd = () => {
      setOnline(navigator.onLine !== false);
      setVisible(!document.hidden);
    };
    upd();
    window.addEventListener("online", upd);
    window.addEventListener("offline", upd);
    document.addEventListener("visibilitychange", upd);
    return () => {
      window.removeEventListener("online", upd);
      window.removeEventListener("offline", upd);
      document.removeEventListener("visibilitychange", upd);
    };
  }, []);
  return { online, visible };
}

function useLayer<T>(
  url: string | null,
  intervalMs: number,
  staleAfterMs: number,
  parse: Parameters<typeof fetchLayerJson<T>>[2],
  now: number,
  online: boolean,
  paused: () => boolean,
  extras?: LayerExtras<{ ok: true } & T>,
) {
  const [data, setData] = useState<({ ok: true } & T) | null>(null);
  const [fetch, setFetch] = useState<LayerFetchState>(EMPTY_FETCH);
  const [fail, setFail] = useState<LayerFailInfo | null>(null);
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  const extrasRef = useRef(extras);
  extrasRef.current = extras;
  const dataRef = useRef<({ ok: true } & T) | null>(null);
  /** いま出しているデータが、失敗の応答・端末の保存から出したもの（実際に取れた応答ではない）か */
  const [restored, setRestored] = useState(false);
  const restoredRef = useRef(false);
  const restoredOkAtRef = useRef<number | null>(null);
  const markRestored = (v: boolean, okAt: number | null = null) => {
    restoredRef.current = v;
    restoredOkAtRef.current = v ? okAt : null;
    setRestored(v);
  };

  useEffect(() => {
    // URL（グループ）が変わったら、前のデータは使わない
    const init = url ? (extrasRef.current?.initial?.() ?? null) : null;
    dataRef.current = init?.data ?? null;
    setData(init?.data ?? null);
    markRestored(Boolean(init?.data), init?.data ? (init.fetch.lastOkAt ?? null) : null);
    setFetch(init?.fetch ?? EMPTY_FETCH);
    setFail(init?.fail ?? null);
    if (!url) return;
    const poller = createPoller<{ ok: true } & T>({
      fetchOnce: (signal) => fetchLayerJson<T>(url, signal, parse),
      intervalMs,
      isPaused: () => pausedRef.current(),
      onLoading: (loading) => setFetch((f) => ({ ...f, loading })),
      onResult: (r: PollResult<{ ok: true } & T>) => {
        if (r.ok) {
          dataRef.current = r.data;
          setData(r.data);
          const d = r.data as unknown as { items?: unknown[]; elements?: unknown[] };
          const count = Array.isArray(d.items) ? d.items.length : Array.isArray(d.elements) ? d.elements.length : 0;
          setFetch((f) => ({ ...f, lastOkAt: r.at, lastCount: count }));
          setFail(null);
          markRestored(false);
        } else {
          const from = r.payload !== undefined ? (extrasRef.current?.fromFailure?.(r.payload) ?? null) : null;
          // 画面にまだデータが無い（または保存から出した、より古いデータしか無い）とき、最後に取れたデータを出す。
          // 取得時刻はその時のまま。必ず STALE（時計のずれで LIVE にしない）
          const replace = !dataRef.current || (restoredRef.current && (restoredOkAtRef.current ?? -Infinity) < (from?.okAt ?? -Infinity));
          if (from?.last && from.okAt !== null && replace) {
            dataRef.current = from.last;
            setData(from.last);
            markRestored(true, from.okAt);
            setFetch((f) => ({ ...f, lastOkAt: from.okAt, lastCount: from.count, lastError: r.error, lastErrorAt: r.at }));
          } else {
            setFetch((f) => ({ ...f, lastError: r.error, lastErrorAt: r.at }));
          }
          setFail(from?.info ?? null);
        }
        extrasRef.current?.onOutcome?.(r);
      },
    });
    poller.start();
    return () => poller.stop();
    // parse・間隔は固定（URL が変わったときだけ作り直す）
  }, [url]);

  const base = url ? layerStatus(fetch, { now, online, staleAfterMs }) : "LOADING";
  const status = url && restored ? restoredStatus(base) : base;
  return { data, fetch, status, fail } as LayerData<{ ok: true } & T>;
}

/** 1 秒ごとに進む時計（経過時間・状態の表示用） */
export function useTick(ms = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), ms);
    return () => window.clearInterval(t);
  }, [ms]);
  return now;
}

/* ---------- 端末側の停止の記録（localStorage。使えなければ記録しないだけ） ---------- */

function readSatHold(): SatHold | null {
  try {
    const raw = window.localStorage.getItem(SAT_HOLD_KEY);
    return raw ? parseSatHold(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}
function writeSatHold(h: SatHold | null): void {
  try {
    if (h) window.localStorage.setItem(SAT_HOLD_KEY, JSON.stringify(h));
    else window.localStorage.removeItem(SAT_HOLD_KEY);
  } catch {
    /* 保存できなくても動く（サーバー側の判断がある） */
  }
}

export function useEarthData(o: {
  active: boolean;
  quakes: boolean;
  sats: boolean;
  satGroup: SatGroup;
  radar?: boolean;
  aircraft?: boolean;
  buses?: boolean;
  ships?: boolean;
  viewBox?: BBox | null;
  /** ライブカメラを探す場所（null なら探さない） */
  webcams?: { lat: number; lon: number; radiusKm: number; traffic: boolean } | null;
}) {
  const now = useTick();
  const { online, visible } = useOnlineVisible();
  const paused = () => !visible || !online;
  const quakes = useLayer<Omit<QuakesOk, "ok">>(o.active && o.quakes ? "/api/edith/earth/quakes" : null, QUAKE_POLL_MS, QUAKE_STALE_MS, parseQuakesResponse as never, now, online, paused);

  // 衛星：端末側の停止の記録（ref に持ち、変わったら保存する）
  const holdRef = useRef<SatHold | null | undefined>(undefined);
  const hold = () => {
    if (holdRef.current === undefined) holdRef.current = typeof window === "undefined" ? null : readSatHold();
    return holdRef.current;
  };
  const group = o.satGroup;
  const satPaused = () => paused() || satHoldActive(hold(), group, Date.now());
  const sats = useLayer<Omit<SatsOk, "ok">>(o.active && o.sats ? `/api/edith/earth/satellites?group=${group}` : null, SAT_POLL_MS, SAT_STALE_MS, parseSatellitesResponse as never, now, online, satPaused, {
    initial: () => {
      const t = Date.now();
      const h = hold();
      const held = h && satHoldActive(h, group, t) ? h : null;
      // 正常に取れた最後のデータを端末の保存から出す（端末の中だけ。問い合わせはしない。必ず STALE）
      const saved = readSavedSats(localStore(), group, t);
      if (!held && !saved) return null;
      return {
        fetch: {
          ...EMPTY_FETCH,
          lastOkAt: saved ? Date.parse(saved.fetchedAt) : null,
          lastCount: saved ? saved.elements.length : 0,
          lastError: held ? held.error : null,
          lastErrorAt: held ? held.savedAt : null,
        },
        fail: held ? { reason: held.reason, scope: held.scope, retryAt: held.retryAt } : null,
        data: saved ? (saved as never) : null,
      };
    },
    fromFailure: (payload) => {
      const f = payload as SatellitesFail;
      if (!f || f.ok !== false) return null;
      const last = f.last && f.last.group === group ? f.last : null;
      const okAt = last ? Date.parse(last.fetchedAt) : NaN;
      return {
        last: last && Number.isFinite(okAt) ? (last as never) : null,
        okAt: Number.isFinite(okAt) ? okAt : null,
        count: last ? last.elements.length : 0,
        info: f.reason ? { reason: f.reason, scope: f.scope, retryAt: f.retryAt ?? null } : null,
      };
    },
    onOutcome: (r) => {
      if (r.ok) {
        writeSavedSats(localStore(), r.data as unknown as SatellitesOk);
        // 取れたら、このグループ（または全体）の記録を消す
        const h = hold();
        if (h && (h.scope === "all" || h.group === group)) {
          holdRef.current = null;
          writeSatHold(null);
        }
        return;
      }
      const f = r.payload as SatellitesFail | undefined;
      if (!f || f.ok !== false) return;
      const h = satHoldFromFail(f, group, r.at, r.retryAfterMs);
      if (h) {
        holdRef.current = h;
        writeSatHold(h);
      }
    },
  });
  // 雨雲レーダー：RainViewer の公開 API（ブラウザから直接。ON で EARTH を表示している間だけ、約 10 分ごと）
  const radar = useLayer<Omit<RadarOk, "ok">>(o.active && o.radar ? RAINVIEWER_MAPS_URL : null, RADAR_POLL_MS, RADAR_STALE_MS, parseRadarResponse as never, now, online, paused);
  // 飛行機：見ている範囲が十分に狭いときだけ（0.5 度刻みにそろえて、同じ範囲はまとめる）
  const box = o.viewBox ? roundBBox(o.viewBox) : null;
  const aircraftUrl = o.active && o.aircraft && box && bboxArea(box) <= AIRCRAFT_MAX_AREA ? `/api/edith/earth/aircraft?bbox=${bboxKey(box)}` : null;
  const aircraft = useLayer<Omit<AircraftOk, "ok">>(aircraftUrl, AIRCRAFT_POLL_MS, AIRCRAFT_STALE_MS, parseAircraftResponse as never, now, online, paused);
  const config = useEarthConfig(o.active);
  /** 飛行機を出すには広すぎる範囲を見ている */
  const aircraftTooWide = Boolean(o.aircraft && (!box || bboxArea(box) > AIRCRAFT_MAX_AREA));
  // 都営バス：キーがあり、東京のあたりに寄って見ているときだけ
  const busesInView = Boolean(box && bboxArea(box) <= BUS_MAX_VIEW_AREA && bboxOverlaps(box, TOEI_AREA));
  const buses = useLayer<Omit<BusesOk, "ok">>(o.active && o.buses && config?.services.odpt && busesInView ? "/api/edith/earth/buses" : null, BUS_POLL_MS, BUS_STALE_MS, parseBusesResponse as never, now, online, paused);
  // 船：キーがあり、寄って見ているときだけ
  const shipsInView = Boolean(box && bboxArea(box) <= SHIP_MAX_AREA);
  const ships = useLayer<Omit<ShipsOk, "ok">>(o.active && o.ships && config?.services.ais && shipsInView && box ? `/api/edith/earth/ships?bbox=${bboxKey(box)}` : null, SHIP_POLL_MS, SHIP_STALE_MS, parseShipsResponse as never, now, online, paused);
  // ライブカメラ：キーがあり、探す場所が決まっているときだけ（静止画の URL が切れる前に取り直す）
  const w = o.webcams;
  const webcams = useLayer<Omit<WebcamsOk, "ok">>(
    o.active && w && config?.services.webcams ? `/api/edith/earth/webcams?lat=${w.lat}&lon=${w.lon}&r=${w.radiusKm}${w.traffic ? "&cat=traffic" : ""}` : null,
    WEBCAM_POLL_MS,
    WEBCAM_STALE_MS,
    parseWebcamsResponse as never,
    now,
    online,
    paused,
  );
  return { now, online, quakes, sats, radar, aircraft, aircraftTooWide, config, buses, busesInView, ships, shipsInView, webcams };
}
