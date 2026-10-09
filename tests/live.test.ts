/**
 * リアルタイム音声会話（Gemini Live）のテスト（模擬の Google。本物の Google は使わない）。
 *   - 使い捨ての鍵を作り、API キーは画面に渡さない
 *   - Live 用のモデルを一覧から選ぶ（文字起こし専用・音楽用は選ばない）
 *   - 最初の指示に予定・天気・直前の会話を入れ、画面に出せない隠しタグの説明は入れない
 *   - 声のデータの変換（16bit PCM ⇄ base64）
 *   npm test
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";

const { pickLiveModel, buildLiveInstruction, prepareLive } = await import("../src/integrations/live");
const { buildSetup, int16ToBase64, base64ToFloat32, rateOf } = await import("../src/lib/live-voice");
const { summarizeAction } = await import("../src/lib/live-actions");
const { appUrl } = await import("../src/lib/app-links");
const { toBrowserEvent } = await import("../src/core/browser-actions");

describe("Live 用のモデルを選ぶ", () => {
  const bidi = ["generateContent", "bidiGenerateContent"];
  it("声のまま答えるモデルを選び、文字起こし専用・音楽用・Live 非対応は選ばない", () => {
    const pick = pickLiveModel([
      { name: "models/gemini-3.5-flash", supportedGenerationMethods: ["generateContent"] },
      { name: "models/gemini-3.5-transcribe-live-preview", supportedGenerationMethods: bidi },
      { name: "models/lyria-realtime-exp", supportedGenerationMethods: bidi },
      { name: "models/gemini-2.5-flash-native-audio-preview-12-2025", supportedGenerationMethods: bidi },
      { name: "models/gemini-3.1-flash-live-preview", supportedGenerationMethods: bidi },
    ]);
    assert.equal(pick, "gemini-3.1-flash-live-preview");
  });
  it("Live に使えるモデルが無ければ null", () => {
    assert.equal(pickLiveModel([{ name: "models/gemini-3.5-flash", supportedGenerationMethods: ["generateContent"] }]), null);
  });
});

describe("最初の指示", () => {
  const text = buildLiveInstruction({
    now: new Date("2026-10-09T09:00:00+09:00"),
    timezone: "Asia/Tokyo",
    events: [{ dayLabel: "今日", rangeLabel: "10:00〜11:00", title: "ゼミ" } as never],
    tasks: null,
    reminders: null,
    weather: null,
    recent: [
      { role: "user", content: "明日の天気は？" },
      { role: "assistant", content: "晴れです。" },
    ],
  });
  it("予定・直前の会話・短く話す指示が入る", () => {
    assert.match(text, /ゼミ/);
    assert.match(text, /ユーザー: 明日の天気は？/);
    assert.match(text, /あなた: 晴れです。/);
    assert.match(text, /リアルタイム音声会話/);
  });
  it("K.A.R.E.N. のときは K.A.R.E.N. として話し、制作・編集は道具で画面に頼む", () => {
    const karen = buildLiveInstruction({ now: new Date(), timezone: "Asia/Tokyo", events: null, tasks: null, reminders: null, weather: null, recent: [], persona: "karen" });
    assert.match(karen, /K\.A\.R\.E\.N\./);
    assert.match(karen, /karen_operate/);
    assert.doesNotMatch(text, /karen_operate/, "F.R.I.D.A.Y. のときは入れない");
  });
  it("声では出せない隠しタグの説明は入れない", () => {
    assert.doesNotMatch(text, /隠しタグ|<memory>|<todo-add>/);
  });
});

describe("使い捨ての鍵と宛先（模擬の Google）", () => {
  let server: http.Server;
  const seen: { path: string; key: string | undefined; body: string }[] = [];
  before(async () => {
    server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        seen.push({ path: req.url ?? "", key: req.headers["x-goog-api-key"] as string | undefined, body });
        res.setHeader("Content-Type", "application/json");
        if (req.url?.startsWith("/v1beta/models")) {
          res.end(JSON.stringify({ models: [{ name: "models/gemini-live-test", supportedGenerationMethods: ["bidiGenerateContent"] }] }));
        } else if (req.url === "/v1alpha/auth_tokens" && req.method === "POST") {
          res.end(JSON.stringify({ name: "auth_tokens/abc123" }));
        } else {
          res.statusCode = 404;
          res.end("{}");
        }
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    process.env.GEMINI_API_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1beta`;
    process.env.GEMINI_API_KEY = "secret-key";
    delete process.env.GEMINI_LIVE_MODEL;
  });
  after(() => {
    server.close();
    delete process.env.GEMINI_API_BASE_URL;
    delete process.env.GEMINI_API_KEY;
  });

  it("K.A.R.E.N. は F.R.I.D.A.Y. と違う声で話す", async () => {
    const base = { now: new Date(), timezone: "Asia/Tokyo", events: null, tasks: null, reminders: null, weather: null, recent: [] };
    assert.equal((await prepareLive({ ...base, persona: "karen" })).voiceName, "Aoede");
    assert.equal((await prepareLive(base)).voiceName, null);
  });
  it("鍵入りの宛先とモデルを返し、API キーは返さない", async () => {
    const setup = await prepareLive({ now: new Date(), timezone: "Asia/Tokyo", events: null, tasks: null, reminders: null, weather: null, recent: [] });
    assert.equal(setup.model, "gemini-live-test");
    assert.match(setup.url, /^ws:\/\/127\.0\.0\.1:\d+\/ws\/google\.ai\.generativelanguage\.v1alpha\.GenerativeService\.BidiGenerateContentConstrained\?access_token=auth_tokens%2Fabc123$/);
    assert.doesNotMatch(JSON.stringify(setup), /secret-key/);
    const token = seen.find((s) => s.path === "/v1alpha/auth_tokens");
    assert.equal(token?.key, "secret-key", "鍵を作るときだけサーバーから API キーを使う");
    const body = JSON.parse(token!.body) as { uses: number; expireTime: string; newSessionExpireTime: string };
    assert.equal(body.uses, 1);
    assert.ok(Date.parse(body.newSessionExpireTime) - Date.now() <= 2 * 60_000 + 1000);
  });
});

describe("最初に送る設定と声のデータ", () => {
  it("声で返事・文字起こしあり。細かい設定を受け付けないモデル向けの最小の設定もある", () => {
    const full = buildSetup({ model: "gemini-live-test", systemInstruction: "指示", voiceName: "Kore" }, true).setup;
    assert.equal(full.model, "models/gemini-live-test");
    assert.deepEqual(full.generationConfig.responseModalities, ["AUDIO"]);
    assert.deepEqual(full.inputAudioTranscription, {});
    assert.deepEqual(full.outputAudioTranscription, {});
    assert.ok("tools" in full && "realtimeInputConfig" in full);
    const min = buildSetup({ model: "models/x", systemInstruction: "指示" }, false).setup;
    assert.equal(min.model, "models/x");
    assert.ok(!("realtimeInputConfig" in min) && !("speechConfig" in min.generationConfig));
    assert.doesNotMatch(JSON.stringify(min.tools), /googleSearch/, "最小の設定には検索を入れない（操作の道具だけ）");
  });
  it("K.A.R.E.N. のときは制作の道具を渡す（最小の設定にも入れる）。F.R.I.D.A.Y. には渡さない", () => {
    const names = (setup: { tools?: unknown[] }) => JSON.stringify(setup.tools ?? []);
    assert.match(names(buildSetup({ model: "m", systemInstruction: "i" }, true, "karen").setup), /karen_operate/);
    assert.match(names(buildSetup({ model: "m", systemInstruction: "i" }, false, "karen").setup), /karen_operate/);
    assert.doesNotMatch(names(buildSetup({ model: "m", systemInstruction: "i" }, true).setup), /karen_operate/);
  });
  it("16bit PCM ⇄ base64 で元の音に戻る", () => {
    const src = new Float32Array([0, 0.5, -0.5, 0.999, -1]);
    const back = base64ToFloat32(int16ToBase64(src));
    assert.equal(back.length, src.length);
    for (let i = 0; i < src.length; i++) assert.ok(Math.abs(back[i] - src[i]) < 1e-3, `${i}`);
  });
  it("音声の速さを読み取る", () => {
    assert.equal(rateOf("audio/pcm;rate=24000"), 24000);
    assert.equal(rateOf("audio/pcm"), 24000);
    assert.equal(rateOf("audio/pcm;rate=16000"), 16000);
  });
});

describe("リアルタイム会話からの操作（F.R.I.D.A.Y.）", () => {
  it("F.R.I.D.A.Y. には操作の道具を渡し、最初の指示に使い方を書く", () => {
    assert.match(JSON.stringify(buildSetup({ model: "m", systemInstruction: "i" }, false).setup.tools), /friday_action/);
    const text = buildLiveInstruction({ now: new Date(), timezone: "Asia/Tokyo", events: null, tasks: null, reminders: null, weather: null, recent: [] });
    assert.match(text, /friday_action/);
    assert.doesNotMatch(text, /ここではできない。頼まれたら/, "古い「入力欄で頼んで」の指示は入れない");
    assert.match(text, /断らない/);
  });
  it("操作の結果を短くまとめる（予定・下書き・開けなかったページ）", () => {
    const r = summarizeAction({
      id: "a",
      role: "assistant",
      content: "打ち合わせを入れました。",
      createdAt: 0,
      status: "done",
      calendar: [{ action: "add", ok: true, title: "打ち合わせ", when: "10/14 15:00" }],
      drafts: [{ ok: true, to: "a@example.com", subject: "日程" }],
      tabs: [{ action: "open", ok: true, label: "Spotify", url: "spotify:", blocked: true }],
    });
    assert.equal(r.ok, true);
    assert.equal(r.result, "打ち合わせを入れました。");
    const done = (r.done as string[]).join("\n");
    assert.match(done, /予定の追加：打ち合わせ 10\/14 15:00 成功/);
    assert.match(done, /送信はしていない/);
    assert.match(done, /「開く」ボタン/);
  });
  it("失敗は ok: false と理由", () => {
    const r = summarizeAction({ id: "a", role: "assistant", content: "", createdAt: 0, status: "error", error: { code: "X", message: "つながりません", retryable: true } });
    assert.equal(r.ok, false);
    assert.equal(r.error, "つながりません");
  });
});

describe("パソコンのアプリを開くリンク", () => {
  it("一覧にあるアプリのリンクだけ通す", () => {
    assert.equal(appUrl("spotify:"), "spotify:");
    assert.equal(appUrl("Slack://open"), "slack://open");
    assert.equal(appUrl("javascript:alert(1)"), null);
    assert.equal(appUrl("file:///C:/Windows"), null);
    assert.equal(appUrl("ms-excel:ofe|u|x"), null);
    assert.equal(appUrl("spotify: x"), null);
  });
  it("<open-url> にアプリのリンクを入れると、アプリを開く操作になる（名前も付く）", () => {
    assert.deepEqual(toBrowserEvent("open-url", "spotify:", {}), { type: "browser", action: "open", ok: true, url: "spotify:", label: "Spotify" });
    const bad = toBrowserEvent("open-url", "javascript:alert(1)", {});
    assert.equal(bad.type === "browser" && bad.action === "open" && bad.ok, false);
  });
});

describe("古い版の画面と、断った返事", () => {
  it("画面の版がサーバーと違えば、使い捨ての鍵を作らずに古い版だと返す", async () => {
    const { POST } = await import("../src/app/api/live/route");
    process.env.GEMINI_API_KEY = "k";
    const res = await POST(new Request("http://x/api/live", { method: "POST", body: JSON.stringify({ build: "old-version" }) }));
    const json = (await res.json()) as { ok: boolean; stale?: boolean };
    assert.equal(res.status, 409);
    assert.equal(json.stale, true);
    delete process.env.GEMINI_API_KEY;
  });
});

describe("E.D.I.T.H. のリアルタイム会話", () => {
  it("調べものの道具と操作の道具を渡し、F.R.I.D.A.Y. ・ K.A.R.E.N. とは違う声・指示", async () => {
    const tools = JSON.stringify(buildSetup({ model: "m", systemInstruction: "i" }, true, "edith").setup.tools);
    assert.match(tools, /edith_research/);
    assert.match(tools, /friday_action/);
    assert.doesNotMatch(tools, /karen_operate/);
    const text = buildLiveInstruction({ now: new Date(), timezone: "Asia/Tokyo", events: null, tasks: null, reminders: null, weather: null, recent: [], persona: "edith" });
    assert.match(text, /E\.D\.I\.T\.H\./);
    assert.match(text, /edith_research/);
  });
});
