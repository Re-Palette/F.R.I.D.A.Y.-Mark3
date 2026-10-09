/**
 * 無料枠を守るモデルの使い方のテスト。
 *   - 1 日の上限（RPD）で断られたモデルは、枠が戻る西海岸の 0 時まで使わず次のモデルで答える
 *   - 1 分あたりの上限なら少し休ませるだけ
 *   - 既定のモデルは無料枠の多い Flash-Lite から使い、Flash は最後
 *   npm test
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

const { isDailyQuota, nextPacificMidnight, streamGemini, limitedModels } = await import("../src/llm/gemini");
const { getGeminiConfig } = await import("../src/lib/config");

const sse = (text: string) =>
  new Response(`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] })}\n\n`, { status: 200, headers: { "Content-Type": "text/event-stream" } });
const quota429 = (quotaId: string) =>
  new Response(
    JSON.stringify({ error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "quota", details: [{ violations: [{ quotaId }] }] } }),
    { status: 429, headers: { "Content-Type": "application/json" } },
  );

async function ask(models: string[], reply: (model: string) => Response): Promise<{ text: string; called: string[] }> {
  const called: string[] = [];
  const orig = globalThis.fetch;
  globalThis.fetch = (async (url: string) => {
    const model = decodeURIComponent(String(url).match(/models\/([^:]+):/)?.[1] ?? "");
    called.push(model);
    return reply(model);
  }) as typeof fetch;
  try {
    let text = "";
    const config = { ...getGeminiConfig(), apiKey: "test", models, model: models[0], baseUrl: "https://example.test/v1beta" };
    for await (const c of streamGemini({ config, contents: [{ role: "user", parts: [{ text: "hi" }] }] })) text += c.text;
    return { text, called };
  } finally {
    globalThis.fetch = orig;
  }
}

describe("無料枠の上限", () => {
  it("1 日の上限か 1 分の上限かを見分ける", () => {
    assert.equal(isDailyQuota('{"quotaId":"GenerateRequestsPerDayPerProjectPerModel-FreeTier"}'), true);
    assert.equal(isDailyQuota('{"quotaId":"GenerateRequestsPerMinutePerProjectPerModel-FreeTier"}'), false);
  });

  it("次に枠が戻る時刻は 24 時間以内の西海岸の 0 時", () => {
    const now = Date.UTC(2026, 9, 9, 3, 0, 0); // 西海岸は 10/8 20:00（夏時間）
    const next = nextPacificMidnight(now);
    assert.equal(next - now, 4 * 3600_000);
  });

  it("1 日の上限に達したモデルは 0 時まで使わず、次のモデルで答える", async () => {
    const first = await ask(["quota-day-a", "quota-day-b"], (m) => (m === "quota-day-a" ? quota429("GenerateRequestsPerDayPerProjectPerModel-FreeTier") : sse("ok")));
    assert.equal(first.text, "ok");
    assert.deepEqual(first.called, ["quota-day-a", "quota-day-b"]);
    const limited = limitedModels().find((l) => l.model === "quota-day-a");
    assert.ok(limited && limited.until > Date.now() + 15 * 60_000 - 1 && limited.until <= nextPacificMidnight());
    // 2 回目は上限のモデルを試さない（無駄に呼ばない）
    const second = await ask(["quota-day-a", "quota-day-b"], () => sse("again"));
    assert.deepEqual(second.called, ["quota-day-b"]);
  });

  it("1 分の上限なら 10 分ほど休ませるだけ", async () => {
    await ask(["quota-min-a", "quota-min-b"], (m) => (m === "quota-min-a" ? quota429("GenerateRequestsPerMinutePerProjectPerModel-FreeTier") : sse("ok")));
    const limited = limitedModels().find((l) => l.model === "quota-min-a");
    assert.ok(limited && limited.until <= Date.now() + 10 * 60_000 + 1000);
  });
});

describe("既定のモデル", () => {
  it("Flash-Lite を先に使い、1 日の回数が少ない Flash は最後", () => {
    const prev = process.env.GEMINI_MODEL;
    delete process.env.GEMINI_MODEL;
    try {
      const { models } = getGeminiConfig();
      assert.ok(models.length >= 3);
      assert.ok(models.slice(0, -1).every((m) => /lite/.test(m)), models.join(","));
      assert.match(models[models.length - 1], /flash/);
    } finally {
      if (prev !== undefined) process.env.GEMINI_MODEL = prev;
    }
  });
});
