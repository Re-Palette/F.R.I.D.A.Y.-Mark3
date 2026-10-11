/**
 * E.D.I.T.H. の表示設定（保存した値の読み直し・プリセット）と、太陽の高度の計算のテスト。
 *   npm test
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

const { DEFAULT_DISPLAY, parseDisplay, applyPreset, nextPreset, solarElevation } = await import("../src/lib/edith-display");

describe("E.D.I.T.H. の表示設定", () => {
  it("何も無い・壊れた値は既定にする", () => {
    assert.deepEqual(parseDisplay(null), DEFAULT_DISPLAY);
    assert.deepEqual(parseDisplay("x"), DEFAULT_DISPLAY);
  });
  it("範囲外の数字は 0〜100 に収め、知らない選択肢は既定に戻す", () => {
    const d = parseDisplay({ fade: 300, outside: -5, density: "9", layout: "huge", allocation: "weighted", hud: false });
    assert.equal(d.fade, 100);
    assert.equal(d.outside, 0);
    assert.equal(d.density, DEFAULT_DISPLAY.density);
    assert.equal(d.layout, "tactical");
    assert.equal(d.allocation, "weighted");
    assert.equal(d.hud, false);
  });
  it("プリセットは既定から作り直し、CLEAN UI だけは今のまま", () => {
    const cur = { ...DEFAULT_DISPLAY, fade: 90, clean: true };
    const m = applyPreset("minimal", cur);
    assert.equal(m.hud, false);
    assert.equal(m.clean, true);
    assert.equal(applyPreset("tactical", cur).fade, DEFAULT_DISPLAY.fade);
    assert.equal(nextPreset("minimal"), "tactical");
  });
});

describe("太陽の高度", () => {
  it("東京・夏至の正午ごろは約 77°", () => {
    const el = solarElevation(new Date("2024-06-21T02:40:00Z"), 35.6812, 139.7671);
    assert.ok(Math.abs(el - 77.7) < 1.5, String(el));
  });
  it("東京・真夜中は地平線の下", () => {
    assert.ok(solarElevation(new Date("2024-06-21T15:00:00Z"), 35.6812, 139.7671) < -20);
  });
  it("春分の正午・赤道ではほぼ真上", () => {
    assert.ok(solarElevation(new Date("2024-03-20T12:07:00Z"), 0, 0) > 87);
  });
});
