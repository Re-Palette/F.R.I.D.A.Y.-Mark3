import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

const lib = await import("../src/lib/earth/webcams");
const srv = await import("../src/integrations/earth/webcams");
const route = await import("../src/app/api/edith/earth/webcams/route");
const config = await import("../src/app/api/edith/earth/config/route");

const NOW = Date.parse("2026-10-13T00:00:00Z");
const SAMPLE = {
  total: 2,
  webcams: [
    {
      webcamId: 1234567890,
      title: "Tokyo: Shibuya Crossing",
      status: "active",
      lastUpdatedOn: "2026-10-12T23:55:00.000Z",
      categories: [{ id: "traffic", name: "Traffic" }],
      images: { current: { preview: "https://images-webcams.windy.com/90/1234567890/current/preview/1234567890.jpg?token=x", thumbnail: "https://images-webcams.windy.com/90/1234567890/current/thumbnail/1234567890.jpg" } },
      location: { city: "Tokyo", country: "Japan", latitude: 35.6595, longitude: 139.7005 },
      player: { day: "https://webcams.windy.com/webcams/public/embed/player/1234567890/day" },
      urls: { detail: "https://www.windy.com/webcams/1234567890" },
    },
    // 画像・再生画面が Windy 以外の場所 → 読み込まない
    { webcamId: 42, title: "x", status: "active", images: { current: { preview: "http://evil.example/a.jpg" } }, location: { latitude: 35.6, longitude: 139.7 }, player: { day: "https://evil.example/p" } },
    // 止まっているカメラ・位置の無いもの → 捨てる
    { webcamId: 43, title: "off", status: "inactive", location: { latitude: 35, longitude: 139 } },
    { webcamId: 44, title: "noloc", status: "active", location: {} },
  ],
};

