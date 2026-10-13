/**
 * E.D.I.T.H. GOD'S EYE VIEW（EARTH）：地震・人工衛星・レイヤーの状態・定期取得・設定・API のテスト。
 * 外部には通信しない（USGS・CelesTrak の応答は、偽の fetch で返す）。
 *   npm test
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { twoline2satrec, sgp4, gstime, propagate } from "satellite.js";

const { layerStatus, EMPTY_FETCH, agoText, utcText } = await import("../src/lib/earth/status");
const { magBand, MAG_BANDS, depthText, parseQuakesResponse, QUAKE_POLL_MS } = await import("../src/lib/earth/quakes");
const sat = await import("../src/lib/earth/satellites");
const { createPoller, PollError, MAX_TIMER_MS } = await import("../src/lib/earth/poller");
const { parseEarthSettings, DEFAULT_EARTH } = await import("../src/lib/earth/settings");
const { getQuakes, resetQuakeCache, QUAKE_CACHE_MS } = await import("../src/integrations/earth/quakes");
const { getSatellites, resetSatelliteCache, celestrakUrl, SAT_CACHE_MS, SAT_LONG_STOP_MS, SAT_RATE_MAX_MS } = await import("../src/integrations/earth/satellites");
const display = await import("../src/lib/edith-display");

const NOW = Date.parse("2026-10-12T06:00:00Z");

/* ---------- 偽の fetch ---------- */
type Reply = { status?: number; body?: unknown; headers?: Record<string, string>; url?: string; throws?: string };
function fakeFetch(replies: Reply[]) {
  const calls: string[] = [];
  const fn = async (url: string) => {
    calls.push(url);
    const r = replies.length > 1 ? replies.shift()! : replies[0];
    if (r.throws) throw Object.assign(new Error(r.throws), { name: r.throws });
    const text = typeof r.body === "string" ? r.body : JSON.stringify(r.body ?? {});
    const res = new Response(text, { status: r.status ?? 200, headers: r.headers ?? {} });
    Object.defineProperty(res, "url", { value: r.url ?? url });
    return res;
  };
  return { fn, calls };
}
/** ログを出さない（テストの出力を汚さない） */
const quiet = () => {};

/* ---------- USGS の見本 ---------- */
const feature = (id: string, mag: number | null, coords: unknown[], time = NOW - 3_600_000, extra: Record<string, unknown> = {}) => ({
  type: "Feature",
  id,
  geometry: { type: "Point", coordinates: coords },
  properties: { mag, place: `place of ${id}`, time, updated: time + 60_000, url: `https://earthquake.usgs.gov/earthquakes/eventpage/${id}`, status: "reviewed", ...extra },
});
const usgs = (features: unknown[]) => ({ type: "FeatureCollection", metadata: { generated: NOW }, features });

/* ---------- 衛星の見本（Vallado の SGP4 検証用の衛星 00005） ---------- */
const TLE1 = "1 00005U 58002B   00179.78495062  .00000023  00000-0  28098-4 0  4753";
const TLE2 = "2 00005  34.2682 348.7242 1859667 331.7664  19.3264 10.82419157413667";
const OMM_00005 = {
  OBJECT_NAME: "VANGUARD 1",
  OBJECT_ID: "1958-002B",
  EPOCH: "2000-06-27T18:50:19.733568",
  MEAN_MOTION: 10.82419157,
  ECCENTRICITY: 0.1859667,
  INCLINATION: 34.2682,
  RA_OF_ASC_NODE: 348.7242,
  ARG_OF_PERICENTER: 331.7664,
  MEAN_ANOMALY: 19.3264,
  EPHEMERIS_TYPE: 0,
  CLASSIFICATION_TYPE: "U",
  NORAD_CAT_ID: 5,
  ELEMENT_SET_NO: 475,
  REV_AT_EPOCH: 41366,
  BSTAR: 0.000028098,
  MEAN_MOTION_DOT: 0.00000023,
  MEAN_MOTION_DDOT: 0,
};
const ommAt = (id: number, name: string, epoch: string) => ({ ...OMM_00005, NORAD_CAT_ID: id, OBJECT_NAME: name, EPOCH: epoch });

/* ---------- 1. レイヤーの状態 ---------- */

describe("レイヤーの状態（実際の取得の結果だけから決める）", () => {
  const o = { now: NOW, online: true, staleAfterMs: 600_000 };
  it("最初の取得中は LOADING、一度も取れずに失敗したら ERROR", () => {
    assert.equal(layerStatus({ ...EMPTY_FETCH, loading: true }, o), "LOADING");
    assert.equal(layerStatus({ ...EMPTY_FETCH, lastError: "x", lastErrorAt: NOW }, o), "ERROR");
  });
  it("取れた → LIVE、0 件 → NO DATA", () => {
    assert.equal(layerStatus({ ...EMPTY_FETCH, lastOkAt: NOW - 1000, lastCount: 5 }, o), "LIVE");
    assert.equal(layerStatus({ ...EMPTY_FETCH, lastOkAt: NOW - 1000, lastCount: 0 }, o), "NO DATA");
  });
  it("取れた後に失敗した・古くなった → STALE（LIVE にしない）", () => {
    assert.equal(layerStatus({ ...EMPTY_FETCH, lastOkAt: NOW - 5000, lastCount: 5, lastError: "x", lastErrorAt: NOW - 1000 }, o), "STALE");
    assert.equal(layerStatus({ ...EMPTY_FETCH, lastOkAt: NOW - 700_000, lastCount: 5 }, o), "STALE");
    // 取得中でも、前のデータが古ければ STALE のまま
    assert.equal(layerStatus({ ...EMPTY_FETCH, loading: true, lastOkAt: NOW - 700_000, lastCount: 5 }, o), "STALE");
  });
  it("オフラインなら OFFLINE（データがあっても LIVE にしない）", () => {
    assert.equal(layerStatus({ ...EMPTY_FETCH, lastOkAt: NOW, lastCount: 5 }, { ...o, online: false }), "OFFLINE");
  });
  it("時刻の表示", () => {
    assert.equal(agoText(NOW - 90_000, NOW), "2 分前");
    assert.equal(agoText(null, NOW), "—");
    assert.equal(utcText("2026-10-12T05:12:03.456Z"), "2026-10-12 05:12:03 UTC");
    assert.equal(utcText("x"), "—");
  });
});

/* ---------- 2. 地震 ---------- */

