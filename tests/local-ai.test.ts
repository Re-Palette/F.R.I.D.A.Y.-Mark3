/**
 * ローカル AI を Ollama に一本化したことのテスト（模擬の Ollama サーバー。本物の Ollama は使わない）。
 *   - 以前の版で保存した設定（使う先＝LM Studio・LM Studio のモデル）があっても Ollama を使う
 *   - 接続先は Ollama（この PC の中だけ）。サーバーを PC で動かすときの切り替えも Ollama だけ
 *   - 設定のモデル・返事の長さで Ollama に送る
 *   npm test
 */
import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";

// 画面の localStorage の代わり
const store = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, String(v)),
  removeItem: (k: string) => void store.delete(k),
};

const { checkLocalAi, localAiConfig, localAiPrefs, rememberLocalAiConfig, saveLocalAiPrefs, streamLocal, DEFAULT_PREFS } = await import("../src/lib/local-ai");
const { serverLocalAi } = await import("../src/lib/config");

let server: http.Server;
let base = "";
const bodies: { model: string; options?: { num_predict?: number } }[] = [];

before(async () => {
  server = http.createServer((req, res) => {
    if (req.url === "/api/tags") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ models: [{ name: "qwen3:0.6b" }, { name: "qwen3:1.7b" }] }));
      return;
    }
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const b = JSON.parse(raw);
      bodies.push(b);
      res.writeHead(200, { "Content-Type": "application/x-ndjson" });
      res.end(JSON.stringify({ model: b.model, message: { content: "はい" }, done: true, done_reason: "stop" }) + "\n");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => {
  server.closeAllConnections();
  server.close();
});
beforeEach(() => store.clear());

describe("設定", () => {
  it("何も保存していなければ Ollama の既定（qwen3:0.6b・短い 60・短い会話はローカル・考えない）", () => {
    assert.deepEqual(localAiPrefs(), DEFAULT_PREFS);
    assert.equal(localAiConfig().model, "qwen3:0.6b");
    assert.equal(localAiConfig().baseUrl, "http://localhost:11434");
  });
  it("以前の版の設定（使う先 LM Studio・LM Studio のモデル）が残っていても Ollama を使う", () => {
    store.set("friday.localai.prefs.v1", JSON.stringify({ engine: "lmstudio", model: "qwen/qwen3.5-2b", thinking: false }));
    store.set("friday.localai.v1", JSON.stringify({ baseUrl: "http://localhost:1234/v1", model: "qwen/qwen3.5-9b" }));
    const cfg = localAiConfig();
    assert.equal(cfg.baseUrl, "http://localhost:11434");
    assert.equal(cfg.model, "qwen3:0.6b");
    assert.ok(!("engine" in cfg));
  });
  it("選んだモデル・返事の長さ 120 を使う", () => {
    saveLocalAiPrefs({ ...DEFAULT_PREFS, ollamaModel: "qwen3:1.7b", replyLength: 120 });
    assert.equal(localAiConfig().model, "qwen3:1.7b");
    assert.equal(localAiConfig().replyLength, 120);
  });
  it("サーバーの OLLAMA_MODEL を既定にし、外部の URL は使わない", () => {
    rememberLocalAiConfig({ ollamaBaseUrl: "https://evil.example.com", ollamaModel: "friday-fast:latest" });
    assert.equal(localAiConfig().baseUrl, "http://localhost:11434");
    assert.equal(localAiConfig().model, "friday-fast:latest");
  });
});

describe("接続", () => {
  it("選んだモデルが入っていれば使える／無ければ「モデル未導入」", async () => {
    rememberLocalAiConfig({ ollamaBaseUrl: base });
    assert.deepEqual(await checkLocalAi(), { ok: true, model: "qwen3:0.6b" });
    saveLocalAiPrefs({ ...DEFAULT_PREFS, ollamaModel: "llama9:99b" });
    const r = await checkLocalAi();
    assert.equal(r.ok, false);
    assert.equal(r.problem, "no-model");
  });
  it("起動していなければ「接続できない」", async () => {
    rememberLocalAiConfig({ ollamaBaseUrl: "http://127.0.0.1:1" });
    const r = await checkLocalAi();
    assert.equal(r.problem, "unavailable");
  });
  it("短い会話は設定の返事の長さ（num_predict）で Ollama に送る", async () => {
    rememberLocalAiConfig({ ollamaBaseUrl: base });
    saveLocalAiPrefs({ ...DEFAULT_PREFS, replyLength: 120 });
    bodies.length = 0;
    let text = "";
    for await (const c of streamLocal({ system: "日本語", messages: [{ role: "user", content: "やあ" }] })) text += c.text;
    assert.equal(text, "はい");
    assert.equal(bodies[0].options?.num_predict, 120);
    assert.equal(bodies[0].model, "qwen3:0.6b");
  });
});

describe("サーバーを PC で動かすときの切り替え先", () => {
  const keep = { ...process.env };
  after(() => {
    process.env = keep;
  });
  it("Vercel 上では使わない", () => {
    process.env = { ...keep, VERCEL: "1", OLLAMA_BASE_URL: "http://localhost:11434" };
    assert.equal(serverLocalAi(), null);
  });
  it("OLLAMA_BASE_URL があれば Ollama", () => {
    process.env = { ...keep, OLLAMA_BASE_URL: "http://127.0.0.1:11434", OLLAMA_MODEL: "qwen3:1.7b" };
    delete process.env.VERCEL;
    assert.deepEqual(serverLocalAi(), { baseUrl: "http://127.0.0.1:11434", model: "qwen3:1.7b" });
  });
  it("LM Studio の設定（LM_STUDIO_BASE_URL）だけでは切り替えない", () => {
    process.env = { ...keep, LM_STUDIO_BASE_URL: "http://localhost:1234/v1" };
    delete process.env.VERCEL;
    delete process.env.OLLAMA_BASE_URL;
    delete process.env.FRIDAY_LOCAL_AI;
    assert.equal(serverLocalAi(), null);
  });
});
