/**
 * GOD'S EYE VIEW（EARTH）の船（サーバー専用）。AISStream の WebSocket（wss://stream.aisstream.io/v0/stream）。
 *   - サーバーの関数は長く開いていられないので、要求のたびに数秒だけつないで、見ている範囲の位置の報告（PositionReport）を集める。
 *     集めた船は範囲ごとに覚えておき（15 分で消す）、次の要求で合わせて返す（止まっている船は報告が少ないため）
 *   - 同じ範囲は 60 秒ためておく。同じ範囲を同時に集めない
 *   - キーは環境変数 AISSTREAM_API_KEY（サーバーだけ。画面・ログ・エラー文に出さない）
 */
import { bboxArea, bboxKey, roundBBox, type BBox } from "@/lib/earth/aircraft";
import { parseAisMessage, SHIP_MAX_AREA, type Ship, type ShipsResponse } from "@/lib/earth/transport";

const URL_WS = "wss://stream.aisstream.io/v0/stream";
export const SHIP_COLLECT_MS = 6_000;
export const SHIP_CACHE_MS = 60_000;
const SHIP_FORGET_MS = 15 * 60_000;
const FAIL_WAIT_MS = 2 * 60_000;
const MAX_AREAS = 20;

type Ok = Extract<ShipsResponse, { ok: true }>;
interface Area {
  ships: Map<string, Ship & { seenAt: number }>;
  res: Ok | null;
  at: number;
  running: Promise<void> | null;
}
const areas = new Map<string, Area>();
let blockedUntil = 0;
let blockedError = "";

/** テスト用 */
export function resetShipCache(): void {
  areas.clear();
  blockedUntil = 0;
  blockedError = "";
}

/** WebSocket の最低限の形（テストで差し替える） */
export interface WsLike {
  onopen: (() => void) | null;
  onmessage: ((e: { data: unknown }) => void) | null;
  onerror: (() => void) | null;
  onclose: (() => void) | null;
  send(data: string): void;
  close(): void;
}
export type WsFactory = (url: string) => WsLike;

async function collect(key: string, b: BBox, ms: number, make: WsFactory, now: () => number): Promise<{ ships: Ship[]; error: string | null }> {
  return new Promise((resolve) => {
    const got = new Map<string, Ship>();
    let opened = false;
    let done = false;
    let ws: WsLike;
    const finish = (error: string | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        /* 閉じられなくても続ける */
      }
      resolve({ ships: [...got.values()], error });
    };
    const timer = setTimeout(() => finish(opened ? null : "AISStream に接続できませんでした"), ms);
    try {
      ws = make(URL_WS);
    } catch {
      clearTimeout(timer);
      return resolve({ ships: [], error: "AISStream に接続できませんでした" });
    }
    ws.onopen = () => {
      opened = true;
      ws.send(JSON.stringify({ APIKey: key, BoundingBoxes: [[[b.lamin, b.lomin], [b.lamax, b.lomax]]], FilterMessageTypes: ["PositionReport"] }));
    };
    ws.onmessage = (e) => {
      let raw: unknown;
      try {
        raw = JSON.parse(typeof e.data === "string" ? e.data : Buffer.from(e.data as ArrayBuffer).toString("utf8"));
      } catch {
        return;
      }
      const err = (raw as { error?: unknown })?.error;
      if (typeof err === "string") return finish(/api ?key/i.test(err) ? "AISStream のキーが使えません（AISSTREAM_API_KEY を確認してください）" : "AISStream がエラーを返しました");
      const s = parseAisMessage(raw, now());
      if (s && s.lat >= b.lamin && s.lat <= b.lamax && s.lon >= b.lomin && s.lon <= b.lomax) got.set(s.mmsi, s);
    };
    ws.onerror = () => finish(opened ? null : "AISStream に接続できませんでした");
    ws.onclose = () => finish(opened ? null : "AISStream に接続できませんでした");
  });
}

export async function getShips(bbox: BBox, opts: { now?: number; env?: Record<string, string | undefined>; ws?: WsFactory; collectMs?: number } = {}): Promise<{ res: ShipsResponse; retryAfterSec?: number; cached: boolean }> {
  const clock = () => opts.now ?? Date.now();
  const now = clock();
  const key = (opts.env ?? process.env).AISSTREAM_API_KEY?.trim();
  if (!key) return { res: { ok: false, error: "AISStream のキーが未設定です（AISSTREAM_API_KEY）" }, cached: true };
  const b = roundBBox(bbox);
  if (bboxArea(b) > SHIP_MAX_AREA) return { res: { ok: false, error: "範囲が広すぎます（もっと寄ると表示します）" }, cached: true };
  const k = bboxKey(b);
  let area = areas.get(k);
  if (area?.res && now - area.at < SHIP_CACHE_MS) return { res: area.res, cached: true };
  if (now < blockedUntil) return { res: { ok: false, error: blockedError }, retryAfterSec: Math.ceil((blockedUntil - now) / 1000), cached: true };
  if (!area) {
    if (areas.size >= MAX_AREAS) areas.delete(areas.keys().next().value as string);
    area = { ships: new Map(), res: null, at: 0, running: null };
    areas.set(k, area);
  }
  const a = area;
  if (!a.running) {
    const make: WsFactory = opts.ws ?? ((url) => new WebSocket(url) as unknown as WsLike);
    a.running = collect(key, b, opts.collectMs ?? SHIP_COLLECT_MS, make, clock).then(({ ships, error }) => {
      const t = clock();
      if (error && !ships.length) {
        blockedUntil = t + FAIL_WAIT_MS;
        blockedError = error;
        return;
      }
      for (const s of ships) a.ships.set(s.mmsi, { ...s, seenAt: t });
      for (const [m, s] of a.ships) if (t - s.seenAt > SHIP_FORGET_MS) a.ships.delete(m);
      a.res = { ok: true, source: "AISStream", fetchedAt: new Date(t).toISOString(), bbox: b, items: [...a.ships.values()].map(({ seenAt: _s, ...s }) => s) };
      a.at = t;
    });
    void a.running.finally(() => (a.running = null));
  }
  await a.running;
  if (a.res && clock() - a.at < SHIP_CACHE_MS + SHIP_COLLECT_MS * 2) return { res: a.res, cached: false };
  const t = clock();
  return { res: { ok: false, error: blockedError || "AISStream のデータを読めませんでした" }, retryAfterSec: Math.max(1, Math.ceil((blockedUntil - t) / 1000)), cached: false };
}
