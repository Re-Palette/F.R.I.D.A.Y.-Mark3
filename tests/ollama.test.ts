/**
 * Ollama 接続のテスト（模擬の Ollama サーバーを立てて確かめる。本物の Ollama は使わない）。
 *   npm test
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import {
  DEFAULT_OLLAMA_URL,
  hasModel,
  listOllamaModels,
  normalizeOllamaUrl,
  OllamaError,
  streamOllama,
  usesOwnSystem,
} from "../src/llm/ollama";

type Body = { model: string; messages: { role: string; content: string }[]; stream: boolean; think?: boolean; keep_alive?: string; options?: { num_ctx?: number; num_predict?: number } };

let server: http.Server;
let base = "";
const requests: Body[] = [];
/** 次の /api/chat の振る舞い */
let mode: "ok" | "think-inline" | "no-think-support" | "slow" | "stream-error" = "ok";

before(async () => {
  server = http.createServer((req, res) => {
    if (req.url === "/api/tags") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ models: [{ name: "qwen3:0.6b" }, { name: "qwen3:1.7b" }, { name: "friday-fast:latest" }] }));
      return;
    }
    if (req.url === "/api/chat") {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        const body = JSON.parse(raw) as Body;
        requests.push(body);
        if (!["qwen3:0.6b", "qwen3:1.7b", "friday-fast:latest", "friday-fast"].includes(body.model)) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: `model "${body.model}" not found, try pulling it first` }));
          return;
        }
        if (mode === "no-think-support" && body.think !== undefined) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: `"${body.model}" does not support thinking` }));
          return;
        }
        if (mode === "slow") return; // 返事をしない（時間切れの確認）
        res.writeHead(200, { "Content-Type": "application/x-ndjson" });
        const parts = mode === "think-inline" ? ["<think>考え", "中</think>", "こんに", "ちは"] : ["こんに", "ちは。", "元気です"];
        for (const p of parts) res.write(JSON.stringify({ model: body.model, message: { role: "assistant", content: p }, done: false }) + "\n");
        if (mode === "stream-error") {
          res.end(JSON.stringify({ error: "unexpected EOF" }) + "\n");
          return;
        }
        res.end(JSON.stringify({ model: body.model, message: { role: "assistant", content: "" }, done: true, done_reason: "length" }) + "\n");
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  server.closeAllConnections();
  server.close();
});

const collect = async (gen: AsyncGenerator<{ text: string; model?: string; finishReason?: string }>) => {
  let text = "";
  let model: string | undefined;
  let finish: string | undefined;
  for await (const c of gen) {
    text += c.text;
    model ??= c.model;
    if (c.finishReason) finish = c.finishReason;
  }
  return { text, model, finish };
};

describe("接続先", () => {
  it("この PC の中だけにつなぐ（外部の URL は既定に戻す）", () => {
    assert.equal(normalizeOllamaUrl(""), DEFAULT_OLLAMA_URL);
    assert.equal(normalizeOllamaUrl("http://192.168.1.5:11434"), DEFAULT_OLLAMA_URL);
    assert.equal(normalizeOllamaUrl("https://evil.example.com"), DEFAULT_OLLAMA_URL);
    assert.equal(normalizeOllamaUrl("http://127.0.0.1:11434/api/chat"), "http://127.0.0.1:11434");
    assert.equal(normalizeOllamaUrl("http://localhost:11434/"), "http://localhost:11434");
  });
});

describe("モデル", () => {
  it("インストール済みのモデルの一覧を読む", async () => {
    assert.deepEqual(await listOllamaModels(base), ["qwen3:0.6b", "qwen3:1.7b", "friday-fast:latest"]);
  });
  it("つながらないときは null", async () => {
    assert.equal(await listOllamaModels("http://127.0.0.1:1"), null);
  });
  it(":latest の有無を同じとみなす", () => {
    assert.ok(hasModel(["friday-fast:latest"], "friday-fast"));
    assert.ok(hasModel(["qwen3:0.6b"], "qwen3:0.6b"));
    assert.ok(!hasModel(["qwen3:0.6b"], "qwen3:1.7b"));
  });
  it("friday-fast は自分の指示（SYSTEM）を使う", () => {
    assert.ok(usesOwnSystem("friday-fast:latest"));
    assert.ok(usesOwnSystem("friday-fast"));
    assert.ok(!usesOwnSystem("qwen3:0.6b"));
  });
});

