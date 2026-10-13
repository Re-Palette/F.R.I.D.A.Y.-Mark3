import test from "node:test";
import assert from "node:assert/strict";

const { holdReveal, whenRevealReady } = await import("../src/lib/screen-cover");

test("幕を開ける待ち：準備が無ければすぐ、あれば全部終わってから 1 回だけ知らせる", () => {
  let n = 0;
  whenRevealReady(() => n++);
  assert.equal(n, 1);

  const a = holdReveal();
  const b = holdReveal();
  let m = 0;
  whenRevealReady(() => m++);
  a();
  assert.equal(m, 0);
  a(); // 2 回呼んでも数えない
  assert.equal(m, 0);
  b();
  assert.equal(m, 1);
  b();
  assert.equal(m, 1);
});

test("幕を開ける待ち：取り消したら知らせない", () => {
  const a = holdReveal();
  let m = 0;
  const cancel = whenRevealReady(() => m++);
  cancel();
  a();
  assert.equal(m, 0);
});
