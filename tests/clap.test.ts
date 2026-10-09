/**
 * 拍手 2 回の検出のテスト（作った音で試す。本物のマイクは使わない）。
 *   - いろいろな拍手（高い音の拍手・こもった拍手・響く部屋・小さめ・間隔が長め・16kHz のマイク）は 2 回で反応する
 *   - 1 回だけ・3 回以上・「パ、パ」と話す声・ノックのような低い音・続く音・キーボードを打つ音では反応しない
 *   npm test
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

const { DoubleClapDetector } = await import("../src/lib/clap");

/** 決まった乱数（毎回同じ音になるように） */
function rng(seed: number) {
  let x = seed >>> 0;
  return () => {
    x = (x * 1664525 + 1013904223) >>> 0;
    return x / 2 ** 32 - 0.5;
  };
}

/** 2 次のバンドパスを 2 回（音の高さを寄せる。本物の拍手・ノックに近いよう、離れた高さの音はしっかり落とす） */
function bandpass(sig: Float32Array, sr: number, hz: number) {
  return bandpass2(bandpass2(sig, sr, hz), sr, hz);
}

function bandpass2(sig: Float32Array, sr: number, hz: number, q = 1.2) {
  const w = (2 * Math.PI * hz) / sr;
  const alpha = Math.sin(w) / (2 * q);
  const a0 = 1 + alpha;
  const b0 = alpha / a0;
  const b2 = -alpha / a0;
  const a1 = (-2 * Math.cos(w)) / a0;
  const a2 = (1 - alpha) / a0;
  const out = new Float32Array(sig.length);
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  for (let i = 0; i < sig.length; i++) {
    const y = b0 * sig[i] + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1;
    x1 = sig[i];
    y2 = y1;
    y1 = y;
    out[i] = y;
  }
  return out;
}

interface ClapOpts {
  /** 主な音の高さ（Hz）。undefined なら全部の高さ（ザラッとした音） */
  hz?: number;
  /** 音が消えるまでの速さ（秒。大きいほど響く） */
  decay?: number;
  amp?: number;
}

/** 拍手 1 回の音（一瞬で立ち上がり、すぐ消える雑音） */
function clapSound(sr: number, { hz, decay = 0.012, amp = 0.5 }: ClapOpts, rand: () => number) {
  const n = Math.round(sr * Math.max(0.1, decay * 8));
  let s = new Float32Array(n);
  for (let i = 0; i < n; i++) s[i] = rand() * 2;
  if (hz) s = bandpass(s, sr, hz);
  let peak = 0;
  for (const v of s) peak = Math.max(peak, Math.abs(v));
  for (let i = 0; i < n; i++) s[i] = (s[i] / peak) * amp * Math.exp(-i / sr / decay);
  return s;
}

/** 秒ごとに音を並べ、うしろに静かな部屋の雑音を足す */
function scene(sr: number, total: number, parts: { at: number; sound: Float32Array }[], noise = 0.002, seed = 1) {
  const rand = rng(seed);
  const out = new Float32Array(Math.round(sr * total));
  for (let i = 0; i < out.length; i++) out[i] = rand() * 2 * noise;
  for (const { at, sound } of parts) {
    const o = Math.round(at * sr);
    for (let i = 0; i < sound.length && o + i < out.length; i++) out[o + i] += sound[i];
  }
  return out;
}

/** 実際のマイクと同じく、1024 サンプルずつ渡して何回反応したか数える */
function count(sig: Float32Array, sr: number) {
  let hits = 0;
  const d = new DoubleClapDetector(sr, () => hits++);
  for (let i = 0; i < sig.length; i += 1024) d.push(sig.subarray(i, i + 1024));
  return hits;
}

const claps = (sr: number, times: number[], o: ClapOpts = {}, seed = 7) => {
  const rand = rng(seed);
  return times.map((at) => ({ at, sound: clapSound(sr, o, rand) }));
};

/** 声の「パ」：短い破裂のあとに母音（低い音が続く） */
function pa(sr: number, rand: () => number) {
  const burst = clapSound(sr, { decay: 0.006, amp: 0.4 }, rand);
  const vowel = new Float32Array(Math.round(sr * 0.18));
  for (let i = 0; i < vowel.length; i++) {
    const t = i / sr;
    vowel[i] = 0.25 * Math.min(1, t / 0.01) * (Math.sin(2 * Math.PI * 140 * t) + 0.5 * Math.sin(2 * Math.PI * 700 * t));
  }
  const out = new Float32Array(Math.round(sr * 0.012) + vowel.length);
  out.set(burst.subarray(0, Math.min(burst.length, out.length)));
  for (let i = 0; i < vowel.length; i++) out[Math.round(sr * 0.012) + i] += vowel[i];
  return out;
}

