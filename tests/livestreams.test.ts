import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

const lib = await import("../src/lib/earth/livestreams");
const srv = await import("../src/integrations/earth/livestreams");
const route = await import("../src/app/api/edith/earth/livestreams/route");

const NOW = Date.parse("2026-10-13T06:00:00Z");
const SEARCH = { items: [{ id: { videoId: "AAAAAAAAAAA" } }, { id: { videoId: "BBBBBBBBBBB" } }, { id: { videoId: "CCCCCCCCCCC" } }, { id: { videoId: "bad" } }] };
const VIDEOS = {
  items: [
    { id: "AAAAAAAAAAA", snippet: { title: "渋谷スクランブル交差点 ライブカメラ", channelTitle: "見本チャンネル", liveBroadcastContent: "live", thumbnails: { medium: { url: "https://i.ytimg.com/vi/AAAAAAAAAAA/mqdefault_live.jpg" } } }, status: { embeddable: true, privacyStatus: "public" }, liveStreamingDetails: { actualStartTime: "2026-10-01T00:00:00Z", concurrentViewers: "1234" } },
    // 埋め込み不可 → 出さない
    { id: "BBBBBBBBBBB", snippet: { title: "x", liveBroadcastContent: "live" }, status: { embeddable: false, privacyStatus: "public" } },
    // 配信が終わった → 出さない
    { id: "CCCCCCCCCCC", snippet: { title: "y", liveBroadcastContent: "none" }, status: { embeddable: true, privacyStatus: "public" } },
  ],
};

describe("ライブ配信（YouTube）：読み取り", () => {
  it("検索の言葉：日本は「<場所> ライブカメラ」、海外は英語。道路カメラは「道路」", () => {
    assert.equal(lib.liveStreamQuery("渋谷", { japan: true }), "渋谷 ライブカメラ");
    assert.equal(lib.liveStreamQuery("渋谷", { japan: true, traffic: true }), "渋谷 道路 ライブカメラ");
    assert.equal(lib.liveStreamQuery("ニューヨーク", { japan: false }), "ニューヨーク live cam");
    assert.equal(lib.liveStreamQuery('a"|b', { japan: true }), "ab ライブカメラ");
    assert.ok(lib.inJapan(35.66, 139.7));
    assert.ok(!lib.inJapan(40.7, -74));
  });
  it("いま配信中・公開・埋め込み可のものだけ", () => {
    assert.deepEqual(lib.parseYouTubeSearchIds(SEARCH), ["AAAAAAAAAAA", "BBBBBBBBBBB", "CCCCCCCCCCC"]);
    const v = lib.parseYouTubeVideos(VIDEOS);
    assert.equal(v.length, 1);
    assert.equal(v[0].id, "AAAAAAAAAAA");
    assert.equal(v[0].viewers, 1234);
    assert.equal(v[0].channel, "見本チャンネル");
    assert.match(v[0].thumbnail ?? "", /^https:\/\/i\.ytimg\.com\//);
    assert.throws(() => lib.parseYouTubeVideos({}));
  });
  it("埋め込みは youtube-nocookie（自動再生・音なし）", () => {
    assert.equal(lib.liveEmbedUrl("AAAAAAAAAAA"), "https://www.youtube-nocookie.com/embed/AAAAAAAAAAA?autoplay=1&mute=1&playsinline=1&rel=0");
  });
  it("画面での確認：形の違うもの・YouTube 以外の画像は捨てる", () => {
    const r = lib.parseLiveStreamsResponse({ ok: true, fetchedAt: "x", query: "q", items: [{ id: "AAAAAAAAAAA", title: "t", thumbnail: "https://evil.example/a.jpg" }, { id: "<x>" }] });
    assert.ok(r?.ok);
    if (r?.ok) {
      assert.equal(r.items.length, 1);
      assert.equal(r.items[0].thumbnail, null);
    }
  });
});

describe("ライブ配信（YouTube）：サーバー", () => {
  beforeEach(() => srv.resetLiveStreamCache());
  const okFetch = (seen: string[]) =>
    (async (url: string) => {
      seen.push(url);
      return new Response(JSON.stringify(url.includes("/search?") ? SEARCH : VIDEOS), { headers: { "content-type": "application/json" } });
    }) as never;
  it("キーが無ければ取りに行かない", async () => {
    const seen: string[] = [];
    const r = await srv.getLiveStreams("渋谷 ライブカメラ", { now: NOW, env: {}, fetchImpl: okFetch(seen) });
    assert.equal(r.res.ok, false);
    assert.equal(seen.length, 0);
  });
  it("配信中・埋め込み可で探し、確かめる。20 分ためておく。応答にキーは出さない", async () => {
    const seen: string[] = [];
    const env = { YOUTUBE_API_KEY: "SECRET-YT-KEY" };
    const r = await srv.getLiveStreams("渋谷 ライブカメラ", { now: NOW, env, fetchImpl: okFetch(seen), japan: true });
    assert.ok(r.res.ok);
    if (r.res.ok) assert.equal(r.res.items.length, 1);
    assert.equal(seen.length, 2);
    const s = new URL(seen[0]).searchParams;
    assert.equal(s.get("eventType"), "live");
    assert.equal(s.get("type"), "video");
    assert.equal(s.get("videoEmbeddable"), "true");
    assert.equal(s.get("regionCode"), "JP");
    assert.match(new URL(seen[1]).searchParams.get("part") ?? "", /liveStreamingDetails/);
    assert.doesNotMatch(JSON.stringify(r.res), /SECRET/);
    await srv.getLiveStreams("渋谷 ライブカメラ", { now: NOW + srv.LIVESTREAM_CACHE_MS - 1, env, fetchImpl: okFetch(seen) });
    assert.equal(seen.length, 2, "ためておいた結果を返す");
  });
  it("枠の使い切り（403）はキーを出さずに伝え、1 時間取りに行かない", async () => {
    let calls = 0;
    const f = (async () => (calls++, new Response('{"error":{"errors":[{"reason":"quotaExceeded"}]}}', { status: 403 }))) as never;
    const env = { YOUTUBE_API_KEY: "SECRET-YT-KEY" };
    const r = await srv.getLiveStreams("a", { now: NOW, env, fetchImpl: f });
    assert.equal(r.res.ok, false);
    if (!r.res.ok) {
      assert.match(r.res.error, /YOUTUBE_API_KEY/);
      assert.doesNotMatch(r.res.error, /SECRET/);
    }
    await srv.getLiveStreams("b", { now: NOW + 30 * 60_000, env, fetchImpl: f });
    assert.equal(calls, 1);
  });
});

describe("ライブ配信（YouTube）：API", () => {
  it("場所の指定が正しくなければ 400、キーが無ければ 503", async () => {
    const prev = process.env.YOUTUBE_API_KEY;
    delete process.env.YOUTUBE_API_KEY;
    try {
      srv.resetLiveStreamCache();
      assert.equal((await route.GET(new Request("http://x/api/edith/earth/livestreams?lat=1&lon=2"))).status, 400);
      assert.equal((await route.GET(new Request("http://x/api/edith/earth/livestreams?place=%3Cscript%3E&lat=1&lon=2"))).status, 400);
      assert.equal((await route.GET(new Request("http://x/api/edith/earth/livestreams?place=a&lat=abc&lon=2"))).status, 400);
      assert.equal((await route.GET(new Request(`http://x/api/edith/earth/livestreams?place=${encodeURIComponent("渋谷")}&lat=35.66&lon=139.7`))).status, 503);
    } finally {
      if (prev !== undefined) process.env.YOUTUBE_API_KEY = prev;
    }
  });
});
