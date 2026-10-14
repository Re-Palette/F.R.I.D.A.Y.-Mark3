/**
 * 設定した Gemini のモデルがどれも「見つからない」とき、Google の一覧から使えるモデルを選んで答える（模擬の Gemini）。
 *   npm test
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

const { pickTextModels, streamGemini, pingGemini } = await import("../src/llm/gemini");

describe("Gemini：使えるモデルを一覧から選ぶ", () => {
  it("文章を作れる Flash 系だけ。Flash-Lite・新しい版・正式版を優先", () => {
    const list = [
      { name: "models/gemini-4.0-flash-lite", supportedGenerationMethods: ["generateContent"] },
      { name: "models/gemini-4.0-flash", supportedGenerationMethods: ["generateContent"] },
      { name: "models/gemini-4.1-flash-lite-preview", supportedGenerationMethods: ["generateContent"] },
      { name: "models/gemini-4.0-flash-tts", supportedGenerationMethods: ["generateContent"] },
      { name: "models/gemini-4.0-flash-live", supportedGenerationMethods: ["bidiGenerateContent"] },
      { name: "models/text-embedding-005", supportedGenerationMethods: ["embedContent"] },
      { name: "models/gemini-4.0-pro", supportedGenerationMethods: ["generateContent"] },
    ];
    assert.deepEqual(pickTextModels(list), ["gemini-4.0-flash-lite", "gemini-4.1-flash-lite-preview", "gemini-4.0-flash"]);
  });

  it("設定したモデルが 404 なら、一覧のモデルで答える（状態の確認も「つながっている」）", async () => {
    const asked: string[] = [];
    const server = http.createServer((req, res) => {
      asked.push(`${req.method} ${req.url}`);
      if (req.method === "GET" && req.url?.startsWith("/v1beta/models?")) {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ models: [{ name: "models/gemini-9.0-flash-lite", supportedGenerationMethods: ["generateContent"] }] }));
      }
      if (req.url?.includes("gemini-9.0-flash-lite")) {
        if (req.method === "GET") {
          res.writeHead(200, { "content-type": "application/json" });
          return res.end("{}");
        }
        req.resume();
        return req.on("end", () => {
          res.writeHead(200, { "content-type": "text/event-stream" });
          res.end(`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: "こんにちは！" }] }, finishReason: "STOP" }] })}\n\n`);
        });
      }
      req.resume();
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { code: 404, message: "models/x is not found", status: "NOT_FOUND" } }));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    const config = { apiKey: "k", baseUrl: `http://127.0.0.1:${port}/v1beta`, models: ["gone-a", "gone-b"], maxOutputTokens: 100 } as never;
    try {
      let text = "";
      let model = "";
      for await (const c of streamGemini({ config, systemInstruction: "s", contents: [{ role: "user", parts: [{ text: "こんにちは" }] }] })) {
        text += c.text;
        if (c.model) model = c.model;
      }
      assert.equal(text, "こんにちは！");
      assert.equal(model, "gemini-9.0-flash-lite");
      assert.equal(await pingGemini({ ...(config as object), models: ["gone-c"] } as never), null);
    } finally {
      server.close();
    }
  });

  it("設定したモデルが無料枠切れ（429）なら一覧の別のモデルで答え、どれも駄目なら「見つからない」ではなく無料枠切れと伝える", async () => {
    const limit = JSON.stringify({ error: { code: 429, message: "You exceeded your current quota", status: "RESOURCE_EXHAUSTED" } });
    const serve = (answering: string | null) =>
      http.createServer((req, res) => {
        if (req.method === "GET" && req.url?.startsWith("/v1beta/models?")) {
          res.writeHead(200, { "content-type": "application/json" });
          return res.end(
            JSON.stringify({
              models: ["gemini-8.0-flash-lite", "gemini-8.0-flash"].map((n) => ({ name: `models/${n}`, supportedGenerationMethods: ["generateContent"] })),
            }),
          );
        }
        req.resume();
        req.on("end", () => {
          if (answering && req.url?.includes(`/${answering}:`)) {
            res.writeHead(200, { "content-type": "text/event-stream" });
            return res.end(`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: "はい" }] }, finishReason: "STOP" }] })}\n\n`);
          }
          // 最後に試すモデルは 404（以前はこれで「見つからない」と誤って伝えていた）
          if (req.url?.includes("gone-")) {
            res.writeHead(404, { "content-type": "application/json" });
            return res.end(JSON.stringify({ error: { code: 404, message: "not found", status: "NOT_FOUND" } }));
          }
          res.writeHead(429, { "content-type": "application/json" });
          res.end(limit);
        });
      });
    const run = async (answering: string | null, key: string) => {
      const server = serve(answering);
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
      const port = (server.address() as { port: number }).port;
      const config = { apiKey: key, baseUrl: `http://127.0.0.1:${port}/v1beta`, models: [`lim-${key}`, `gone-${key}`], maxOutputTokens: 100 } as never;
      try {
        let text = "";
        let model = "";
        for await (const c of streamGemini({ config, systemInstruction: "s", contents: [{ role: "user", parts: [{ text: "こんにちは" }] }] })) {
          text += c.text;
          if (c.model) model = c.model;
        }
        return { text, model };
      } finally {
        server.close();
      }
    };
    assert.deepEqual(await run("gemini-8.0-flash", "q1"), { text: "はい", model: "gemini-8.0-flash" });
    await assert.rejects(run(null, "q2"), (err: { code?: string }) => err.code === "RATE_LIMITED");
  });
});
