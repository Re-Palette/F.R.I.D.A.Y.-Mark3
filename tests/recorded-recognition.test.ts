/**
 * スマホ用の聞き取り（RecordedRecognition）：マイクの音を偽物にして、/api/stt へ送る回数・大きさと、渡す結果を確かめる。
 *   - 話す → 短い間 → 続けて話す、を繰り返しても、同じ発言を何度も送り直さない（先送りは 1 発言につき 1 回まで）
 *   - 話し終わったときは、発言の全部を文字にする（途中までの先送りの結果で済ませない）
 *   - 呼びかけ待ち（wake）・声紋の確認・送信の失敗・声のまま渡す（onaudio）は今までどおり
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { RecordedRecognition } from "@/lib/recorded-recognition";

const SAMPLE_RATE = 48_000;
const FRAME = 2048;
const FRAME_MS = (FRAME / SAMPLE_RATE) * 1000;

/** 偽のマイク：作られた音の処理（ScriptProcessor）に、テストから音を流し込む */
let processors: { onaudioprocess: ((e: unknown) => void) | null }[] = [];
class FakeAudioContext {
  sampleRate = SAMPLE_RATE;
  state = "running";
  destination = {};
  resume() {
    return Promise.resolve();
  }
  createMediaStreamSource() {
    return { connect() {}, disconnect() {} };
  }
  createGain() {
    return { gain: { value: 1 }, connect() {}, disconnect() {} };
  }
  createScriptProcessor() {
    const p = { onaudioprocess: null as ((e: unknown) => void) | null, connect() {}, disconnect() {} };
    processors.push(p);
    return p;
  }
}

/** 送った /api/stt（POST）の記録。delayMs 後に返事（取り消されたら AbortError） */
interface Sent {
  purpose: string;
  bodyBytes: number;
  wavBytes: number;
  aborted: boolean;
}
let sent: Sent[] = [];
let fail = false;
const realFetch = globalThis.fetch;
const realNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");

function installFakes(delayMs = 30) {
  processors = [];
  sent = [];
  fail = false;
  (globalThis as unknown as { AudioContext: unknown }).AudioContext = FakeAudioContext;
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }], getAudioTracks: () => [] }) } },
  });
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    if (!init || init.method !== "POST") return new Response(null, { status: 204 });
    const body = String(init.body);
    const json = JSON.parse(body) as { audio: string; purpose: string };
    const wavBytes = Buffer.from(json.audio, "base64").length;
    const rec: Sent = { purpose: json.purpose, bodyBytes: Buffer.byteLength(body), wavBytes, aborted: false };
    sent.push(rec);
    // 送った分はもう届いている（取り消しても、送った量は減らない）として数える
    return new Promise<Response>((resolve, reject) => {
      const t = setTimeout(() => {
        if (fail) resolve(Response.json({ ok: false, error: "x" }, { status: 502 }));
        // 文字にした結果に、受け取った音声の長さを入れておく（全部を文字にしたかを確かめるため）
        else resolve(Response.json({ ok: true, text: `wav${wavBytes}` }));
      }, delayMs);
      init.signal?.addEventListener("abort", () => {
        clearTimeout(t);
        rec.aborted = true;
        reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
      });
    });
  }) as typeof fetch;
}

function restore() {
  globalThis.fetch = realFetch;
  if (realNavigator) Object.defineProperty(globalThis, "navigator", realNavigator);
  delete (globalThis as unknown as { AudioContext?: unknown }).AudioContext;
}

const tick = () => new Promise((r) => setImmediate(r));

/** 声（大きな音）と無音を、ms の長さで流し込む。1 コマごとに少し待つ（送信の返事が途中で届くように） */
async function feed(segments: [loud: boolean, ms: number][]) {
  for (let i = 0; i < 50 && !processors.length; i++) await tick();
  const p = processors[processors.length - 1];
  assert.ok(p, "マイクの処理が作られていない");
  for (const [loud, ms] of segments) {
    const n = Math.round(ms / FRAME_MS);
    for (let i = 0; i < n; i++) {
      const data = new Float32Array(FRAME).fill(loud ? 0.2 : 0);
      p.onaudioprocess?.({ inputBuffer: { getChannelData: () => data } });
      await tick();
    }
  }
}

/** 1 発言を聞き取って、結果（文字・エラー）が出て終わるまで待つ */
async function listen(rec: RecordedRecognition, segments: [boolean, number][]) {
  const out: { texts: string[]; errors: string[]; audio: { data: string }[]; ended: boolean } = { texts: [], errors: [], audio: [], ended: false };
  rec.onresult = (e) => out.texts.push(e.results[0][0].transcript);
  rec.onerror = (e) => out.errors.push(e.error);
  rec.onend = () => (out.ended = true);
  rec.start();
  await feed(segments);
  for (let i = 0; i < 400 && !out.ended; i++) await new Promise((r) => setTimeout(r, 5));
  // 結果が出たあとの片付けを待つ
  await new Promise((r) => setTimeout(r, 60));
  return out;
}

/** 16kHz・16bit の WAV の大きさ（ヘッダー 44 バイト）から、何ミリ秒分の音声かを出す */
const wavMs = (bytes: number) => ((bytes - 44) / 2 / 16_000) * 1000;

/** 話す → 短い間（先送りが始まる 0.2 秒より長く、話し終わりの 0.65 秒より短い）→ 続けて話す、を 4 回 */
const CHOPPY: [boolean, number][] = [
  [true, 700],
  [false, 350],
  [true, 700],
  [false, 350],
  [true, 700],
  [false, 350],
  [true, 700],
  [false, 900],
];