describe("ライブカメラ（Windy）：読み取り", () => {
  it("Windy の応答を読む（Windy の URL だけ通す・止まっているものは捨てる）", () => {
    const items = lib.parseWindy(SAMPLE);
    assert.equal(items.length, 2);
    const a = items[0];
    assert.equal(a.id, "1234567890");
    assert.equal(a.traffic, true);
    assert.match(a.preview ?? "", /^https:\/\/images-webcams\.windy\.com\//);
    assert.match(a.player ?? "", /embed\/player\/1234567890/);
    assert.equal(a.city, "Tokyo");
    assert.equal(items[1].preview, null);
    assert.equal(items[1].player, null);
    assert.throws(() => lib.parseWindy({ nope: 1 }));
  });
  it("探す場所は丸める・正しくない場所は null", () => {
    assert.deepEqual(lib.webcamQuery(35.6595, 139.7005, 15.4), { lat: 35.65, lon: 139.7, radiusKm: 15 });
    assert.equal(lib.webcamQuery(35, 139, 999)?.radiusKm, lib.WEBCAM_RADIUS_MAX);
    assert.equal(lib.webcamQuery(95, 0), null);
    assert.equal(lib.webcamQuery(NaN, 0), null);
  });
  it("画面での確認：形の違うものは捨てる", () => {
    const ok = lib.parseWebcamsResponse({ ok: true, fetchedAt: "x", center: { lat: 1, lon: 2 }, radiusKm: 15, traffic: false, items: [{ id: "1", title: "t", lat: 1, lon: 2, player: "https://evil.example/" }, { id: "bad id", lat: 1, lon: 2 }] });
    assert.ok(ok?.ok);
    if (ok?.ok) {
      assert.equal(ok.items.length, 1);
      assert.equal(ok.items[0].player, null);
    }
    assert.deepEqual(lib.parseWebcamsResponse({ ok: false, error: "e" }), { ok: false, error: "e" });
    assert.equal(lib.parseWebcamsResponse("x"), null);
  });
});

describe("ライブカメラ（Windy）：サーバー", () => {
  beforeEach(() => srv.resetWebcamCache());
  it("キーが無ければ取りに行かない", async () => {
    let calls = 0;
    const r = await srv.getWebcams({ lat: 35.66, lon: 139.7 }, { now: NOW, env: {}, fetchImpl: (async () => (calls++, new Response("{}"))) as never });
    assert.equal(r.res.ok, false);
    assert.equal(calls, 0);
  });
  it("キーはヘッダーで送り、URL・応答には出さない。5 分ためておく", async () => {
    const seen: { url: string; key: string | null }[] = [];
    const f = (async (url: string, init?: RequestInit) => {
      seen.push({ url, key: new Headers(init?.headers).get("x-windy-api-key") });
      return new Response(JSON.stringify(SAMPLE), { headers: { "content-type": "application/json" } });
    }) as never;
    const env = { WINDY_WEBCAMS_KEY: "SECRET-KEY-123" };
    const r = await srv.getWebcams({ lat: 35.6595, lon: 139.7005, radiusKm: 15, traffic: true }, { now: NOW, env, fetchImpl: f });
    assert.ok(r.res.ok);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].key, "SECRET-KEY-123");
    assert.doesNotMatch(seen[0].url, /SECRET/);
    assert.match(seen[0].url, /nearby=35\.65%2C139\.7%2C15/);
    assert.match(seen[0].url, /categories=traffic/);
    assert.doesNotMatch(JSON.stringify(r.res), /SECRET/);
    await srv.getWebcams({ lat: 35.6595, lon: 139.7005, radiusKm: 15, traffic: true }, { now: NOW + srv.WEBCAM_CACHE_MS - 1, env, fetchImpl: f });
    assert.equal(seen.length, 1, "ためておいた結果を返す");
  });
  it("キーの誤り（403）はキーを出さずに伝え、しばらく取りに行かない", async () => {
    let calls = 0;
    const f = (async () => (calls++, new Response("no", { status: 403 }))) as never;
    const env = { WINDY_WEBCAMS_KEY: "SECRET-KEY-123" };
    const r = await srv.getWebcams({ lat: 1, lon: 2 }, { now: NOW, env, fetchImpl: f });
    assert.equal(r.res.ok, false);
    if (!r.res.ok) {
      assert.match(r.res.error, /WINDY_WEBCAMS_KEY/);
      assert.doesNotMatch(r.res.error, /SECRET/);
    }
    await srv.getWebcams({ lat: 3, lon: 4 }, { now: NOW + 60_000, env, fetchImpl: f });
    assert.equal(calls, 1);
  });
});

describe("ライブカメラ（Windy）：API", () => {
  it("場所の指定が正しくなければ 400、キーが無ければ 503", async () => {
    const prev = process.env.WINDY_WEBCAMS_KEY;
    delete process.env.WINDY_WEBCAMS_KEY;
    try {
      srv.resetWebcamCache();
      assert.equal((await route.GET(new Request("http://x/api/edith/earth/webcams?lat=abc&lon=1"))).status, 400);
      assert.equal((await route.GET(new Request("http://x/api/edith/earth/webcams"))).status, 400);
      assert.equal((await route.GET(new Request("http://x/api/edith/earth/webcams?lat=35.6&lon=139.7"))).status, 503);
    } finally {
      if (prev !== undefined) process.env.WINDY_WEBCAMS_KEY = prev;
    }
  });
  it("設定：ライブカメラのキーの有無だけ返す（キーは返さない）", async () => {
    const prev = process.env.WINDY_WEBCAMS_KEY;
    process.env.WINDY_WEBCAMS_KEY = "SECRET-KEY-123";
    try {
      const j = await (await config.GET()).json();
      assert.equal(j.services.webcams, true);
      assert.doesNotMatch(JSON.stringify(j), /SECRET/);
    } finally {
      if (prev === undefined) delete process.env.WINDY_WEBCAMS_KEY;
      else process.env.WINDY_WEBCAMS_KEY = prev;
    }
  });
});
