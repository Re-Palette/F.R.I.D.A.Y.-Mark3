import test from "node:test";
import assert from "node:assert/strict";

const { parseEdithCommand, runEdithCommand, setEdithCommandHandler } = await import("../src/lib/edith-commands");

const kind = (t: string) => parseEdithCommand(t)?.kind ?? null;

test("ピックアップ：場所に寄って、近くのカメラを出す", () => {
  const c = parseEdithCommand("渋谷をピックアップして");
  assert.equal(c?.kind, "pickup");
  if (c?.kind !== "pickup") return;
  assert.equal(c.place.name, "渋谷");
  assert.equal(c.cams, true);
  assert.equal(c.city3d, false);
  assert.equal(c.track, null);
});

test("3D で見せる・監視カメラ（公開の道路カメラ）・国", () => {
  const a = parseEdithCommand("新宿を3Dで見せて");
  assert.ok(a?.kind === "pickup" && a.city3d && !a.cams && a.place.name === "新宿");
  const b = parseEdithCommand("新宿を３Ｄで見せて"); // 全角
  assert.ok(b?.kind === "pickup" && b.city3d);
  const c = parseEdithCommand("東京の監視カメラを見せて");
  assert.ok(c?.kind === "pickup" && c.cams && c.traffic);
  const d = parseEdithCommand("ニューヨークのライブ映像を映して");
  assert.ok(d?.kind === "pickup" && d.cams && d.place.name === "ニューヨーク");
  const e = parseEdithCommand("フランスを見せて");
  assert.ok(e?.kind === "pickup" && e.country);
});

test("飛行機・船を選んで追う", () => {
  assert.deepEqual(parseEdithCommand("近くの飛行機をピックアップ"), { kind: "track", target: "aircraft" });
  assert.deepEqual(parseEdithCommand("船を追って"), { kind: "track", target: "ship" });
  const c = parseEdithCommand("羽田の飛行機を追って");
  assert.ok(c?.kind === "pickup" && c.track === "aircraft" && c.place.name === "羽田空港");
  assert.deepEqual(parseEdithCommand("追跡をやめて"), { kind: "untrack" });
});

test("表示の切り替え・初期の視点", () => {
  assert.deepEqual(parseEdithCommand("雨雲を出して"), { kind: "layer", layer: "radar", on: true });
  assert.deepEqual(parseEdithCommand("渋滞を消して"), { kind: "layer", layer: "traffic", on: false });
  assert.deepEqual(parseEdithCommand("衛星写真を表示して"), { kind: "layer", layer: "detail", on: true });
  assert.deepEqual(parseEdithCommand("地震を非表示に"), { kind: "layer", layer: "quakes", on: false });
  assert.deepEqual(parseEdithCommand("カメラを消して"), { kind: "layer", layer: "webcams", on: false });
  assert.deepEqual(parseEdithCommand("この辺のカメラを見せて"), { kind: "cams", traffic: false });
  assert.deepEqual(parseEdithCommand("地球全体に戻して"), { kind: "reset" });
});

test("質問・ほかの指示は AI に渡す（見分けない）", () => {
  for (const t of ["東京の天気は？", "東京のニュースを出して", "渋谷について調べて", "バスの時間を教えて", "音楽を止めて", "テレビを消して", "こんにちは", "東京", "東京の資料を作って", "雨は降る？"]) {
    assert.equal(kind(t), null, t);
  }
});

test("受け口：画面が開いていなければ null（AI に渡す）・開いていれば返事", () => {
  assert.equal(runEdithCommand("雨雲を出して"), null);
  const off = setEdithCommandHandler((c) => `OK ${c.kind}`);
  assert.equal(runEdithCommand("雨雲を出して"), "OK layer");
  assert.equal(runEdithCommand("今日の予定は"), null);
  off();
  assert.equal(runEdithCommand("雨雲を出して"), null);
});

test("Windy の天気の地図（WEATHER）に切り替える", () => {
  assert.deepEqual(parseEdithCommand("風の流れを見せて"), { kind: "weather", overlay: "wind", place: null });
  const a = parseEdithCommand("東京の気温を見せて");
  assert.ok(a?.kind === "weather" && a.overlay === "temp" && a.place?.name === "東京");
  assert.deepEqual(parseEdithCommand("天気図を出して"), { kind: "weather", overlay: "pressure", place: null });
  assert.deepEqual(parseEdithCommand("台風の様子を見せて"), { kind: "weather", overlay: "wind", place: null });
  assert.deepEqual(parseEdithCommand("雨の予報を見せて"), { kind: "weather", overlay: "rain", place: null });
  assert.deepEqual(parseEdithCommand("天気を見せて"), { kind: "weather", overlay: null, place: null });
  // 雨雲は地球儀の雨雲レーダー・質問は AI
  assert.deepEqual(parseEdithCommand("雨雲を出して"), { kind: "layer", layer: "radar", on: true });
  assert.equal(parseEdithCommand("明日の気温を教えて"), null);
  assert.equal(parseEdithCommand("風が強いのはなぜ？"), null);
  assert.deepEqual(parseEdithCommand("地球儀に戻して"), { kind: "reset" });
});

test("いちばん近い街（場所の名前が無いときにライブ配信を探す言葉）", async () => {
  const { nearestCity } = await import("../src/lib/earth/places");
  assert.equal(nearestCity(35.659, 139.70)?.name, "渋谷");
  assert.equal(nearestCity(34.70, 135.50)?.name, "大阪");
  assert.equal(nearestCity(0, -150), null);
});