const report = (label: string) => {
  const posts = sent.length;
  const bytes = sent.reduce((n, s) => n + s.bodyBytes, 0);
  console.log(`[stt] ${label}: 送信 ${posts} 回 / ${bytes} バイト（取り消し ${sent.filter((s) => s.aborted).length} 回）`);
  return { posts, bytes };
};

describe("スマホの聞き取り：同じ発言の送り直し", () => {
  beforeEach(() => installFakes());
  afterEach(restore);

  it("話す→間→続けて話すを繰り返しても、先送りは 1 回まで（最後に全部を 1 回送る）", async () => {
    const rec = new RecordedRecognition();
    const out = await listen(rec, CHOPPY);
    const { posts } = report("間をあけて 4 回に分けて話す");
    assert.deepEqual(out.errors, []);
    assert.equal(out.texts.length, 1);
    assert.ok(posts <= 2, `送信が ${posts} 回（先送り 1 回 + 最後の 1 回まで）`);
  });

  it("話し終わったときは、発言の全部が文字にされる（途中までの結果を使わない）", async () => {
    const rec = new RecordedRecognition();
    const out = await listen(rec, CHOPPY);
    const last = sent[sent.length - 1];
    // 声の部分だけで 2.8 秒（＋前後の無音）。全部が入っていること
    assert.ok(wavMs(last.wavBytes) >= 2800, `最後に送った音声が ${Math.round(wavMs(last.wavBytes))}ms しかない`);
    assert.equal(out.texts[0], `wav${last.wavBytes}`);
  });

  it("間をあけずに話して終わったときは、先送りの結果をそのまま使う（送信は 1 回）", async () => {
    const rec = new RecordedRecognition();
    const out = await listen(rec, [
      [true, 1200],
      [false, 900],
    ]);
    report("間をあけずに 1 回で話す");
    assert.equal(sent.length, 1);
    assert.equal(out.texts.length, 1);
    assert.equal(out.texts[0], `wav${sent[0].wavBytes}`);
  });

  it("呼びかけ待ち（wake）の間は、短い物音（せき・ドア）を送らない", async () => {
    const rec = new RecordedRecognition();
    rec.purpose = "wake";
    const out = await listen(rec, [
      [true, 130],
      [false, 900],
    ]);
    assert.equal(sent.length, 0);
    assert.deepEqual(out.texts, []);
    assert.deepEqual(out.errors, []);
    assert.ok(out.ended);
  });

  it("呼びかけ待ちでも、呼びかけの長さ（約 0.5 秒）の声は送る", async () => {
    const rec = new RecordedRecognition();
    rec.purpose = "wake";
    const out = await listen(rec, [
      [true, 500],
      [false, 900],
    ]);
    assert.equal(sent.length, 1);
    assert.equal(out.texts.length, 1);
  });

  // 会話中（talk）は、短い返事（はい・うん）を取りこぼさないよう、短い音も今までどおり送る。
  // 話し始めの前の余白（約 0.35 秒）も長さに数えるので、物音も送られる（返事と物音を見分けられないため、今回は変えない）
  it("会話中（talk）は、短い音も今までどおり送る（短い返事を取りこぼさない）", async () => {
    const rec = new RecordedRecognition();
    const out = await listen(rec, [
      [true, 130],
      [false, 900],
    ]);
    assert.equal(sent.length, 1);
    assert.equal(out.texts.length, 1);
  });
});

describe("スマホの聞き取り：今までどおりの動き", () => {
  beforeEach(() => installFakes());
  afterEach(restore);

  it("呼びかけ待ち（wake）は、その用途で送る", async () => {
    const rec = new RecordedRecognition();
    rec.purpose = "wake";
    const out = await listen(rec, CHOPPY);
    assert.ok(sent.length >= 1 && sent.every((s) => s.purpose === "wake"));
    assert.equal(out.texts.length, 1);
  });

  it("声紋の確認で本人でなければ、結果を渡さない", async () => {
    const rec = new RecordedRecognition();
    rec.verify = async () => false;
    const out = await listen(rec, CHOPPY);
    assert.deepEqual(out.texts, []);
    assert.deepEqual(out.errors, []);
    assert.ok(out.ended);
  });

  it("声紋の確認で本人なら、全部を文字にして渡す", async () => {
    const rec = new RecordedRecognition();
    rec.verify = async () => true;
    const out = await listen(rec, CHOPPY);
    assert.equal(out.texts.length, 1);
    assert.ok(wavMs(sent[sent.length - 1].wavBytes) >= 2800);
  });

  it("文字にするのに失敗したら、エラー（network）を知らせて終わる", async () => {
    fail = true;
    const rec = new RecordedRecognition();
    const out = await listen(rec, CHOPPY);
    assert.deepEqual(out.texts, []);
    assert.deepEqual(out.errors, ["network"]);
    assert.ok(out.ended);
  });

  it("声のまま渡す（onaudio）ときは /api/stt に送らず、発言の全部を 1 回だけ渡す", async () => {
    const rec = new RecordedRecognition();
    const got: { data: string }[] = [];
    rec.onaudio = (a) => got.push(a);
    const out = await listen(rec, CHOPPY);
    assert.equal(sent.length, 0);
    assert.equal(got.length, 1);
    assert.ok(wavMs(Buffer.from(got[0].data, "base64").length) >= 2800);
    assert.ok(out.ended);
  });
});
