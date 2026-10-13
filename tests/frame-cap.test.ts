import test from "node:test";
import assert from "node:assert/strict";

const { tooSoon, MIN_FRAME_MS } = await import("../src/lib/frame-cap");

test("描き直しの間隔：60 回の画面では毎回描き、120 回の画面では 1 回おきに描く", () => {
  // 60Hz（約 16.7ms ごと）：ぶれても飛ばさない
  assert.equal(tooSoon(1015.5, 1000), false);
  assert.equal(tooSoon(1016.7, 1000), false);
  // 120Hz（約 8.3ms ごと）：1 回目は飛ばし、2 回目で描く
  assert.equal(tooSoon(1008.3, 1000), true);
  assert.equal(tooSoon(1016.6, 1000), false);
  assert.ok(MIN_FRAME_MS > 8.4 && MIN_FRAME_MS < 15.5);
});

test("ほかのアプリを使っている間は 1 秒 30 回ほどまで", () => {
  const g = globalThis as { document?: unknown };
  const before = g.document;
  try {
    g.document = { hasFocus: () => false };
    assert.equal(tooSoon(1016.7, 1000), true);
    assert.equal(tooSoon(1033.3, 1000), false);
    g.document = { hasFocus: () => true };
    assert.equal(tooSoon(1016.7, 1000), false);
  } finally {
    g.document = before;
  }
});