describe("会話", () => {
  it("決めた設定で送り、少しずつ受け取る", async () => {
    mode = "ok";
    requests.length = 0;
    const r = await collect(
      streamOllama({ baseUrl: base, model: "qwen3:0.6b", numPredict: 60 }, { system: "日本語で答える", messages: [{ role: "user", content: "やあ" }] }),
    );
    assert.equal(r.text, "こんにちは。元気です");
    assert.equal(r.model, "qwen3:0.6b");
    assert.equal(r.finish, "MAX_TOKENS");
    const body = requests[0];
    assert.equal(body.stream, true);
    assert.equal(body.think, false);
    assert.equal(body.keep_alive, "30m");
    assert.equal(body.options?.num_ctx, 2048);
    assert.equal(body.options?.num_predict, 60);
    assert.deepEqual(body.messages[0], { role: "system", content: "日本語で答える" });
  });
  it("返事の長さ 120 を送る", async () => {
    mode = "ok";
    requests.length = 0;
    await collect(streamOllama({ baseUrl: base, model: "qwen3:1.7b", numPredict: 120 }, { system: "x", messages: [{ role: "user", content: "a" }] }));
    assert.equal(requests[0].options?.num_predict, 120);
    assert.equal(requests[0].model, "qwen3:1.7b");
  });
  it("friday-fast には FRIDAY の指示を送らない", async () => {
    mode = "ok";
    requests.length = 0;
    await collect(streamOllama({ baseUrl: base, model: "friday-fast:latest", numPredict: 60 }, { system: "FRIDAY の指示", messages: [{ role: "user", content: "a" }] }));
    assert.ok(requests[0].messages.every((m) => m.role !== "system"));
  });
  it("本文に混ざった考えた文（<think>）を取り除く", async () => {
    mode = "think-inline";
    const r = await collect(streamOllama({ baseUrl: base, model: "qwen3:0.6b", numPredict: 60 }, { system: "x", messages: [{ role: "user", content: "a" }] }));
    assert.equal(r.text, "こんにちは");
  });
  it("「考える」を止められないモデルには think を付けずに送り直す", async () => {
    mode = "no-think-support";
    requests.length = 0;
    const r = await collect(streamOllama({ baseUrl: base, model: "qwen3:0.6b", numPredict: 60 }, { system: "x", messages: [{ role: "user", content: "a" }] }));
    assert.equal(r.text, "こんにちは。元気です");
    assert.equal(requests.length, 2);
    assert.equal(requests[1].think, undefined);
  });
});

describe("失敗", () => {
  const expectCode = async (p: Promise<unknown>, code: string) => {
    await assert.rejects(p, (err: unknown) => err instanceof OllamaError && err.code === code);
  };
  it("モデル未導入", async () => {
    mode = "ok";
    await expectCode(collect(streamOllama({ baseUrl: base, model: "llama9:99b", numPredict: 60 }, { system: "x", messages: [{ role: "user", content: "a" }] })), "OLLAMA_NO_MODEL");
  });
  it("起動していない", async () => {
    await expectCode(collect(streamOllama({ baseUrl: "http://127.0.0.1:1", model: "qwen3:0.6b", numPredict: 60 }, { system: "x", messages: [{ role: "user", content: "a" }] })), "OLLAMA_UNAVAILABLE");
  });
  it("時間切れ", async () => {
    mode = "slow";
    await expectCode(
      collect(streamOllama({ baseUrl: base, model: "qwen3:0.6b", numPredict: 60, firstTokenMs: 300 }, { system: "x", messages: [{ role: "user", content: "a" }] })),
      "OLLAMA_TIMEOUT",
    );
  });
  it("返事の途中のエラー", async () => {
    mode = "stream-error";
    await expectCode(collect(streamOllama({ baseUrl: base, model: "qwen3:0.6b", numPredict: 60 }, { system: "x", messages: [{ role: "user", content: "a" }] })), "OLLAMA_ERROR");
  });
  it("ユーザーが止めたときは時間切れ扱いにしない", async () => {
    mode = "slow";
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 100);
    await assert.rejects(
      collect(streamOllama({ baseUrl: base, model: "qwen3:0.6b", numPredict: 60, firstTokenMs: 5000 }, { system: "x", messages: [{ role: "user", content: "a" }], signal: ctrl.signal })),
      (err: unknown) => !(err instanceof OllamaError),
    );
  });
});
