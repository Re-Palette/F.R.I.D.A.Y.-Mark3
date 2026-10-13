import test from "node:test";
import assert from "node:assert/strict";

const wm = await import("../src/lib/earth/windy-map");
const ue = await import("../src/components/edith/useEarthData");
const disp = await import("../src/lib/edith-display");

test("天気の地図の設定・拡大の段階", () => {
  assert.deepEqual(wm.parseWeatherSettings({ overlay: "temp" }), { overlay: "temp" });
  assert.deepEqual(wm.parseWeatherSettings({ overlay: "<x>" }), wm.DEFAULT_WEATHER);
  assert.deepEqual(wm.parseWeatherSettings(null), wm.DEFAULT_WEATHER);
  assert.ok(wm.zoomForHeight(40_000) >= 8 && wm.zoomForHeight(40_000) <= 10);
  assert.ok(wm.zoomForHeight(1_500_000) >= 4 && wm.zoomForHeight(1_500_000) <= 6);
  assert.equal(wm.zoomForHeight(null), 5);
  assert.equal(wm.zoomForHeight(1), 11);
  assert.equal(wm.zoomForHeight(1e9), 3);
});

test("Windy のキー：形の正しいものだけ画面で使う", () => {
  assert.equal(ue.parseEarthConfig({ windyMapKey: "AbCdEf0123456789xyz", services: {} })?.windyMapKey, "AbCdEf0123456789xyz");
  assert.equal(ue.parseEarthConfig({ windyMapKey: "<script>alert(1)</script>", services: {} })?.windyMapKey, null);
  assert.equal(ue.parseEarthConfig({ services: {} })?.windyMapKey, null);
});

test("GOD'S EYE VIEW に WEATHER を選べる（保存した設定から戻る）", () => {
  assert.equal(disp.parseDisplay({ gevMode: "weather" }).gevMode, "weather");
  assert.equal(disp.parseDisplay({ gevMode: "x" }).gevMode, disp.DEFAULT_DISPLAY.gevMode);
});

test("設定の API：Windy の地図のキーを返す（ほかのキーは返さない）", async () => {
  const keep = { ...process.env };
  try {
    process.env.WINDY_MAP_KEY = "MapKey0123456789abcd";
    process.env.WINDY_WEBCAMS_KEY = "windy-cam-secret";
    const { GET } = await import("../src/app/api/edith/earth/config/route");
    const j = await (await GET()).json();
    assert.equal(j.windyMapKey, "MapKey0123456789abcd");
    assert.doesNotMatch(JSON.stringify(j), /windy-cam-secret/);
  } finally {
    process.env = keep;
  }
});