describe("地震（USGS）：取得・読み取り・ためておく・失敗", () => {
  beforeEach(() => resetQuakeCache());

  it("正常な GeoJSON：位置・発生時刻・規模・深さ・地域を読み、取得時刻は発生時刻と別に持つ", async () => {
    const f = fakeFetch([{ body: usgs([feature("us1", 6.2, [142.5, 38.1, 35.4]), feature("us2", 4.7, [-70.1, -20.2, 110])]) }]);
    const r = await getQuakes({ now: NOW, fetchImpl: f.fn });
    assert.equal(r.res.ok, true);
    if (!r.res.ok) return;
    assert.equal(f.calls.length, 1);
    assert.match(f.calls[0], /^https:\/\/earthquake\.usgs\.gov\//);
    assert.equal(r.res.fetchedAt, new Date(NOW).toISOString());
    const q = r.res.items.find((i) => i.id === "us1")!;
    assert.deepEqual([q.lat, q.lon, q.depthKm, q.mag], [38.1, 142.5, 35.4, 6.2]);
    assert.equal(q.time, new Date(NOW - 3_600_000).toISOString(), "発生時刻（取得時刻ではない）");
    assert.notEqual(q.time, r.res.fetchedAt);
    assert.equal(q.place, "place of us1");
    assert.equal(q.status, "reviewed");
  });

  it("おかしな地震（規模・座標・時刻が無い・範囲外）は捨て、正しいものだけ返す", async () => {
    const f = fakeFetch([
      {
        body: usgs([
          feature("ok", 5.1, [10, 10, 5]),
          feature("nomag", null, [10, 10, 5]),
          feature("nocoord", 5, []),
          feature("badlat", 5, [10, 95, 5]),
          { ...feature("notime", 5, [10, 10, 5]), properties: { mag: 5 } },
        ]),
      },
    ]);
    const r = await getQuakes({ now: NOW, fetchImpl: f.fn });
    assert.equal(r.res.ok, true);
    if (r.res.ok) assert.deepEqual(r.res.items.map((i) => i.id), ["ok"]);
  });

  it("全体の形が違う → ok:false（作ったデータは返さない）。0 件 → ok:true・items は空", async () => {
    const bad = await getQuakes({ now: NOW, fetchImpl: fakeFetch([{ body: { type: "Nope" } }]).fn });
    assert.equal(bad.res.ok, false);
    resetQuakeCache();
    const empty = await getQuakes({ now: NOW, fetchImpl: fakeFetch([{ body: usgs([]) }]).fn });
    assert.equal(empty.res.ok, true);
    if (empty.res.ok) assert.deepEqual(empty.res.items, []);
  });

  it("60 秒はためておいた結果を返し、USGS に取りに行かない。過ぎたら取り直す", async () => {
    const f = fakeFetch([{ body: usgs([feature("a", 5, [1, 1, 1])]) }]);
    await getQuakes({ now: NOW, fetchImpl: f.fn });
    const again = await getQuakes({ now: NOW + QUAKE_CACHE_MS - 1, fetchImpl: f.fn });
    assert.equal(again.cached, true);
    assert.equal(f.calls.length, 1);
    await getQuakes({ now: NOW + QUAKE_CACHE_MS, fetchImpl: f.fn });
    assert.equal(f.calls.length, 2);
  });

  it("失敗（HTTP 500・時間切れ・通信失敗）→ ok:false・待ち時間つき。待っている間は取りに行かない", async () => {
    for (const reply of [{ status: 500 }, { throws: "TimeoutError" }, { throws: "TypeError" }] as Reply[]) {
      resetQuakeCache();
      const f = fakeFetch([reply]);
      const r = await getQuakes({ now: NOW, fetchImpl: f.fn });
      assert.equal(r.res.ok, false);
      assert.ok((r.retryAfterSec ?? 0) >= 60);
      const again = await getQuakes({ now: NOW + 30_000, fetchImpl: f.fn });
      assert.equal(again.res.ok, false);
      assert.equal(f.calls.length, 1, "待っている間は USGS に取りに行かない");
    }
  });

  it("429 と Retry-After を守る（それより早く取りに行かない）", async () => {
    const f = fakeFetch([{ status: 429, headers: { "retry-after": "300" } }, { body: usgs([]) }]);
    const r = await getQuakes({ now: NOW, fetchImpl: f.fn });
    assert.equal(r.res.ok, false);
    if (!r.res.ok) assert.match(r.res.error, /制限/);
    assert.equal(r.retryAfterSec, 300);
    await getQuakes({ now: NOW + 200_000, fetchImpl: f.fn });
    assert.equal(f.calls.length, 1);
    await getQuakes({ now: NOW + 300_000, fetchImpl: f.fn });
    assert.equal(f.calls.length, 2);
  });

  it("許可していない取得先への転送・大きすぎるデータは失敗にする", async () => {
    const redirected = await getQuakes({ now: NOW, fetchImpl: fakeFetch([{ body: usgs([]), url: "https://evil.example/x" }]).fn });
    assert.equal(redirected.res.ok, false);
    resetQuakeCache();
    const big = await getQuakes({ now: NOW, fetchImpl: fakeFetch([{ body: usgs([]), headers: { "content-length": "9999999" } }]).fn });
    assert.equal(big.res.ok, false);
    if (!big.res.ok) assert.match(big.res.error, /大きすぎ/);
  });

  it("画面側の確認：形の違うもの・USGS 以外のリンクは使わない", () => {
    const r = parseQuakesResponse({
      ok: true,
      fetchedAt: new Date(NOW).toISOString(),
      items: [
        { id: "a", lat: 1, lon: 2, mag: 5, time: new Date(NOW).toISOString(), url: "https://evil.example/" },
        { id: "b", lat: 100, lon: 2, mag: 5, time: new Date(NOW).toISOString() },
        { id: "c", lat: 1, lon: 2, mag: "5", time: new Date(NOW).toISOString() },
      ],
    });
    assert.ok(r && r.ok);
    if (r && r.ok) {
      assert.deepEqual(r.items.map((i) => i.id), ["a"]);
      assert.equal(r.items[0].url, null);
    }
    assert.equal(parseQuakesResponse({ ok: true, items: "x" }), null);
    assert.deepEqual(parseQuakesResponse({ ok: false, error: "x" }), { ok: false, error: "x" });
  });

  it("規模の区分（凡例）と深さの説明", () => {
    assert.equal(magBand(7.4).label, "M7.0+");
    assert.equal(magBand(6).label, "M6.0–6.9");
    assert.equal(magBand(4.6).label, "M5.0 未満");
    assert.ok(MAG_BANDS[0].size > MAG_BANDS[3].size, "大きい地震ほど大きく描く");
    assert.equal(depthText(null), "不明");
    assert.match(depthText(35.4), /浅い/);
    assert.match(depthText(400), /深い/);
  });
});

/* ---------- 3. 人工衛星 ---------- */

describe("人工衛星：軌道データの読み取り", () => {
  it("正常な OMM を読む（番号・名前・国際標識番号・軌道要素の時刻）", () => {
    const el = sat.parseOmm(OMM_00005)!;
    assert.equal(el.id, "5");
    assert.equal(el.name, "VANGUARD 1");
    assert.equal(el.intlId, "1958-002B");
    assert.equal(el.epoch, "2000-06-27T18:50:19.733Z");
  });

  it("おかしな軌道データは捨てる", () => {
    const bad = [
      null,
      "x",
      [],
      { ...OMM_00005, OBJECT_NAME: "" },
      { ...OMM_00005, NORAD_CAT_ID: -1 },
      { ...OMM_00005, EPOCH: "not a date" },
      { ...OMM_00005, ECCENTRICITY: 1.2 },
      { ...OMM_00005, MEAN_MOTION: 0 },
      { ...OMM_00005, INCLINATION: "abc" },
      { ...OMM_00005, EPHEMERIS_TYPE: 2 },
      { ...OMM_00005, REF_FRAME: "GCRF" },
      { ...OMM_00005, CENTER_NAME: "MOON" },
      { ...OMM_00005, BSTAR: undefined },
    ];
    for (const b of bad) assert.equal(sat.parseOmm(b), null, JSON.stringify(b));
    assert.throws(() => sat.parseOmmList({ not: "array" }));
  });

  it("同じ番号は 1 件に・上限の件数まで", () => {
    const list = [ommAt(1, "A", "2026-10-11T00:00:00"), ommAt(1, "A2", "2026-10-11T00:00:00"), ommAt(2, "B", "2026-10-11T00:00:00"), ommAt(3, "C", "2026-10-11T00:00:00")];
    assert.deepEqual(sat.parseOmmList(list).map((e) => e.id), ["1", "2", "3"]);
    assert.equal(sat.parseOmmList(list, 2).length, 2);
  });

  it("文字の数字（CelesTrak の CSV 風）も読む", () => {
    const el = sat.parseOmm({ ...OMM_00005, MEAN_MOTION: "10.82419157", NORAD_CAT_ID: "5" });
    assert.ok(el);
  });
});

describe("人工衛星：satellite.js による位置の計算（既知の値で確かめる）", () => {
  it("Vallado の SGP4 検証値：衛星 00005 の軌道要素の時刻での位置（TEME・km）", () => {
    const rec = twoline2satrec(TLE1, TLE2);
    const pv = sgp4(rec, 0)!;
    const p = pv.position as { x: number; y: number; z: number };
    assert.ok(Math.abs(p.x - 7022.46529266) < 1e-3, String(p.x));
    assert.ok(Math.abs(p.y - -1400.08296755) < 1e-3, String(p.y));
    assert.ok(Math.abs(p.z - 0.03995155) < 1e-3, String(p.z));
  });

  it("OMM（JSON）から作った計算と、同じ軌道要素の TLE から作った計算が一致する", () => {
    const fromOmm = sat.makeSatrec(sat.parseOmm(OMM_00005)!)!;
    const fromTle = twoline2satrec(TLE1, TLE2);
    for (const minutes of [0, 360, 1440]) {
      const at = new Date(Date.parse("2000-06-27T18:50:19.733Z") + minutes * 60_000);
      const a = propagate(fromOmm, at)!.position as { x: number; y: number; z: number };
      const b = propagate(fromTle, at)!.position as { x: number; y: number; z: number };
      for (const k of ["x", "y", "z"] as const) assert.ok(Math.abs(a[k] - b[k]) < 0.01, `${minutes}min ${k}: ${a[k]} vs ${b[k]}`);
    }
  });

  it("座標の変換：慣性系 → 地球に固定（グリニッジ恒星時で回す）→ 緯度・経度・高度。別の計算と一致する", () => {
    const rec = sat.makeSatrec(sat.parseOmm(OMM_00005)!)!;
    const at = Date.parse("2000-06-28T00:00:00Z");
    const pos = sat.satPosition(rec, at)!;
    // 別の計算：TEME を恒星時で回して地球固定にし、WGS84 の楕円体で緯度・高度を求める
    const r = propagate(rec, new Date(at))!.position as { x: number; y: number; z: number };
    const g = gstime(new Date(at));
    const x = r.x * Math.cos(g) + r.y * Math.sin(g);
    const y = -r.x * Math.sin(g) + r.y * Math.cos(g);
    const z = r.z;
    const a = 6378.137;
    const e2 = 0.00669437999014;
    const lon = (Math.atan2(y, x) * 180) / Math.PI;
    const pxy = Math.hypot(x, y);
    let lat = Math.atan2(z, pxy * (1 - e2));
    let h = 0;
    for (let i = 0; i < 10; i++) {
      const n = a / Math.sqrt(1 - e2 * Math.sin(lat) ** 2);
      h = pxy / Math.cos(lat) - n;
      lat = Math.atan2(z, pxy * (1 - (e2 * n) / (n + h)));
    }
    assert.ok(Math.abs(pos.lon - lon) < 0.01, `lon ${pos.lon} vs ${lon}`);
    assert.ok(Math.abs(pos.lat - (lat * 180) / Math.PI) < 0.05, `lat ${pos.lat}`);
    assert.ok(Math.abs(pos.heightKm - h) < 2, `h ${pos.heightKm} vs ${h}`);
    assert.equal(pos.at, at, "計算に使った時刻を持つ");
    assert.ok(Math.abs(pos.lat) <= 90 && Math.abs(pos.lon) <= 180);
  });

  it("恒星時の回転：経度は時刻とともに西へずれる（同じ慣性系の位置でも地球が回るため）", () => {
    const rec = sat.makeSatrec(sat.parseOmm(OMM_00005)!)!;
    const t0 = Date.parse("2000-06-28T00:00:00Z");
    const a = sat.satPosition(rec, t0)!;
    const b = sat.satPosition(rec, t0 + 60_000)!;
    assert.notDeepEqual([a.lat, a.lon], [b.lat, b.lon]);
  });

  it("計算できない軌道（初期化の失敗）は null。描かない", () => {
    const el = sat.parseOmm({ ...OMM_00005, MEAN_MOTION: 0.01 })!;
    const rec = el ? sat.makeSatrec(el) : null;
    if (rec) assert.equal(sat.satPosition(rec, Date.parse("2000-06-28T00:00:00Z")), null);
  });

  it("軌道要素の新しさ：3 日以内は fresh・7 日以内は aging・それより古いと stale", () => {
    const day = 86_400_000;
    assert.equal(sat.orbitFreshness(new Date(NOW - day).toISOString(), NOW), "fresh");
    assert.equal(sat.orbitFreshness(new Date(NOW - 5 * day).toISOString(), NOW), "aging");
    assert.equal(sat.orbitFreshness(new Date(NOW - 30 * day).toISOString(), NOW), "stale");
    assert.equal(sat.orbitFreshness("x", NOW), "stale");
  });
});

describe("人工衛星：CelesTrak からの取得とためておく", () => {
  beforeEach(() => resetSatelliteCache());

  it("決まったグループの URL だけ（celestrak.org・FORMAT=json）", () => {
    assert.equal(celestrakUrl("stations"), "https://celestrak.org/NORAD/elements/gp.php?GROUP=stations&FORMAT=json");
    assert.equal(sat.isSatGroup("stations"), true);
    assert.equal(sat.isSatGroup("all"), false);
    assert.equal(sat.isSatGroup("../x"), false);
  });

  it("取れた軌道データを返し、2 時間は取りに行かない（グループごと）", async () => {
    const f = fakeFetch([{ body: [ommAt(25544, "ISS (ZARYA)", "2026-10-12T01:00:00")] }]);
    const r = await getSatellites("stations", { now: NOW, fetchImpl: f.fn });
    assert.equal(r.res.ok, true);
    if (r.res.ok) {
      assert.equal(r.res.elements[0].name, "ISS (ZARYA)");
      assert.equal(r.res.fetchedAt, new Date(NOW).toISOString());
    }
    await getSatellites("stations", { now: NOW + SAT_CACHE_MS - 1, fetchImpl: f.fn });
    assert.equal(f.calls.length, 1, "2 時間以内は取りに行かない");
    await getSatellites("visual", { now: NOW + 1000, fetchImpl: f.fn });
    assert.equal(f.calls.length, 2, "別のグループは別に取る");
    await getSatellites("stations", { now: NOW + SAT_CACHE_MS, fetchImpl: f.fn });
    assert.equal(f.calls.length, 3);
  });

  it("HTTP 403 → 全体を止め、自動では取りに行かない（時間がたっても）。接続の失敗 → 15 分", async () => {
    const f = fakeFetch([{ status: 403 }]);
    const r = await getSatellites("stations", { now: NOW, fetchImpl: f.fn, log: quiet });
    assert.equal(r.res.ok, false);
    if (!r.res.ok) {
      assert.equal(r.res.reason, "halted");
      assert.equal(r.res.scope, "all");
      assert.equal(r.res.retryAt, null);
    }
    assert.equal(r.retryAfterSec, 6 * 3600, "画面が状態を確かめに来る間隔（外へは取りに行かない）");
    await getSatellites("stations", { now: NOW + 30 * 86_400_000, fetchImpl: f.fn, log: quiet });
    await getSatellites("visual", { now: NOW + 30 * 86_400_000, fetchImpl: f.fn, log: quiet });
    assert.equal(f.calls.length, 1, "403 の後は、どのグループも自動では取りに行かない");
    resetSatelliteCache();
    const n = fakeFetch([{ throws: "TypeError" }]);
    const r2 = await getSatellites("stations", { now: NOW, fetchImpl: n.fn, log: quiet });
    assert.equal(r2.retryAfterSec, 900);
  });

  it("全体の形が違う → ok:false（作ったデータは返さない）", async () => {
    const r = await getSatellites("stations", { now: NOW, fetchImpl: fakeFetch([{ body: { error: "x" } }]).fn, log: quiet });
    assert.equal(r.res.ok, false);
  });

  it("画面側の確認：応答の軌道データをもう一度確かめる", () => {
    const r = sat.parseSatellitesResponse({ ok: true, group: "stations", fetchedAt: new Date(NOW).toISOString(), elements: [{ omm: OMM_00005 }, { omm: { bad: 1 } }] });
    assert.ok(r && r.ok);
    if (r && r.ok) assert.equal(r.elements.length, 1);
    assert.equal(sat.parseSatellitesResponse({ ok: true, group: "all", fetchedAt: "x", elements: [] }), null);
  });
});

/* ---------- 人工衛星：取得に失敗したときの扱い（見本の応答だけ。実データではない） ---------- */

const H = 3_600_000;
const D = 24 * H;
const okBody = () => [ommAt(25544, "ISS (ZARYA)", "2026-10-12T01:00:00")];
/** 取りに行った回数を数え、渡された init を記録する偽の fetch（応答は関数で決める） */
function scriptFetch(reply: (n: number, url: string) => Reply & { redirected?: boolean }) {
  const calls: string[] = [];
  const inits: (RequestInit | undefined)[] = [];
  const fn = async (url: string, init?: RequestInit) => {
    calls.push(url);
    inits.push(init);
    const r = reply(calls.length, url);
    if (r.throws) throw Object.assign(new Error(r.throws), { name: r.throws });
    const text = typeof r.body === "string" ? r.body : JSON.stringify(r.body ?? {});
    const res = new Response(r.status && r.status >= 300 && r.status < 400 ? null : text, { status: r.status ?? 200, headers: r.headers ?? {} });
    Object.defineProperty(res, "url", { value: r.url ?? url });
    if (r.redirected) Object.defineProperty(res, "redirected", { value: true });
    return res;
  };
  return { fn, calls, inits };
}
const get = (group: "stations" | "visual" | "weather" | "gnss", now: number, f: { fn: unknown }, logs?: string[]) =>
  getSatellites(group, { now, fetchImpl: f.fn as never, log: logs ? (m: string) => logs.push(m) : quiet });
const failOf = (r: Awaited<ReturnType<typeof getSatellites>>) => {
  assert.equal(r.res.ok, false);
  return r.res as Extract<typeof r.res, { ok: false }>;
};

describe("人工衛星：失敗したときの扱い（全体・グループ・待ち時間）", () => {
  beforeEach(() => resetSatelliteCache());

  it("取りに行くときはリダイレクトに付いていかない（redirect: manual）", async () => {
    const f = scriptFetch(() => ({ body: okBody() }));
    await get("stations", NOW, f);
    assert.equal(f.inits[0]?.redirect, "manual");
  });

  it("401・410・400 も全体を止め、自動では取りに行かない", async () => {
    for (const status of [401, 410, 400]) {
      resetSatelliteCache();
      const f = scriptFetch(() => ({ status }));
      const r = failOf(await get("stations", NOW, f));
      assert.equal(r.reason, "halted");
      assert.equal(r.scope, "all");
      await get("weather", NOW + 10 * D, f);
      assert.equal(f.calls.length, 1, `HTTP ${status}`);
    }
  });

  it("リダイレクト（301 の応答・付いていった転送のどちらも）→ 全体を止める", async () => {
    const a = scriptFetch(() => ({ status: 301, headers: { Location: "https://celestrak.org/other" } }));
    const r = failOf(await get("stations", NOW, a));
    assert.equal(r.reason, "halted");
    assert.equal(r.scope, "all");
    assert.match(r.error, /リダイレクト/);
    await get("visual", NOW + D, a);
    assert.equal(a.calls.length, 1);
    resetSatelliteCache();
    const b = scriptFetch(() => ({ body: okBody(), redirected: true }));
    const r2 = failOf(await get("stations", NOW, b));
    assert.equal(r2.reason, "halted");
    assert.equal(r2.scope, "all");
  });

  it("429（待ち時間の指定なし）→ 2 時間・4 時間…と倍、最長 24 時間。期限まで取りに行かない", async () => {
    const f = scriptFetch(() => ({ status: 429 }));
    let t = NOW;
    const waits: number[] = [];
    for (let i = 0; i < 6; i++) {
      const r = failOf(await get("stations", t, f));
      assert.equal(r.reason, "rate-limited");
      assert.equal(r.scope, "all");
      const until = Date.parse(r.retryAt!);
      waits.push(until - t);
      const before = f.calls.length;
      await get("visual", until - 1, f);
      assert.equal(f.calls.length, before, "期限の前は、別のグループでも取りに行かない");
      t = until;
    }
    assert.deepEqual(waits, [2 * H, 4 * H, 8 * H, 16 * H, SAT_RATE_MAX_MS, SAT_RATE_MAX_MS]);
  });

  it("429 の Retry-After が長い（3 日・30 日）→ 短くしない。短い（60 秒）→ 2 時間", async () => {
    for (const [ra, expect] of [[3 * 86_400, 3 * D], [30 * 86_400, 30 * D], [60, 2 * H]] as const) {
      resetSatelliteCache();
      const f = scriptFetch(() => ({ status: 429, headers: { "Retry-After": String(ra) } }));
      const res = await get("stations", NOW, f);
      const r = failOf(res);
      assert.equal(Date.parse(r.retryAt!) - NOW, expect, `Retry-After ${ra}`);
      assert.equal(res.retryAfterSec, expect / 1000);
      await get("stations", NOW + expect - 1, f);
      assert.equal(f.calls.length, 1, "相手の指定より前には取りに行かない");
      await get("stations", NOW + expect, f);
      assert.equal(f.calls.length, 2);
    }
  });

  it("一時的な失敗（接続・500・時間切れ・503）→ 15・30・60・120 分。5 回目で長期停止（24 時間）→ 24 時間後に 1 回だけ → 成功で元に戻る", async () => {
    let mode: "fail" | "ok" = "fail";
    const kinds: Reply[] = [{ throws: "TypeError" }, { status: 500 }, { throws: "TimeoutError" }, { status: 503 }, { status: 502 }];
    const f = scriptFetch((n) => (mode === "ok" ? { body: okBody() } : kinds[(n - 1) % kinds.length]));
    let t = NOW;
    const seen: [string | undefined, number][] = [];
    for (let i = 0; i < 5; i++) {
      const r = failOf(await get("stations", t, f));
      const until = Date.parse(r.retryAt!);
      seen.push([r.reason, until - t]);
      await get("stations", until - 1, f);
      assert.equal(f.calls.length, i + 1, "期限の前は取りに行かない");
      t = until;
    }
    assert.deepEqual(seen, [["temporary", 15 * 60_000], ["temporary", 30 * 60_000], ["temporary", 60 * 60_000], ["temporary", 120 * 60_000], ["long-stop", SAT_LONG_STOP_MS]]);
    // 長期停止の後の 1 回も失敗 → また 24 時間
    const again = failOf(await get("stations", t, f));
    assert.equal(again.reason, "long-stop");
    assert.equal(Date.parse(again.retryAt!) - t, SAT_LONG_STOP_MS);
    assert.equal(f.calls.length, 6);
    t = Date.parse(again.retryAt!);
    mode = "ok";
    const ok = await get("stations", t, f);
    assert.equal(ok.res.ok, true);
    // 元に戻ったので、次の一時的な失敗はまた 15 分から
    mode = "fail";
    const next = failOf(await get("visual", t + 1, f));
    assert.equal(next.reason, "temporary");
    assert.equal(Date.parse(next.retryAt!) - (t + 1), 15 * 60_000);
  });

  it("503 の Retry-After が一時的な待ち時間より長ければ、そちらを守る", async () => {
    const f = scriptFetch(() => ({ status: 503, headers: { "Retry-After": String(5 * 3600) } }));
    const r = failOf(await get("stations", NOW, f));
    assert.equal(r.reason, "temporary");
    assert.equal(Date.parse(r.retryAt!) - NOW, 5 * H);
  });

  it("404：24 時間以内に別のグループが取れていれば、このグループだけ止める", async () => {
    const f = scriptFetch((_n, url) => (url.includes("GROUP=weather") ? { status: 404 } : { body: okBody() }));
    assert.equal((await get("visual", NOW, f)).res.ok, true);
    const r = failOf(await get("weather", NOW + H, f));
    assert.equal(r.reason, "halted");
    assert.equal(r.scope, "group");
    // 他のグループは取れる・このグループはもう取りに行かない
    assert.equal((await get("stations", NOW + 2 * H, f)).res.ok, true);
    const before = f.calls.length;
    failOf(await get("weather", NOW + 5 * D, f));
    assert.equal(f.calls.length, before);
  });

  it("404：判断の材料が無い（起動したばかり・成功が 24 時間より前）→ 全体を止める（安全側）", async () => {
    const a = scriptFetch(() => ({ status: 404 }));
    const r = failOf(await get("weather", NOW, a));
    assert.equal(r.scope, "all");
    assert.equal(r.reason, "halted");
    resetSatelliteCache();
    const b = scriptFetch((_n, url) => (url.includes("GROUP=weather") ? { status: 404 } : { body: okBody() }));
    await get("visual", NOW, b);
    const r2 = failOf(await get("weather", NOW + D + 1, b));
    assert.equal(r2.scope, "all");
  });

  it("データの形の異常 → このグループだけ止め、理由を残す。2 グループで起きたら全体を止める。本文はログに出さない", async () => {
    const logs: string[] = [];
    const f = scriptFetch((_n, url) =>
      url.includes("GROUP=weather") ? { body: "SECRET-BODY not json" } : url.includes("GROUP=gnss") ? { body: [{ bad: "SECRET-BODY" }] } : { body: okBody() },
    );
    const r = failOf(await get("weather", NOW, f, logs));
    assert.equal(r.reason, "halted");
    assert.equal(r.scope, "group");
    assert.match(r.error, /JSON/);
    assert.equal((await get("stations", NOW, f, logs)).res.ok, true, "別のグループは取れる");
    const r2 = failOf(await get("gnss", NOW, f, logs));
    assert.equal(r2.scope, "all", "2 つのグループで起きたら全体");
    const before = f.calls.length;
    await get("visual", NOW + 10 * D, f, logs);
    assert.equal(f.calls.length, before);
    assert.ok(logs.length >= 2);
    for (const l of logs) assert.doesNotMatch(l, /SECRET-BODY/, "応答の本文はログに出さない");
    assert.ok(!r.error.includes("SECRET") && !r2.error.includes("SECRET"), "応答の本文は画面に出さない");
  });

  it("配列でない・正しい衛星が 1 件も無い → 異常。空の配列 [] は正常（0 件）", async () => {
    const a = failOf(await get("stations", NOW, scriptFetch(() => ({ body: { not: "array" } }))));
    assert.equal(a.scope, "group");
    resetSatelliteCache();
    const b = failOf(await get("stations", NOW, scriptFetch(() => ({ body: [{ OBJECT_NAME: "x" }] }))));
    assert.equal(b.scope, "group");
    resetSatelliteCache();
    const c = await get("stations", NOW, scriptFetch(() => ({ body: [] })));
    assert.equal(c.res.ok, true);
    if (c.res.ok) assert.equal(c.res.elements.length, 0);
  });

  it("失敗のときは、最後に取れたデータを「その時の取得時刻のまま」付ける。2 時間以内のデータは止めていても返す", async () => {
    let fail = false;
    const f = scriptFetch(() => (fail ? { status: 403 } : { body: okBody() }));
    assert.equal((await get("stations", NOW, f)).res.ok, true);
    fail = true;
    const r = failOf(await get("visual", NOW + H, f)); // 403 → 全体を止める
    assert.equal(r.last ?? null, null, "別のグループのデータは付けない");
    const cached = await get("stations", NOW + H, f);
    assert.equal(cached.res.ok, true, "2 時間以内のデータはそのまま返す（外へは行かない）");
    const late = failOf(await get("stations", NOW + 3 * H, f));
    assert.equal(late.last?.fetchedAt, new Date(NOW).toISOString(), "取得時刻は最初に取れた時刻のまま");
    assert.equal(f.calls.length, 2);
  });

  it("API：失敗は 502・Retry-After・追加の項目（reason・scope・retryAt・last）", async () => {
    const { GET } = await import("../src/app/api/edith/earth/satellites/route");
    const orig = globalThis.fetch;
    globalThis.fetch = (async () => new Response("x", { status: 429, headers: { "Retry-After": String(3 * 86_400) } })) as typeof fetch;
    const origWarn = console.warn;
    console.warn = () => {};
    try {
      const res = await GET(new Request("http://localhost/api/edith/earth/satellites?group=stations"));
      assert.equal(res.status, 502);
      const ra = Number(res.headers.get("retry-after"));
      assert.ok(ra >= 3 * 86_400 - 2 && ra <= 3 * 86_400, String(ra));
      const body = await res.json();
      assert.equal(body.ok, false);
      assert.equal(body.reason, "rate-limited");
      assert.equal(body.scope, "all");
      assert.ok(typeof body.retryAt === "string");
      assert.equal(body.last, null);
      // 古い画面の読み取りでも読める（追加の項目は無視されるだけ）
      assert.equal(typeof body.error, "string");
      const bad = await GET(new Request("http://localhost/api/edith/earth/satellites?group=all"));
      assert.equal(bad.status, 400);
    } finally {
      globalThis.fetch = orig;
      console.warn = origWarn;
      resetSatelliteCache();
    }
  });
});

describe("人工衛星：画面側の読み取り・端末の停止の記録", () => {
  const okRes = { ok: true, source: "CelesTrak", group: "stations", fetchedAt: new Date(NOW - 5 * H).toISOString(), elements: [{ omm: OMM_00005 }] };

  it("失敗の応答：古い形（error だけ）も、新しい形（追加の項目つき）も読める。おかしな項目は捨てる", () => {
    assert.deepEqual(sat.parseSatellitesResponse({ ok: false, error: "x" }), { ok: false, error: "x" });
    const r = sat.parseSatellitesResponse({ ok: false, error: "e", reason: "halted", scope: "all", retryAt: null, last: okRes });
    assert.ok(r && !r.ok);
    if (r && !r.ok) {
      assert.equal(r.reason, "halted");
      assert.equal(r.scope, "all");
      assert.equal(r.retryAt, null);
      assert.equal(r.last?.fetchedAt, okRes.fetchedAt);
      assert.equal(r.last?.elements.length, 1);
    }
    const junk = sat.parseSatellitesResponse({ ok: false, error: "e", reason: "boom", scope: "x", retryAt: "not a date", last: { ok: true, group: "all" } });
    assert.deepEqual(junk, { ok: false, error: "e" });
  });

  it("端末の停止の記録：止めている → 6 時間。再開時刻があればその時刻（短くしない）。理由の無い古い形 → 記録しない", () => {
    const halted = sat.satHoldFromFail({ ok: false, error: "e", reason: "halted", scope: "all", retryAt: null }, "stations", NOW);
    assert.equal(halted?.until, NOW + sat.SAT_HALT_RECHECK_MS);
    const long = sat.satHoldFromFail({ ok: false, error: "e", reason: "rate-limited", scope: "all", retryAt: new Date(NOW + 30 * D).toISOString() }, "stations", NOW, 60_000);
    assert.equal(long?.until, NOW + 30 * D);
    const byHeader = sat.satHoldFromFail({ ok: false, error: "e", reason: "temporary", scope: "all", retryAt: new Date(NOW + 60_000).toISOString() }, "stations", NOW, 2 * H);
    assert.equal(byHeader?.until, NOW + 2 * H, "サーバーの待ち時間指定のほうが遅ければ、そちら");
    assert.equal(sat.satHoldFromFail({ ok: false, error: "e" }, "stations", NOW), null);
  });

  it("端末の停止の記録：範囲（全体・グループ）と期限。期限が過ぎたら控えない（強制の取り直しはしない）", () => {
    const all = sat.satHoldFromFail({ ok: false, error: "e", reason: "halted", scope: "all", retryAt: null }, "stations", NOW)!;
    assert.equal(sat.satHoldActive(all, "visual", NOW + 1), true);
    assert.equal(sat.satHoldActive(all, "visual", all.until), false);
    const grp = sat.satHoldFromFail({ ok: false, error: "e", reason: "halted", scope: "group", retryAt: null }, "weather", NOW)!;
    assert.equal(grp.group, "weather");
    assert.equal(sat.satHoldActive(grp, "weather", NOW + 1), true);
    assert.equal(sat.satHoldActive(grp, "stations", NOW + 1), false, "グループの停止は他のグループに効かない");
    assert.deepEqual(sat.parseSatHold(JSON.parse(JSON.stringify(grp))), grp);
    assert.equal(sat.parseSatHold({ until: "x" }), null);
    assert.equal(sat.parseSatHold({ until: 1, savedAt: 1, scope: "group", group: "all" }), null);
    // 記録には取り直しを強制する項目が無い
    assert.deepEqual(Object.keys(all).sort(), ["error", "group", "reason", "retryAt", "savedAt", "scope", "until"]);
  });

  it("画面に出す停止の説明（範囲・次の確認・自動では取りに行かない）", () => {
    assert.match(sat.satFailNote({ reason: "halted", scope: "all", retryAt: null })!, /全グループ.*自動では取りに行きません.*再起動/);
    assert.match(sat.satFailNote({ reason: "halted", scope: "group", retryAt: null })!, /このグループ/);
    assert.match(sat.satFailNote({ reason: "rate-limited", scope: "all", retryAt: "2026-10-15T06:00:00.000Z" })!, /2026-10-15 06:00:00 UTC/);
    assert.equal(sat.satFailNote({}), null);
  });
});

/* ---------- 4. 定期取得 ---------- */

class Clock {
  t = NOW;
  timers: { at: number; fn: () => void; id: number }[] = [];
  seq = 0;
  now = () => this.t;
  setTimer = (ms: number, fn: () => void) => {
    const id = ++this.seq;
    this.timers.push({ at: this.t + ms, fn, id });
    return () => (this.timers = this.timers.filter((x) => x.id !== id));
  };
  async advance(ms: number) {
    const end = this.t + ms;
    for (;;) {
      await new Promise((r) => setImmediate(r));
      this.timers.sort((a, b) => a.at - b.at);
      const next = this.timers[0];
      if (!next || next.at > end) break;
      this.timers.shift();
      this.t = next.at;
      next.fn();
    }
    this.t = end;
    await new Promise((r) => setImmediate(r));
  }
}

describe("定期取得（取りに行きすぎない・止めたら後の結果を捨てる）", () => {
  it("始めるまでは取りに行かない。始めたら 1 回、その後は間隔ごと", async () => {
    const c = new Clock();
    let calls = 0;
    const results: string[] = [];
    const p = createPoller({ fetchOnce: async () => (calls++, "x"), intervalMs: 60_000, onResult: (r) => results.push(r.ok ? "ok" : r.error), now: c.now, setTimer: c.setTimer });
    await c.advance(120_000);
    assert.equal(calls, 0, "始める前は取りに行かない（レイヤーが OFF のとき）");
    p.start();
    await c.advance(0);
    assert.equal(calls, 1);
    await c.advance(59_999);
    assert.equal(calls, 1);
    await c.advance(1);
    assert.equal(calls, 2);
    p.stop();
    await c.advance(600_000);
    assert.equal(calls, 2, "止めたら取りに行かない");
  });

  it("止めた後に届いた結果は捨てる", async () => {
    const c = new Clock();
    let resolve!: (v: string) => void;
    const results: unknown[] = [];
    const p = createPoller({ fetchOnce: () => new Promise<string>((r) => (resolve = r)), intervalMs: 60_000, onResult: (r) => results.push(r), now: c.now, setTimer: c.setTimer });
    p.start();
    await c.advance(0);
    p.stop();
    resolve("late");
    await c.advance(0);
    assert.deepEqual(results, []);
  });

  it("失敗しても間隔を縮めない。相手が待ち時間を言えば、それより早く取らない", async () => {
    const c = new Clock();
    let calls = 0;
    const p = createPoller({
      fetchOnce: async () => {
        calls++;
        throw new PollError("制限", 300_000);
      },
      intervalMs: 60_000,
      onResult: () => {},
      now: c.now,
      setTimer: c.setTimer,
    });
    p.start();
    await c.advance(0);
    assert.equal(calls, 1);
    p.refresh();
    await c.advance(299_000);
    assert.equal(calls, 1, "待ち時間の間は、取り直しを押しても取りに行かない");
    await c.advance(1000);
    assert.equal(calls, 2);
    p.stop();
  });

  it("画面が隠れている・オフラインの間は取りに行かない", async () => {
    const c = new Clock();
    let calls = 0;
    let paused = true;
    const p = createPoller({ fetchOnce: async () => (calls++, 1), intervalMs: 60_000, onResult: () => {}, isPaused: () => paused, now: c.now, setTimer: c.setTimer });
    p.start();
    await c.advance(180_000);
    assert.equal(calls, 0);
    paused = false;
    await c.advance(60_000);
    assert.equal(calls, 1);
    p.stop();
  });

  it("取得中に取り直しを押しても、同時に 2 つ取りに行かない", async () => {
    const c = new Clock();
    let calls = 0;
    let resolve!: () => void;
    const p = createPoller({ fetchOnce: () => (calls++, new Promise<void>((r) => (resolve = r))), intervalMs: 60_000, onResult: () => {}, now: c.now, setTimer: c.setTimer });
    p.start();
    await c.advance(0);
    p.refresh();
    p.refresh();
    await c.advance(0);
    assert.equal(calls, 1);
    resolve();
    p.stop();
  });

  it("地震の取得の間隔は、サーバーのため置き（60 秒）より長い", () => {
    assert.ok(QUAKE_POLL_MS >= QUAKE_CACHE_MS);
    assert.ok(sat.SAT_POLL_MS <= SAT_CACHE_MS);
  });
});

/* ---------- 5. 設定 ---------- */

describe("設定（EARTH と LOCAL FEED を混ぜない・古い設定でも壊れない）", () => {
  it("EARTH の設定：無い・壊れた値は既定、衛星の数は上限に収める", () => {
    assert.deepEqual(parseEarthSettings(null), DEFAULT_EARTH);
    assert.deepEqual(parseEarthSettings("x"), DEFAULT_EARTH);
    const s = parseEarthSettings({ quakes: false, sats: "yes", satGroup: "all", satLimit: 99999, autoRotate: false });
    assert.equal(s.quakes, false);
    assert.equal(s.sats, true);
    assert.equal(s.satGroup, "stations");
    assert.equal(s.satLimit, sat.SAT_LIMIT_MAX);
    assert.equal(parseEarthSettings({ satLimit: -3 }).satLimit, 1);
  });
  it("表示の設定に gevMode（EARTH / LOCAL FEED）を足しても、前の版の設定はそのまま読める", () => {
    const old = { hud: false, fade: 70, clean: true, feedShape: "circle" };
    const d = display.parseDisplay(old);
    assert.equal(d.gevMode, "earth");
    assert.equal(d.hud, false);
    assert.equal(d.feedShape, "circle");
    assert.equal(display.parseDisplay({ gevMode: "feed" }).gevMode, "feed");
    assert.equal(display.parseDisplay({ gevMode: "x" }).gevMode, "earth");
    for (const k of ["tactical", "cinematic", "minimal"] as const) assert.equal(display.applyPreset(k, { ...display.DEFAULT_DISPLAY, gevMode: "feed" }).gevMode, "feed");
  });
});

/* ---------- 6. 安全・アクセス制御 ---------- */

describe("安全とアクセス制御", () => {
  it("API はログインの内側（proxy.ts で /api/edith/earth を合言葉なしで通さない）", () => {
    const proxy = readFileSync(new URL("../src/proxy.ts", import.meta.url), "utf8");
    assert.doesNotMatch(proxy, /edith\/earth|\/api\/edith/);
    assert.match(proxy, /pathname\.startsWith\("\/api\/"\)/);
  });
  it("地球儀・地震・衛星のコードは秘密の値（環境変数）を使わない・外部の地図サービスや Cesium ion を使わない", () => {
    for (const f of ["src/integrations/earth/quakes.ts", "src/integrations/earth/satellites.ts", "src/lib/earth/quakes.ts", "src/lib/earth/satellites.ts", "src/lib/earth/poller.ts", "src/app/api/edith/earth/quakes/route.ts", "src/app/api/edith/earth/satellites/route.ts", "src/components/edith/EdithEarth.tsx"]) {
      const src = readFileSync(new URL(`../${f}`, import.meta.url), "utf8");
      assert.doesNotMatch(src, /process\.env/, f);
      assert.doesNotMatch(src, /defaultAccessToken\s*=\s*["'][^"']+|ion\.cesium\.com|api\.cesium\.com|bing|mapbox|googleapis|tile\.openstreetmap/i, f);
    }
  });
  it("取得先は USGS と CelesTrak だけ", () => {
    const q = readFileSync(new URL("../src/integrations/earth/quakes.ts", import.meta.url), "utf8");
    const s = readFileSync(new URL("../src/integrations/earth/satellites.ts", import.meta.url), "utf8");
    assert.match(q, /HOSTS = \["earthquake\.usgs\.gov"\]/);
    assert.match(s, /HOSTS = \["celestrak\.org"\]/);
  });
});

/* ---------- 定期取得：とても長い待ち時間・失敗の応答の受け渡し ---------- */

describe("定期取得：長い待ち時間（タイマーの上限）と失敗の応答", () => {
  it("相手の待ち時間が約 24.8 日を超えても（30 日）、区切って待ち、期限より前には取りに行かない", async () => {
    const c = new Clock();
    let calls = 0;
    let maxTimer = 0;
    const setTimer = (ms: number, fn: () => void) => ((maxTimer = Math.max(maxTimer, ms)), c.setTimer(ms, fn));
    const wait = 30 * 86_400_000;
    const p = createPoller({
      fetchOnce: async () => {
        calls++;
        throw new PollError("制限", wait);
      },
      intervalMs: 60 * 60_000,
      onResult: () => {},
      now: c.now,
      setTimer,
    });
    p.start();
    await c.advance(0);
    assert.equal(calls, 1);
    await c.advance(wait - 1);
    assert.equal(calls, 1, "30 日たつまでは取りに行かない");
    assert.ok(maxTimer <= MAX_TIMER_MS && maxTimer < 2 ** 31 - 1, `タイマー 1 回の長さ ${maxTimer}`);
    await c.advance(1);
    assert.equal(calls, 2);
    p.stop();
  });

  it("24 時間以内の待ち時間は、これまでどおりタイマー 1 回（地震などの動きは変わらない）", async () => {
    const c = new Clock();
    const lens: number[] = [];
    const p = createPoller({ fetchOnce: async () => 1, intervalMs: 120_000, onResult: () => {}, now: c.now, setTimer: (ms, fn) => (lens.push(ms), c.setTimer(ms, fn)) });
    p.start();
    await c.advance(240_000);
    p.stop();
    assert.deepEqual(lens, [120_000, 120_000, 120_000]);
  });

  it("失敗の応答（確かめたもの）と待ち時間を、結果に添える", async () => {
    const c = new Clock();
    const got: unknown[] = [];
    const payload = { ok: false, error: "e", reason: "halted" };
    const p = createPoller({ fetchOnce: async () => Promise.reject(new PollError("e", 5000, payload)), intervalMs: 60_000, onResult: (r) => got.push(r), now: c.now, setTimer: c.setTimer });
    p.start();
    await c.advance(0);
    p.stop();
    assert.deepEqual(got[0], { ok: false, error: "e", at: NOW, retryAfterMs: 5000, payload });
  });
});

/* ---------- 人工衛星：同時に来た要求（見本の応答・外部通信なし） ---------- */

describe("人工衛星：同時に来た要求（外への取得を重ねない・止めた状態を戻さない）", () => {
  beforeEach(() => resetSatelliteCache());
  const H2 = 3_600_000;
  const okText = () => JSON.stringify([ommAt(25544, "ISS (ZARYA)", "2026-10-12T01:00:00")]);
  /** 遅れて返る偽の fetch（グループごとに応答と遅さを決める） */
  function delayFetch(plan: (url: string, n: number) => { ms: number; status?: number; throws?: string; body?: string }) {
    const calls: string[] = [];
    const fn = (url: string) => {
      calls.push(url);
      const p = plan(url, calls.length);
      return new Promise<Response>((resolve, reject) =>
        setTimeout(() => (p.throws ? reject(Object.assign(new Error(p.throws), { name: p.throws })) : resolve(new Response(p.status && p.status !== 200 ? "x" : (p.body ?? okText()), { status: p.status ?? 200 }))), p.ms),
      );
    };
    return { fn, calls };
  }
  const go = (group: "stations" | "visual" | "weather" | "gnss", now: number, f: { fn: unknown }) => getSatellites(group, { now, fetchImpl: f.fn as never, log: quiet });

  it("A. 同じグループへの同時の要求 → 外への取得は 1 回だけ。結果は共有する", async () => {
    const f = delayFetch(() => ({ ms: 20 }));
    const rs = await Promise.all([go("stations", NOW, f), go("stations", NOW, f), go("stations", NOW, f)]);
    assert.equal(f.calls.length, 1);
    assert.ok(rs.every((r) => r.res.ok));
    assert.equal(rs[0].res, rs[1].res);
  });

  it("B. 全体を止めた後は、異なるグループの同時の要求でも外へ取りに行かない", async () => {
    const f = delayFetch(() => ({ ms: 5, status: 403 }));
    await go("stations", NOW, f);
    const rs = await Promise.all([go("visual", NOW + 1, f), go("weather", NOW + 1, f), go("gnss", NOW + 1, f), go("stations", NOW + 10 * H2, f)]);
    assert.equal(f.calls.length, 1, "止めた後の新しい取得は始めない");
    for (const r of rs) {
      assert.equal(r.res.ok, false);
      if (!r.res.ok) assert.equal(r.res.reason, "halted");
    }
  });

  it("C. 403 で止めた後に届いた「止める前に出した取得」の成功は、止めた状態を解除しない（データ・取得時刻は残す）", async () => {
    const f = delayFetch((url) => (url.includes("GROUP=visual") ? { ms: 50 } : { ms: 5, status: 403 }));
    const [a, b] = await Promise.all([go("stations", NOW, f), go("visual", NOW, f)]);
    assert.equal(a.res.ok, false);
    assert.equal(b.res.ok, true, "取れたデータそのものは本物なので返す");
    const w = await go("weather", NOW + 3 * H2, f);
    assert.equal(f.calls.length, 2, "止めた状態のまま。weather は取りに行かない");
    assert.equal(w.res.ok, false);
    if (!w.res.ok) assert.equal(w.res.reason, "halted");
    // 遅れて取れた visual のデータは、その時の取得時刻のまま残る（2 時間はそのまま返す）
    const v = await go("visual", NOW + H2, f);
    assert.equal(v.res.ok, true);
    if (v.res.ok) assert.equal(v.res.fetchedAt, new Date(NOW).toISOString());
  });

  it("C'. 止めた後に届いた「止める前に出した取得」の一時的な失敗は、止めた状態を弱めない", async () => {
    const f = delayFetch((url) => (url.includes("GROUP=visual") ? { ms: 40, throws: "TypeError" } : { ms: 5, status: 403 }));
    await Promise.all([go("stations", NOW, f), go("visual", NOW, f)]);
    const r = await go("weather", NOW + 30 * 86_400_000, f);
    assert.equal(f.calls.length, 2);
    assert.equal(r.res.ok, false);
    if (!r.res.ok) {
      assert.equal(r.res.reason, "halted");
      assert.equal(r.res.retryAt, null);
    }
  });

  it("D. 長期停止の後の確かめは、複数のグループから同時に来ても全体で 1 回だけ（失敗なら全部止まったまま）", async () => {
    const f = delayFetch(() => ({ ms: 5, status: 503 }));
    let t = NOW;
    for (let i = 0; i < 5; i++) {
      const r = await go("stations", t, f);
      if (!r.res.ok) t = Date.parse(r.res.retryAt!);
    }
    assert.equal(f.calls.length, 5);
    const rs = await Promise.all([go("stations", t, f), go("visual", t, f), go("weather", t, f), go("gnss", t, f)]);
    assert.equal(f.calls.length, 6, "全体で 1 回だけ");
    for (const r of rs) {
      assert.equal(r.res.ok, false);
      if (!r.res.ok) assert.equal(r.res.reason, "long-stop");
    }
  });

  it("D'. 長期停止の後の確かめが成功したら、待っていた他のグループはふだんどおり取りに行く", async () => {
    let healthy = false;
    const f = delayFetch(() => (healthy ? { ms: 10 } : { ms: 5, status: 503 }));
    let t = NOW;
    for (let i = 0; i < 5; i++) {
      const r = await go("stations", t, f);
      if (!r.res.ok) t = Date.parse(r.res.retryAt!);
    }
    healthy = true;
    const rs = await Promise.all([go("stations", t, f), go("visual", t, f), go("weather", t, f)]);
    assert.ok(rs.every((r) => r.res.ok));
    assert.equal(f.calls.length, 5 + 3, "確かめ 1 回 → 成功の後に残りの 2 グループ");
  });

  it("D''. 一時的な失敗の待ち時間が過ぎた後も、同時の要求で外へ行くのは 1 回だけ", async () => {
    const f = delayFetch(() => ({ ms: 5, status: 500 }));
    const first = await go("stations", NOW, f);
    const t = first.res.ok ? NOW : Date.parse(first.res.retryAt!);
    await Promise.all([go("stations", t, f), go("visual", t, f), go("weather", t, f)]);
    assert.equal(f.calls.length, 2);
  });

  it("E. 同時の要求でも、グループだけの停止と全体の停止は混ざらない", async () => {
    const f = delayFetch((url) => (url.includes("GROUP=weather") ? { ms: 5, body: "not json" } : { ms: 10 }));
    const rs = await Promise.all([go("weather", NOW, f), go("stations", NOW, f), go("visual", NOW, f)]);
    assert.equal(rs[0].res.ok, false);
    if (!rs[0].res.ok) assert.equal(rs[0].res.scope, "group");
    assert.ok(rs[1].res.ok && rs[2].res.ok);
    const later = await go("gnss", NOW + 1, f);
    assert.equal(later.res.ok, true, "全体は止まっていない");
  });
});

/* ---------- 人工衛星：画面側の STALE・保存と復元（見本データ・外部通信なし） ---------- */

const ue = await import("../src/components/edith/useEarthData");

describe("人工衛星：失敗の応答・保存から出したデータは必ず STALE", () => {
  const T = Date.parse("2026-10-12T12:00:00Z");
  it("restoredStatus：LIVE・NO DATA は STALE に。ほかはそのまま", () => {
    assert.equal(ue.restoredStatus("LIVE"), "STALE");
    assert.equal(ue.restoredStatus("NO DATA"), "STALE");
    for (const s of ["STALE", "ERROR", "OFFLINE", "LOADING"] as const) assert.equal(ue.restoredStatus(s), s);
  });
  it("端末の時計が進んでいても遅れていても、最後のデータは LIVE にならない", () => {
    const okAt = T - 3 * 3_600_000;
    for (const skewH of [-48, -4, -2, 0, 3, 48]) {
      const clientNow = T + skewH * 3_600_000;
      for (const withError of [true, false]) {
        const base = layerStatus({ ...EMPTY_FETCH, lastOkAt: okAt, lastCount: 2, lastError: withError ? "x" : null, lastErrorAt: withError ? clientNow : null }, { now: clientNow, online: true, staleAfterMs: sat.SAT_STALE_MS });
        assert.notEqual(ue.restoredStatus(base), "LIVE", `skew ${skewH}h`);
      }
    }
  });
  it("実際に取れた応答の判定は変わらない（LIVE のまま）", () => {
    assert.equal(layerStatus({ ...EMPTY_FETCH, lastOkAt: T, lastCount: 2 }, { now: T + 1000, online: true, staleAfterMs: sat.SAT_STALE_MS }), "LIVE");
  });
});

describe("人工衛星：正常に取れた最後のデータの保存と復元（端末の中だけ）", () => {
  const T = Date.parse("2026-10-12T12:00:00Z");
  const okData = (n = 3, fetchedAt = new Date(T - 2 * 3_600_000).toISOString()) => {
    const r = sat.parseSatellitesResponse({ ok: true, group: "stations", fetchedAt, elements: Array.from({ length: n }, (_, i) => ({ omm: ommAt(30000 + i, `SAT ${i}`, "2026-10-12T01:00:00") })) });
    assert.ok(r && r.ok);
    return r as Extract<NonNullable<typeof r>, { ok: true }>;
  };
  class Mem {
    m = new Map<string, string>();
    gets = 0;
    getItem(k: string) {
      this.gets++;
      return this.m.get(k) ?? null;
    }
    setItem(k: string, v: string) {
      this.m.set(k, v);
    }
    removeItem(k: string) {
      this.m.delete(k);
    }
  }

  it("A・B. 保存して復元できる。取得時刻は元のまま（いまの時刻に書き換えない）", () => {
    const st = new Mem();
    const d = okData();
    ue.writeSavedSats(st, d);
    const back = ue.readSavedSats(st, "stations", T + 5 * 3_600_000);
    assert.ok(back);
    assert.equal(back!.fetchedAt, d.fetchedAt);
    assert.equal(back!.elements.length, 3);
    assert.deepEqual(back!.elements[0].omm, d.elements[0].omm);
    // 復元したデータの状態は STALE（時計がずれていても）
    for (const skew of [-10, 0, 10]) {
      const now = T + skew * 3_600_000;
      const base = layerStatus({ ...EMPTY_FETCH, lastOkAt: Date.parse(back!.fetchedAt), lastCount: back!.elements.length }, { now, online: true, staleAfterMs: sat.SAT_STALE_MS });
      assert.equal(ue.restoredStatus(base), "STALE", `skew ${skew}h`);
    }
  });

  it("保存は表示に必要な項目だけ・最大 150 機・大きさの上限つき。0 件は保存しない（同じグループの古い保存は消す）", () => {
    const st = new Mem();
    ue.writeSavedSats(st, okData(200));
    const raw = st.m.get(ue.SAT_LAST_KEY)!;
    assert.ok(raw.length <= ue.SAT_SAVED_MAX_CHARS);
    const parsed = JSON.parse(raw);
    assert.equal(parsed.data.elements.length, ue.SAT_SAVED_MAX_ELEMENTS);
    assert.deepEqual(Object.keys(parsed.data.elements[0]).sort(), ["epoch", "id", "intlId", "name", "omm"]);
    assert.doesNotMatch(raw, /passcode|token|cookie|secret/i);
    ue.writeSavedSats(st, okData(0));
    assert.equal(st.m.has(ue.SAT_LAST_KEY), false);
  });

  it("別のグループ・7 日より古い・未来すぎる保存は使わない", () => {
    const st = new Mem();
    ue.writeSavedSats(st, okData(2, new Date(T).toISOString()));
    assert.equal(ue.readSavedSats(st, "visual", T), null);
    assert.equal(ue.readSavedSats(st, "stations", T + ue.SAT_SAVED_MAX_AGE_MS + 1), null);
    assert.equal(ue.readSavedSats(st, "stations", T - ue.SAT_SAVED_MAX_AGE_MS - 1), null);
    assert.ok(ue.readSavedSats(st, "stations", T + ue.SAT_SAVED_MAX_AGE_MS - 1));
  });

  it("D. 壊れた保存（JSON でない・形が違う・衛星が不正・版が違う・大きすぎる）は無視し、例外を出さない", () => {
    const bad = [
      "{not json",
      "null",
      JSON.stringify({ v: 2, data: okData() }),
      JSON.stringify({ v: 1, data: { ok: true, group: "stations", fetchedAt: "x", elements: [] } }),
      JSON.stringify({ v: 1, data: { ok: true, group: "stations", fetchedAt: new Date(T).toISOString(), elements: [{ omm: { bad: 1 } }] } }),
      JSON.stringify({ v: 1, data: { ok: false, error: "x" } }),
      "x".repeat(ue.SAT_SAVED_MAX_CHARS + 1),
    ];
    for (const raw of bad) {
      const st = new Mem();
      st.m.set(ue.SAT_LAST_KEY, raw);
      assert.equal(ue.readSavedSats(st, "stations", T), null, raw.slice(0, 40));
    }
  });

  it("E. 保存の読み書きが失敗しても例外を出さない（停止の記録とは別のキー）", () => {
    const broken = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("quota");
      },
      removeItem: () => {
        throw new Error("denied");
      },
    };
    assert.equal(ue.readSavedSats(broken, "stations", T), null);
    assert.doesNotThrow(() => ue.writeSavedSats(broken, okData()));
    assert.equal(ue.readSavedSats(null, "stations", T), null);
    assert.notEqual(ue.SAT_LAST_KEY, sat.SAT_HOLD_KEY);
  });

  it("F. 復元は端末の保存を読むだけ（外への通信をしない）", () => {
    const st = new Mem();
    ue.writeSavedSats(st, okData());
    const origFetch = globalThis.fetch;
    let fetched = 0;
    globalThis.fetch = (async () => (fetched++, new Response("[]"))) as typeof fetch;
    try {
      assert.ok(ue.readSavedSats(st, "stations", T));
    } finally {
      globalThis.fetch = origFetch;
    }
    assert.equal(fetched, 0);
    assert.equal(st.gets, 1);
  });
});

/* ---------- 人工衛星：確かめがグループだけの失敗で終わったとき（見本の応答・外部通信なし） ---------- */

describe("人工衛星：全体の失敗の後の確かめが、グループだけの失敗で終わったとき", () => {
  beforeEach(() => resetSatelliteCache());
  const okText = () => JSON.stringify([ommAt(25544, "ISS (ZARYA)", "2026-10-12T01:00:00")]);
  /** 段階ごとに応答を決める偽の fetch（呼ばれたグループを順に記録する） */
  function phased() {
    const calls: string[] = [];
    let probeReply: { status?: number; body?: string } = {};
    let phase: "warm" | "probe" = "warm";
    const fn = (url: string) => {
      const group = url.match(/GROUP=(\w+)/)![1];
      calls.push(group);
      const r = phase === "warm" ? (group === "weather" ? {} : { status: 500 }) : probeReply;
      return new Promise<Response>((resolve) => setTimeout(() => resolve(new Response(r.status ? "x" : (r.body ?? okText()), { status: r.status ?? 200 })), phase === "warm" ? 1 : 15));
    };
    return {
      fn,
      calls,
      probe(reply: { status?: number; body?: string }) {
        phase = "probe";
        probeReply = reply;
      },
    };
  }
  const go = (group: "stations" | "visual" | "weather" | "gnss", now: number, f: { fn: unknown }) => getSatellites(group, { now, fetchImpl: f.fn as never, log: quiet });

  /** weather の成功 → stations の 500 で全体が一時的な失敗 → 期限後に stations・visual・gnss を同時に */
  async function scenario(reply: { status?: number; body?: string }) {
    const f = phased();
    assert.equal((await go("weather", NOW, f)).res.ok, true, "weather の成功（404 をグループだけの問題とみなす根拠）");
    const first = await go("stations", NOW + 1, f);
    assert.equal(first.res.ok, false);
    const retryAt = first.res.ok ? "" : first.res.retryAt!;
    assert.equal(first.res.ok ? null : first.res.reason, "temporary");
    const t = Date.parse(retryAt);
    f.probe(reply);
    const before = f.calls.length;
    const [st, vi, gn] = await Promise.all([go("stations", t, f), go("visual", t, f), go("gnss", t, f)]);
    return { f, before, retryAt, st, vi, gn };
  }

  for (const [label, reply] of [
    ["404", { status: 404 }],
    ["データの形の異常（JSON でない）", { body: "<html>blocked</html>" }],
  ] as const) {
    it(`確かめが ${label} で終わった → 外への取得は全体で 1 回。visual・gnss は続けて取りに行かず、全体の理由と次の確認時刻を受け取る`, async () => {
      const { f, before, retryAt, st, vi, gn } = await scenario(reply);
      assert.deepEqual(f.calls.slice(before), ["stations"], "確かめの 1 回だけ（visual・gnss は外へ行かない）");
      // 確かめたグループは、グループだけの停止
      assert.equal(st.res.ok, false);
      if (!st.res.ok) {
        assert.equal(st.res.reason, "halted");
        assert.equal(st.res.scope, "group");
      }
      // 相乗りした要求：全体のいまの理由（一時的な失敗）と、既存の次の確認時刻（変えない・短縮しない）
      for (const r of [vi, gn]) {
        assert.equal(r.res.ok, false);
        if (!r.res.ok) {
          assert.equal(r.res.reason, "temporary");
          assert.equal(r.res.scope, "all");
          assert.equal(r.res.retryAt, retryAt, "次の確認時刻は全体の予定のまま");
        }
        assert.ok((r.retryAfterSec ?? 0) >= 1);
        assert.equal(r.cached, true, "外へは行っていない");
      }
    });
  }

  it("確かめが成功した → ほかのグループはふだんどおり取りに行く（既存の動き）", async () => {
    const { f, before, st, vi, gn } = await scenario({});
    assert.ok(st.res.ok && vi.res.ok && gn.res.ok);
    assert.equal(f.calls[before], "stations", "最初の 1 回が確かめ");
    assert.deepEqual(f.calls.slice(before).sort(), ["gnss", "stations", "visual"], "成功の後に visual・gnss が 1 回ずつ");
  });
});

/* ---------- 地球の画像・リアルタイムの重ね合わせ・ライブ映像（外部通信なし） ---------- */

const imagery = await import("../src/lib/earth/imagery");

describe("地球の画像・雨雲レーダー・ライブ映像の定義", () => {
  it("使う外部のホストは決めたものだけ（https・API キーなし）", () => {
    const urls = [imagery.S2_URL, imagery.gibsUrl("2026-10-11"), imagery.RAINVIEWER_MAPS_URL, imagery.ISS_LIVE_EMBED];
    for (const u of urls) {
      const url = new URL(u.replace(/\{[a-z]\}/g, "0"));
      assert.equal(url.protocol, "https:");
      assert.ok((imagery.IMAGERY_HOSTS as readonly string[]).includes(url.hostname), url.hostname);
      assert.doesNotMatch(u, /key=|token=|access_token|apikey/i);
    }
    const src = readFileSync(new URL("../src/lib/earth/imagery.ts", import.meta.url), "utf8");
    assert.doesNotMatch(src, /process\.env|ion\.cesium\.com|api\.cesium\.com|bing|mapbox|googleapis/i);
  });

  it("今日の地球は UTC の前日の画像。日付の形が違えば作らない", () => {
    assert.equal(imagery.gibsDate(Date.parse("2026-10-12T00:30:00Z")), "2026-10-11");
    assert.equal(imagery.gibsDate(Date.parse("2026-10-12T23:59:00Z")), "2026-10-11");
    assert.match(imagery.gibsUrl("2026-10-11"), /MODIS_Terra_CorrectedReflectance_TrueColor\/default\/2026-10-11\/GoogleMapsCompatible_Level9\/\{z\}\/\{y\}\/\{x\}\.jpg$/);
    assert.throws(() => imagery.gibsUrl("2026/10/11"));
    assert.throws(() => imagery.gibsUrl("../x"));
  });

  it("雨雲レーダー：いちばん新しい観測の画像を使う。決まったホスト・形のものだけ", () => {
    const ok = imagery.parseRainViewer({ host: "https://tilecache.rainviewer.com", radar: { past: [{ time: 1_791_800_000, path: "/v2/radar/aaa111" }, { time: 1_791_800_600, path: "/v2/radar/bbb222" }], nowcast: [{ time: 1_791_801_200, path: "/v2/radar/ccc333" }] } });
    assert.ok(ok);
    assert.equal(ok!.url, "https://tilecache.rainviewer.com/v2/radar/bbb222/256/{z}/{x}/{y}/2/1_1.png");
    assert.equal(ok!.time, new Date(1_791_800_600 * 1000).toISOString());
    // ほかのホスト・おかしな path・空 → 使わない
    assert.equal(imagery.parseRainViewer({ host: "https://evil.example", radar: { past: [{ time: 1, path: "/v2/radar/a" }] } }), null);
    assert.equal(imagery.parseRainViewer({ host: "https://tilecache.rainviewer.com", radar: { past: [{ time: 1, path: "/../../x" }, { time: 2, path: "https://evil/x" }] } }), null);
    assert.equal(imagery.parseRainViewer({ host: "https://tilecache.rainviewer.com", radar: { past: [] } }), null);
    assert.equal(imagery.parseRainViewer(null), null);
    const r = imagery.parseRadarResponse({ host: "x" });
    assert.ok(r && !r.ok);
  });

  it("国際宇宙ステーションの名前を見分ける（ライブ映像のボタンを出す）", () => {
    assert.equal(imagery.isIssName("ISS (ZARYA)"), true);
    assert.equal(imagery.isIssName("ISS (NAUKA)"), true);
    assert.equal(imagery.isIssName("CSS (TIANHE)"), false);
    assert.equal(imagery.isIssName("MISSION X"), false);
  });

  it("クレジットにはリンクが付く（EOX・RainViewer は必須）", () => {
    for (const c of [imagery.S2_CREDIT, imagery.GIBS_CREDIT, imagery.RADAR_CREDIT]) {
      assert.ok(c.text.length > 5);
      assert.ok(c.links.length >= 1 && c.links.every((l) => l.href.startsWith("https://")));
    }
    assert.match(imagery.S2_CREDIT.text, /Sentinel-2 cloudless.*EOX IT Services GmbH.*Copernicus Sentinel data/);
    assert.ok(imagery.S2_CREDIT.links.some((l) => l.href === "https://s2maps.eu"));
    assert.ok(imagery.RADAR_CREDIT.links.some((l) => l.href.includes("rainviewer.com")));
  });

  it("設定：詳細な衛星写真は既定で ON、今日の地球・雨雲レーダーは OFF。古い保存（項目なし）も読める", () => {
    assert.equal(DEFAULT_EARTH.detail, true);
    assert.equal(DEFAULT_EARTH.clouds, false);
    assert.equal(DEFAULT_EARTH.radar, false);
    const old = parseEarthSettings({ quakes: false, sats: true, satGroup: "gnss", satLimit: 20, autoRotate: false });
    assert.equal(old.quakes, false);
    assert.equal(old.detail, true);
    assert.equal(old.radar, false);
    const set = parseEarthSettings({ detail: false, clouds: true, radar: true });
    assert.deepEqual([set.detail, set.clouds, set.radar], [false, true, true]);
    assert.equal(parseEarthSettings({ detail: "yes" }).detail, true);
  });
});

/* ---------- 飛行機（OpenSky）・外部サービスの設定（見本の応答・外部通信なし） ---------- */

const air = await import("../src/lib/earth/aircraft");
const airSrv = await import("../src/integrations/earth/aircraft");

const openskyBody = (t: number) => ({
  time: t,
  states: [
    ["86d5a1", "JAL123  ", "Japan", t - 5, t - 4, 139.8, 35.6, 3000.5, false, 200, 90, 5.2, null, 3050, "1234", false, 0],
    ["86d5a2", "ANA9    ", "Japan", t - 8, t - 6, 139.9, 35.7, null, false, 150, 180, -3, null, 2000, null, false, 0],
    ["86d5a3", "GND1", "Japan", t - 2, t - 2, 139.7, 35.5, 0, true, 5, 0, 0, null, 0, null, false, 0],
    ["zzzzzz", "BAD", "X", t, t, 1, 1, 1, false, 1, 1, 1, null, 1, null, false, 0],
    ["86d5a4", "NOPOS", "Japan", t, t, null, null, 1, false, 1, 1, 1, null, 1, null, false, 0],
  ],
});

describe("飛行機：OpenSky の読み取り・範囲・推定位置", () => {
  it("空を飛んでいて位置のあるものだけ。気圧高度が無ければ幾何高度", () => {
    const t = Math.floor(NOW / 1000);
    const list = air.parseOpenSky(openskyBody(t));
    assert.deepEqual(list.map((a) => a.icao24), ["86d5a1", "86d5a2"]);
    assert.equal(list[0].callsign, "JAL123");
    assert.equal(list[0].altM, 3000.5);
    assert.equal(list[1].altM, 2000);
    assert.equal(list[0].reportedAt, new Date((t - 5) * 1000).toISOString());
    assert.deepEqual(air.parseOpenSky({ time: t, states: null }), []);
    assert.throws(() => air.parseOpenSky({ states: [] }));
  });
  it("範囲：0.5 度刻みに広げる・正しくない範囲は使わない・広さ", () => {
    assert.deepEqual(air.roundBBox({ lamin: 35.31, lomin: 139.26, lamax: 35.92, lomax: 140.01 }), { lamin: 35, lomin: 139, lamax: 36, lomax: 140.5 });
    assert.equal(air.parseBBoxQuery("35,139,36,140")?.lamax, 36);
    for (const q of ["", "1,2,3", "36,139,35,140", "a,b,c,d", "-91,0,0,1", "0,-181,1,0"]) assert.equal(air.parseBBoxQuery(q), null, q);
    assert.equal(air.bboxArea({ lamin: 30, lomin: 130, lamax: 40, lomax: 140 }), 100);
  });
  it("報告の後の推定：東へ 200 m/s で 10 秒 → 約 2 km 東。最大の時間を過ぎたら止める", () => {
    const a = { icao24: "86d5a1", callsign: "X", country: null, lat: 0, lon: 0, altM: 1000, speedMs: 200, heading: 90, verticalMs: 0, reportedAt: new Date(NOW).toISOString() };
    const p10 = air.aircraftPositionAt(a, NOW + 10_000);
    assert.ok(p10.estimated);
    assert.ok(Math.abs(p10.lon - 2000 / 111_195) < 1e-4 && Math.abs(p10.lat) < 1e-6, JSON.stringify(p10));
    const far = air.aircraftPositionAt(a, NOW + 10 * 60_000);
    const cap = air.aircraftPositionAt(a, NOW + air.AIRCRAFT_EXTRAPOLATE_MAX_MS);
    assert.ok(Math.abs(far.lon - cap.lon) < 1e-9, "最大の時間で止まる");
    assert.equal(air.aircraftPositionAt({ ...a, speedMs: null }, NOW + 10_000).estimated, false);
  });
  it("画面側の確認：応答の形を確かめ直す", () => {
    const ok = air.parseAircraftResponse({ ok: true, fetchedAt: new Date(NOW).toISOString(), bbox: { lamin: 35, lomin: 139, lamax: 36, lomax: 140 }, items: [{ icao24: "86d5a1", lat: 35.6, lon: 139.8, reportedAt: "2026-10-12T06:00:00Z" }, { icao24: "BAD!", lat: 1, lon: 1, reportedAt: "x" }] });
    assert.ok(ok && ok.ok && ok.items.length === 1);
    assert.equal(air.parseAircraftResponse({ ok: true, fetchedAt: "x", bbox: { lamin: 2, lomin: 0, lamax: 1, lomax: 1 }, items: [] }), null);
  });
});

describe("飛行機：サーバーでの取得（OpenSky）", () => {
  beforeEach(() => airSrv.resetAircraftCache());
  const box = { lamin: 35.2, lomin: 139.3, lamax: 35.9, lomax: 140.1 };
  /** 偽の fetch（呼ばれた URL・ヘッダを記録） */
  function osFetch(reply: (url: string, init?: RequestInit) => { status?: number; body?: unknown; headers?: Record<string, string> }) {
    const calls: { url: string; auth: string | null; method: string }[] = [];
    const fn = async (url: string, init?: RequestInit) => {
      calls.push({ url, auth: new Headers(init?.headers).get("authorization"), method: init?.method ?? "GET" });
      const r = reply(url, init);
      return new Response(typeof r.body === "string" ? r.body : JSON.stringify(r.body ?? {}), { status: r.status ?? 200, headers: r.headers ?? {} });
    };
    return { fn, calls };
  }
  const t = Math.floor(NOW / 1000);

  it("匿名：0.5 度刻みの範囲で取りに行き、120 秒はためた結果を返す", async () => {
    const f = osFetch(() => ({ body: openskyBody(t) }));
    const r = await airSrv.getAircraft(box, { now: NOW, fetchImpl: f.fn as never, env: {} });
    assert.ok(r.res.ok && r.res.items.length === 2);
    assert.equal(f.calls[0].url, "https://opensky-network.org/api/states/all?lamin=35&lomin=139&lamax=36&lomax=140.5");
    assert.equal(f.calls[0].auth, null);
    await airSrv.getAircraft(box, { now: NOW + airSrv.AIRCRAFT_CACHE_ANON_MS - 1, fetchImpl: f.fn as never, env: {} });
    assert.equal(f.calls.length, 1);
    await airSrv.getAircraft(box, { now: NOW + airSrv.AIRCRAFT_CACHE_ANON_MS, fetchImpl: f.fn as never, env: {} });
    assert.equal(f.calls.length, 2);
  });

  it("認証あり：トークンを取り（POST）、Bearer で取りに行く。トークンは使い回す。秘密の値は応答に入れない", async () => {
    const f = osFetch((url) => (url.includes("/token") ? { body: { access_token: "tok-abc", expires_in: 1800 } } : { body: openskyBody(t) }));
    const env = { OPENSKY_CLIENT_ID: "my-id", OPENSKY_CLIENT_SECRET: "my-secret" };
    const r = await airSrv.getAircraft(box, { now: NOW, fetchImpl: f.fn as never, env });
    assert.ok(r.res.ok);
    assert.equal(f.calls[0].method, "POST");
    assert.match(f.calls[0].url, /auth\.opensky-network\.org/);
    assert.equal(f.calls[1].auth, "Bearer tok-abc");
    await airSrv.getAircraft({ ...box, lamin: 33 }, { now: NOW + 1000, fetchImpl: f.fn as never, env });
    assert.equal(f.calls.filter((c) => c.url.includes("/token")).length, 1, "トークンは使い回す");
    assert.doesNotMatch(JSON.stringify(r.res), /tok-abc|my-secret|my-id/);
  });

  it("429：相手の待ち時間（X-Rate-Limit-Retry-After-Seconds）より前には取りに行かない", async () => {
    const f = osFetch(() => ({ status: 429, headers: { "X-Rate-Limit-Retry-After-Seconds": "3600" } }));
    const r = await airSrv.getAircraft(box, { now: NOW, fetchImpl: f.fn as never, env: {} });
    assert.equal(r.res.ok, false);
    assert.equal(r.retryAfterSec, 3600);
    await airSrv.getAircraft({ ...box, lamin: 30 }, { now: NOW + 3600_000 - 1, fetchImpl: f.fn as never, env: {} });
    assert.equal(f.calls.length, 1, "別の範囲でも待つ");
  });

  it("広すぎる範囲は取りに行かない。形の違う応答・接続の失敗は作ったデータを返さない", async () => {
    const f = osFetch(() => ({ body: openskyBody(t) }));
    const wide = await airSrv.getAircraft({ lamin: 0, lomin: 100, lamax: 30, lomax: 150 }, { now: NOW, fetchImpl: f.fn as never, env: {} });
    assert.equal(wide.res.ok, false);
    assert.equal(f.calls.length, 0);
    const bad = await airSrv.getAircraft(box, { now: NOW, fetchImpl: osFetch(() => ({ body: { nope: 1 } })).fn as never, env: {} });
    assert.equal(bad.res.ok, false);
    airSrv.resetAircraftCache();
    const net = await airSrv.getAircraft(box, { now: NOW, fetchImpl: (async () => { throw new TypeError("x"); }) as never, env: {} });
    assert.equal(net.res.ok, false);
  });

  it("API：範囲がおかしい・広すぎる → 400", async () => {
    const { GET } = await import("../src/app/api/edith/earth/aircraft/route");
    assert.equal((await GET(new Request("http://localhost/api/edith/earth/aircraft?bbox=1,2"))).status, 400);
    assert.equal((await GET(new Request("http://localhost/api/edith/earth/aircraft?bbox=0,100,30,150"))).status, 400);
  });
});

describe("外部サービスの設定（/api/edith/earth/config）", () => {
  it("Google のキーだけ画面に渡す。ほかのキーは有無だけ", async () => {
    const keep = { ...process.env };
    try {
      process.env.GOOGLE_MAPS_API_KEY = "AIzaTESTKEY0123456789abcdef";
      process.env.TOMTOM_API_KEY = "tomtom-secret-value";
      process.env.ODPT_CONSUMER_KEY = "odpt-secret-value";
      process.env.AISSTREAM_API_KEY = "ais-secret-value";
      process.env.OPENSKY_CLIENT_ID = "osid";
      process.env.OPENSKY_CLIENT_SECRET = "ossecret";
      const { GET } = await import("../src/app/api/edith/earth/config/route");
      const body = await (await GET()).json();
      assert.equal(body.google3dKey, "AIzaTESTKEY0123456789abcdef");
      assert.deepEqual(body.services, { opensky: "auth", tomtom: true, odpt: true, ais: true });
      assert.doesNotMatch(JSON.stringify(body), /tomtom-secret|odpt-secret|ais-secret|ossecret|osid/);
      delete process.env.GOOGLE_MAPS_API_KEY;
      delete process.env.TOMTOM_API_KEY;
      const b2 = await (await GET()).json();
      assert.equal(b2.google3dKey, null);
      assert.equal(b2.services.tomtom, false);
    } finally {
      for (const k of ["GOOGLE_MAPS_API_KEY", "TOMTOM_API_KEY", "ODPT_CONSUMER_KEY", "AISSTREAM_API_KEY", "OPENSKY_CLIENT_ID", "OPENSKY_CLIENT_SECRET"]) {
        if (keep[k] === undefined) delete process.env[k];
        else process.env[k] = keep[k];
      }
    }
  });
  it("画面側の確認：おかしなキーは使わない", () => {
    assert.equal(ue.parseEarthConfig({ google3dKey: "<script>", services: {} })?.google3dKey, null);
    assert.equal(ue.parseEarthConfig({ google3dKey: "AIzaTESTKEY0123456789abcdef", services: { opensky: "auth" } })?.services.opensky, "auth");
    assert.equal(ue.parseEarthConfig(null), null);
  });
  it("設定：3D の街・飛行機は既定で ON（キーが無ければ 3D の街は出さない）", () => {
    assert.equal(DEFAULT_EARTH.city3d, true);
    assert.equal(DEFAULT_EARTH.aircraft, true);
    assert.equal(parseEarthSettings({}).aircraft, true);
    assert.equal(parseEarthSettings({ city3d: false }).city3d, false);
  });
});

/* ---------- 渋滞・都営バス・船（見本の応答・外部通信なし） ---------- */

const tr = await import("../src/lib/earth/transport");
const busSrv = await import("../src/integrations/earth/buses");
const shipSrv = await import("../src/integrations/earth/ships");

const odptBus = (id: string, lat: unknown, lon: unknown, extra: Record<string, unknown> = {}) => ({ "@type": "odpt:Bus", "owl:sameAs": `odpt.Bus:Toei.To01.${id}`, "dc:date": "2026-10-12T15:00:00+09:00", "odpt:busNumber": `N${id}`, "odpt:busroute": "odpt.Busroute:Toei.To01", "geo:lat": lat, "geo:long": lon, "odpt:azimuth": 90, ...extra });
const aisMsg = (mmsi: number, lat: number, lon: number, name = "TEST MARU@@@") => ({ MessageType: "PositionReport", MetaData: { MMSI: mmsi, ShipName: name, latitude: lat, longitude: lon, time_utc: "2026-10-12 06:00:00.123456789 +0000 UTC" }, Message: { PositionReport: { Latitude: lat, Longitude: lon, Sog: 12.3, Cog: 45, TrueHeading: 511, UserID: mmsi } } });

describe("都営バス（ODPT）", () => {
  beforeEach(() => busSrv.resetBusCache());
  it("位置のあるものだけ読む。系統は最後の部分（To01）", () => {
    const list = tr.parseOdptBuses([odptBus("1", 35.68, 139.76), odptBus("2", null, 139.7), odptBus("3", "35.7", "139.8"), "junk"]);
    assert.equal(list.length, 2);
    assert.equal(list[0].route, "To01");
    assert.equal(list[0].number, "N1");
    assert.equal(list[0].reportedAt, "2026-10-12T06:00:00.000Z");
    assert.equal(list[1].lat, 35.7);
    assert.throws(() => tr.parseOdptBuses({}));
  });
  it("キー未設定なら取りに行かない。キーはエラー文・応答に出さない。25 秒ためる", async () => {
    let calls = 0;
    const unset = await busSrv.getBuses({ now: NOW, env: {}, fetchImpl: (async () => (calls++, new Response("[]"))) as never });
    assert.equal(unset.res.ok, false);
    assert.equal(calls, 0);
    const urls: string[] = [];
    const f = (async (u: string) => (urls.push(u), new Response(JSON.stringify([odptBus("1", 35.68, 139.76)])))) as never;
    const env = { ODPT_CONSUMER_KEY: "odpt-key-123" };
    const r = await busSrv.getBuses({ now: NOW, env, fetchImpl: f });
    assert.ok(r.res.ok && r.res.items.length === 1);
    assert.match(urls[0], /^https:\/\/api\.odpt\.org\/api\/v4\/odpt:Bus\?odpt:operator=odpt\.Operator:Toei&acl:consumerKey=odpt-key-123$/);
    assert.doesNotMatch(JSON.stringify(r.res), /odpt-key-123/);
    await busSrv.getBuses({ now: NOW + busSrv.BUS_CACHE_MS - 1, env, fetchImpl: f });
    assert.equal(urls.length, 1);
    busSrv.resetBusCache();
    const bad = await busSrv.getBuses({ now: NOW, env, fetchImpl: (async () => new Response("x", { status: 401 })) as never });
    assert.equal(bad.res.ok, false);
    if (!bad.res.ok) assert.doesNotMatch(bad.res.error, /odpt-key-123/);
    assert.equal(bad.retryAfterSec, 1800);
  });
});

describe("船（AISStream）", () => {
  beforeEach(() => shipSrv.resetShipCache());
  /** 偽の WebSocket：開いたら send を記録し、決めた通知を流す */
  function fakeWs(msgs: unknown[], opts: { fail?: boolean } = {}) {
    const sent: string[] = [];
    let made = 0;
    const factory = (url: string) => {
      made++;
      assert.equal(url, "wss://stream.aisstream.io/v0/stream");
      const ws = { onopen: null as null | (() => void), onmessage: null as null | ((e: { data: unknown }) => void), onerror: null as null | (() => void), onclose: null as null | (() => void), send: (d: string) => sent.push(d), close: () => {} };
      setTimeout(() => {
        if (opts.fail) return ws.onerror?.();
        ws.onopen?.();
        for (const m of msgs) ws.onmessage?.({ data: JSON.stringify(m) });
      }, 1);
      return ws;
    };
    return { factory, sent, made: () => made };
  }
  const box = { lamin: 35.3, lomin: 139.6, lamax: 35.7, lomax: 140.0 };

  it("AIS の位置の報告を読む（船首方位が 511 なら進路を使う・名前の @ を消す）", () => {
    const s = tr.parseAisMessage(aisMsg(431000001, 35.5, 139.8), NOW);
    assert.ok(s);
    assert.equal(s!.name, "TEST MARU");
    assert.equal(s!.heading, 45);
    assert.equal(s!.reportedAt, "2026-10-12T06:00:00.123Z");
    assert.equal(tr.parseAisMessage({ MessageType: "ShipStaticData" }, NOW), null);
    assert.equal(tr.parseAisMessage({ ...aisMsg(12, 1, 1) }, NOW), null, "MMSI は 9 桁");
  });

  it("キーと範囲を送り、範囲の中の船だけ集める。同じ範囲は 60 秒ためる。キーは応答に出さない", async () => {
    const w = fakeWs([aisMsg(431000001, 35.5, 139.8), aisMsg(431000002, 10, 10), "x"]);
    const env = { AISSTREAM_API_KEY: "ais-key-xyz" };
    const r = await shipSrv.getShips(box, { now: NOW, env, ws: w.factory as never, collectMs: 30 });
    assert.ok(r.res.ok);
    if (r.res.ok) assert.deepEqual(r.res.items.map((s) => s.mmsi), ["431000001"]);
    const sub = JSON.parse(w.sent[0]);
    assert.equal(sub.APIKey, "ais-key-xyz");
    assert.deepEqual(sub.FilterMessageTypes, ["PositionReport"]);
    assert.deepEqual(sub.BoundingBoxes, [[[35, 139.5], [36, 140]]]);
    assert.doesNotMatch(JSON.stringify(r.res), /ais-key-xyz/);
    await shipSrv.getShips(box, { now: NOW + 1000, env, ws: w.factory as never, collectMs: 30 });
    assert.equal(w.made(), 1, "60 秒はためた結果");
  });

  it("前に集めた船も合わせて返す（止まっている船は報告が少ないため）", async () => {
    const env = { AISSTREAM_API_KEY: "k" };
    await shipSrv.getShips(box, { now: NOW, env, ws: fakeWs([aisMsg(431000001, 35.5, 139.8)]).factory as never, collectMs: 20 });
    const r = await shipSrv.getShips(box, { now: NOW + shipSrv.SHIP_CACHE_MS, env, ws: fakeWs([aisMsg(431000003, 35.6, 139.9)]).factory as never, collectMs: 20 });
    assert.ok(r.res.ok && r.res.items.length === 2);
  });

  it("キー未設定・広すぎる範囲は つながない。つながらなければ失敗（作ったデータは返さない）", async () => {
    const w = fakeWs([]);
    assert.equal((await shipSrv.getShips(box, { now: NOW, env: {}, ws: w.factory as never })).res.ok, false);
    assert.equal((await shipSrv.getShips({ lamin: 30, lomin: 130, lamax: 40, lomax: 140 }, { now: NOW, env: { AISSTREAM_API_KEY: "k" }, ws: w.factory as never })).res.ok, false);
    assert.equal(w.made(), 0);
    const f = await shipSrv.getShips(box, { now: NOW, env: { AISSTREAM_API_KEY: "k" }, ws: fakeWs([], { fail: true }).factory as never, collectMs: 20 });
    assert.equal(f.res.ok, false);
  });
});

describe("道路の渋滞（TomTom のタイルをこのサイトを通して配る）", () => {
  it("決まった段階・範囲だけ。キー未設定は 503。画像でない応答は 502。キーは応答に出さない", async () => {
    const { GET } = await import("../src/app/api/edith/earth/traffic/[z]/[x]/[y]/route");
    const call = (z: string, x: string, y: string) => GET(new Request("http://localhost/x"), { params: Promise.resolve({ z, x, y }) });
    assert.equal((await call("3", "0", "0")).status, 400, "引いた段階は取りに行かない");
    assert.equal((await call("12", "99999", "0")).status, 400);
    const keep = process.env.TOMTOM_API_KEY;
    const orig = globalThis.fetch;
    try {
      delete process.env.TOMTOM_API_KEY;
      assert.equal((await call("12", "3638", "1612")).status, 503);
      process.env.TOMTOM_API_KEY = "tt-key-1";
      const seen: { url: string; key: string | null }[] = [];
      globalThis.fetch = (async (u: string, init?: RequestInit) => (seen.push({ url: String(u), key: new Headers(init?.headers).get("tomtom-api-key") }), new Response(new Uint8Array([137, 80, 78, 71]), { headers: { "Content-Type": "image/png" } }))) as typeof fetch;
      const ok = await call("12", "3638", "1612.png");
      assert.equal(ok.status, 200);
      assert.equal(ok.headers.get("cache-control"), "private, max-age=120");
      assert.match(seen[0].url, /^https:\/\/api\.tomtom\.com\/maps\/orbis\/traffic\/tile\/flow\/12\/3638\/1612\.png\?/);
      assert.equal(seen[0].key, "tt-key-1");
      globalThis.fetch = (async () => new Response("{\"error\":\"bad\"}", { status: 200, headers: { "Content-Type": "application/json" } })) as typeof fetch;
      const bad = await call("12", "3638", "1612");
      assert.equal(bad.status, 502);
      assert.doesNotMatch(await bad.text(), /tt-key-1/);
    } finally {
      globalThis.fetch = orig;
      if (keep === undefined) delete process.env.TOMTOM_API_KEY;
      else process.env.TOMTOM_API_KEY = keep;
    }
  });
  it("設定：渋滞・バス・船は既定で ON（キーが無ければ取りに行かない）", () => {
    assert.deepEqual([DEFAULT_EARTH.traffic, DEFAULT_EARTH.buses, DEFAULT_EARTH.ships], [true, true, true]);
    assert.equal(parseEarthSettings({ ships: false }).ships, false);
    assert.equal(tr.bboxOverlaps({ lamin: 35.6, lomin: 139.7, lamax: 35.8, lomax: 139.9 }, tr.TOEI_AREA), true);
    assert.equal(tr.bboxOverlaps({ lamin: 34, lomin: 135, lamax: 34.5, lomax: 135.5 }, tr.TOEI_AREA), false);
  });
});

describe("場所の検索（都市・主な地点）", () => {
  it("都市はその街が見える高さへ。「東京駅」は「東京」より先。見つからなければ null", async () => {
    const { findCity } = await import("../src/lib/earth/places");
    const tokyo = findCity("東京");
    assert.ok(tokyo && Math.abs(tokyo.lat - 35.68) < 0.01 && Math.abs(tokyo.lon - 139.77) < 0.01 && tokyo.height <= 50_000);
    assert.equal(findCity("東京駅")?.name, "東京駅");
    assert.equal(findCity("London")?.name, "ロンドン");
    assert.equal(findCity("渋谷のあたり")?.name, "渋谷");
    assert.equal(findCity("どこでもない場所"), null);
    assert.equal(findCity(""), null);
  });
});
