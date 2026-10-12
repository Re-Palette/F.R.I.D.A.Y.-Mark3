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

describe("映像の枠の形（feedShape）", () => {
  it("既定は横長。前の版で保存した設定（feedShape が無い）でも、ほかの設定はそのまま読める", () => {
    assert.equal(DEFAULT_DISPLAY.feedShape, "wide");
    const old = { hud: false, fade: 70, clean: true, bloom: true };
    const d = parseDisplay(old);
    assert.equal(d.feedShape, "wide");
    assert.equal(d.hud, false);
    assert.equal(d.fade, 70);
    assert.equal(d.clean, true);
    assert.equal(d.bloom, true);
  });
  it("円・横長は読み、知らない値・壊れた値は横長に戻す", () => {
    assert.equal(parseDisplay({ feedShape: "circle" }).feedShape, "circle");
    assert.equal(parseDisplay({ feedShape: "wide" }).feedShape, "wide");
    for (const v of ["square", 1, null, {}, "CIRCLE"]) assert.equal(parseDisplay({ feedShape: v }).feedShape, "wide", String(v));
  });
  it("保存した形を JSON で読み直しても同じ", () => {
    const cur = { ...DEFAULT_DISPLAY, feedShape: "circle" as const, sharpenAmt: 12 };
    assert.deepEqual(parseDisplay(JSON.parse(JSON.stringify(cur))), cur);
  });
  it("プリセットを当てても、枠の形は今のまま（CLEAN UI と同じ扱い）", () => {
    const cur = { ...DEFAULT_DISPLAY, feedShape: "circle" as const };
    for (const k of ["tactical", "cinematic", "minimal"] as const) assert.equal(applyPreset(k, cur).feedShape, "circle", k);
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