describe("拍手 2 回で反応する", () => {
  const sr = 48_000;
  const cases: [string, ClapOpts, number[], number?][] = [
    ["ザラッとした高い拍手", {}, [0.5, 0.9]],
    ["こもった拍手（1.5kHz あたり）", { hz: 1500 }, [0.5, 0.9]],
    ["手を丸めて打つ低めの拍手（1kHz あたり）", { hz: 1000 }, [0.5, 0.85]],
    ["響く部屋（なかなか消えない）", { decay: 0.035 }, [0.5, 1.0]],
    ["小さめの拍手（離れた所から）", { amp: 0.06 }, [0.5, 0.9]],
    ["間隔が長め（0.75 秒）", {}, [0.5, 1.25]],
    ["速い拍手（0.2 秒）", {}, [0.5, 0.7]],
  ];
  for (const [name, o, times] of cases) {
    it(name, () => assert.equal(count(scene(sr, 3, claps(sr, times, o)), sr), 1));
  }
  it("16kHz のマイクでも反応する", () => {
    assert.equal(count(scene(16_000, 3, claps(16_000, [0.5, 0.9], { hz: 1500 })), 16_000), 1);
  });
  it("44.1kHz のマイクでも反応する", () => {
    assert.equal(count(scene(44_100, 3, claps(44_100, [0.5, 0.9], { hz: 1500 })), 44_100), 1);
  });
});

describe("拍手 2 回以外では反応しない", () => {
  const sr = 48_000;
  it("1 回だけ", () => assert.equal(count(scene(sr, 3, claps(sr, [0.5])), sr), 0));
  it("3 回続く（拍手喝采）", () => assert.equal(count(scene(sr, 3, claps(sr, [0.5, 0.75, 1.0, 1.25])), sr), 0));
  it("間が空きすぎ（1 秒以上）", () => assert.equal(count(scene(sr, 4, claps(sr, [0.5, 1.5])), sr), 0));
  it("「パ、パ」と話す声", () => {
    const rand = rng(3);
    assert.equal(count(scene(sr, 3, [{ at: 0.5, sound: pa(sr, rand) }, { at: 0.9, sound: pa(sr, rand) }]), sr), 0);
  });
  it("ノック・机を叩くような低い音（300Hz）", () => {
    assert.equal(count(scene(sr, 3, claps(sr, [0.5, 0.9], { hz: 300 })), sr), 0);
  });
  it("続く音（話し声のような 0.5 秒の音）", () => {
    const tone = new Float32Array(sr / 2);
    for (let i = 0; i < tone.length; i++) tone[i] = 0.3 * Math.sin((2 * Math.PI * 220 * i) / sr);
    assert.equal(count(scene(sr, 3, [{ at: 0.5, sound: tone }, { at: 1.2, sound: tone }]), sr), 0);
  });
});

/**
 * キーボードを打つ音：キーを押す「カチッ」（短く高い音）と、少し遅れて離す小さな音。
 * 単語ごとに 3〜7 回、0.09〜0.22 秒の間隔で打ち、単語の間は 0.3〜1.1 秒あける。
 */
function typing(sr: number, seconds: number, seed: number, loud = 0.18) {
  const rand = rng(seed);
  const r01 = () => rand() + 0.5;
  const parts: { at: number; sound: Float32Array }[] = [];
  let t = 0.3;
  while (t < seconds - 0.5) {
    const keys = 3 + Math.floor(r01() * 5);
    for (let k = 0; k < keys && t < seconds - 0.5; k++) {
      const amp = loud * (0.5 + r01());
      parts.push({ at: t, sound: clapSound(sr, { decay: 0.003 + r01() * 0.003, amp, hz: 2500 + r01() * 2000 }, rand) });
      parts.push({ at: t + 0.06 + r01() * 0.05, sound: clapSound(sr, { decay: 0.003, amp: amp * 0.35, hz: 3000 }, rand) });
      t += 0.09 + r01() * 0.13;
    }
    t += 0.3 + r01() * 0.8;
  }
  return scene(sr, seconds, parts, 0.002, seed);
}

/** 1 本指でゆっくり打つ（1 回ずつ、0.25〜0.95 秒あけて。押す音と離す音） */
function slowTyping(sr: number, seconds: number, seed: number) {
  const rand = rng(seed);
  const r01 = () => rand() + 0.5;
  const parts: { at: number; sound: Float32Array }[] = [];
  let t = 0.3;
  while (t < seconds - 0.5) {
    const amp = 0.18 * (0.5 + r01());
    parts.push({ at: t, sound: clapSound(sr, { decay: 0.004, amp, hz: 3000 }, rand) });
    parts.push({ at: t + 0.07 + r01() * 0.05, sound: clapSound(sr, { decay: 0.003, amp: amp * 0.35, hz: 3000 }, rand) });
    t += 0.25 + r01() * 0.7;
  }
  return scene(sr, seconds, parts, 0.002, seed);
}

describe("キーボードを打つ音では反応しない", () => {
  const sr = 48_000;
  for (const seed of [11, 12, 13, 14, 15]) {
    it(`30 秒タイピング（パターン ${seed}）`, () => assert.equal(count(typing(sr, 30, seed), sr), 0));
  }
  it("強めに打つタイピング", () => assert.equal(count(typing(sr, 30, 21, 0.4), sr), 0));
  for (const seed of [41, 42, 43, 44, 45]) {
    it(`1 本指でゆっくり打つ（パターン ${seed}）`, () => assert.equal(count(slowTyping(sr, 30, seed), sr), 0));
  }
  it("タイピングを止めて 1 秒ほどしてから拍手 2 回なら反応する", () => {
    const sig = typing(sr, 6, 31);
    // 最後の 2.5 秒は打っていない（typing は最後 0.5 秒あける）ので、その後ろに静かな部屋と拍手を足す
    const tail = scene(sr, 3, claps(sr, [1.2, 1.6]));
    const all = new Float32Array(sig.length + tail.length);
    all.set(sig);
    all.set(tail, sig.length);
    assert.equal(count(all, sr), 1);
  });
});
