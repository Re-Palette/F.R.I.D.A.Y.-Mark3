/**
 * ニュース（FreeNewsApi）のテスト（模擬の FreeNewsApi・模擬の Gemini。本物には問い合わせない）。
 *   - 返ってきた記事を読み取る（項目名の揺れも受け付ける）
 *   - E.D.I.T.H. の NEWS・通知の見出し・朝のニュースのまとめを、記事から作る（Google 検索は使わない）
 *   - 取れないときは Google 検索に戻す
 *   npm test
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

const fn = await import("../src/integrations/free-news");

const articles = {
  articles: [
    { title: "日銀、金利を据え置き", description: "日本銀行は13日、政策金利を据え置いた。", url: "https://news.example.jp/a", publisher: "例新聞", published_at: "2026-10-14T00:00:00Z" },
    { title: "新型ロケットの打ち上げに成功", description: "種子島から打ち上げ。", url: "https://news.example.jp/b", publisher: "例テレビ", published_at: "2026-10-13T22:00:00Z" },
    { title: "AI の新しい規制案を公表", description: "政府が規制案。", url: "https://news.example.jp/c", publisher: "例経済", published_at: "2026-10-13T20:00:00Z" },
    { title: "重複", url: "https://news.example.jp/a" },
    { title: "x", url: "https://short.example/" },
  ],
};

/** 模擬の Gemini（答えを決めておき、届いた頼みを残す） */
async function fakeGemini(answer: string) {
  const asked: string[] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      asked.push(body);
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: answer }] }, finishReason: "STOP" }] })}\n\n`);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { asked, port: (server.address() as { port: number }).port, close: () => server.close() };
}

/** 模擬の Gemini と模擬の FreeNewsApi の中で動かす */
async function withFakes<T>(answer: string, news: (url: string) => Response, run: (g: { asked: string[]; newsAsked: string[] }) => Promise<T>): Promise<T> {
  const g = await fakeGemini(answer);
  const realFetch = globalThis.fetch;
  const newsAsked: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith("https://freenewsapi.ai/")) {
      newsAsked.push(url);
      return news(url);
    }
    return realFetch(input, init);
  }) as typeof fetch;
  const keys = ["GEMINI_API_BASE_URL", "GEMINI_API_KEY", "FREENEWSAPI", "LANGSEARCH_API_KEY", "BRAVE_SEARCH_API_KEY"] as const;
  const saved = keys.map((k) => process.env[k]);
  process.env.GEMINI_API_BASE_URL = `http://127.0.0.1:${g.port}/v1beta`;
  process.env.GEMINI_API_KEY = "test-key";
  delete process.env.FREENEWSAPI;
  delete process.env.LANGSEARCH_API_KEY;
  delete process.env.BRAVE_SEARCH_API_KEY;
  try {
    return await run({ asked: g.asked, newsAsked });
  } finally {
    globalThis.fetch = realFetch;
    g.close();
    keys.forEach((k, i) => (saved[i] === undefined ? delete process.env[k] : (process.env[k] = saved[i])));
  }
}

describe("FreeNewsApi：記事を読み取る", () => {
  it("項目名の揺れを受け付ける（重複・短すぎる見出し・URL の無いものは除く）", () => {
    const a = fn.parseFreeNews(articles);
    assert.deepEqual(a.map((x) => x.url), ["https://news.example.jp/a", "https://news.example.jp/b", "https://news.example.jp/c"]);
    assert.equal(a[0].source, "例新聞");
    assert.equal(a[0].publishedAt, "2026-10-14T00:00:00.000Z");
    const b = fn.parseFreeNews({ data: { results: [{ headline: "<b>見出し</b> &amp; テスト", link: "https://www.example.com/x", summary: "要約", source: { name: "Example" }, publishedAt: 1760400000 }] } });
    assert.equal(b[0].title, "見出し & テスト");
    assert.equal(b[0].description, "要約");
    assert.equal(b[0].source, "Example");
    assert.equal(b[0].publishedAt, new Date(1760400000 * 1000).toISOString());
    const c = fn.parseFreeNews([{ title: "配列そのものの形", url: "https://www.example.org/y" }]);
    assert.equal(c[0].source, "example.org", "媒体名が無ければドメイン");
    assert.deepEqual(fn.parseFreeNews({ error: "x" }), []);
  });
  it("頼み方：検索語・期間・件数・国・言語を付ける。キーは無くても動き、あれば送る。失敗は例外。同じものは覚えておく", async () => {
    const seen: { url: string; auth: string | null }[] = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => (seen.push({ url, auth: new Headers(init?.headers).get("authorization") }), Response.json(articles))) as never;
    const q = `テスト ${Math.random()}`;
    const out = await fn.freeNews({ q, country: "jp", lang: "ja", size: 5, sort: "date" }, { env: {}, fetchImpl });
    assert.equal(out.length, 3);
    const u = new URL(seen[0].url);
    assert.equal(u.origin + u.pathname, "https://freenewsapi.ai/v1/search");
    assert.equal(u.searchParams.get("q"), q);
    assert.equal(u.searchParams.get("date"), "24h");
    assert.equal(u.searchParams.get("size"), "5");
    assert.equal(u.searchParams.get("country"), "jp");
    assert.equal(u.searchParams.get("lang"), "ja");
    assert.equal(u.searchParams.get("sort"), "date");
    assert.equal(seen[0].auth, null);
    await fn.freeNews({ q, country: "jp", lang: "ja", size: 5, sort: "date" }, { env: {}, fetchImpl });
    assert.equal(seen.length, 1, "同じものは 10 分のあいだ問い合わせない");
    await fn.freeNews({ q: `${q}2` }, { env: { FREENEWSAPI_KEY: "k" }, fetchImpl });
    assert.equal(seen[1].auth, "Bearer k");
    await assert.rejects(fn.freeNews({ q: `${q}3` }, { env: {}, fetchImpl: (async () => new Response("no", { status: 500 })) as never }), /500/);
    assert.deepEqual(await fn.freeNews({ q }, { env: { FREENEWSAPI: "off" }, fetchImpl }), [], "off なら使わない");
  });
  it("今日のニュース：検索語なしで断られたら「ニュース」で探し直す。分野ごとの記事は重複を除く", async () => {
    const asked: URL[] = [];
    const fetchImpl = (async (url: string) => {
      const u = new URL(url);
      asked.push(u);
      if (u.searchParams.get("country") === "jp" && !u.searchParams.get("q")) return new Response("q required", { status: 400 });
      return Response.json(articles);
    }) as never;
    const d = await fn.dailyNews([`AI${Math.random()}`], { env: {}, fetchImpl });
    assert.equal(d.main.length, 3);
    assert.ok(asked.some((u) => u.searchParams.get("q") === "ニュース" && u.searchParams.get("country") === "jp"));
    assert.equal(d.byTopic[0].articles.length, 0, "主なニュースと同じ記事は除く");
  });
});

describe("FreeNewsApi：E.D.I.T.H. の NEWS", () => {
  it("記事から一覧を作る。出典は選んだ記事の本物の URL。番号が無い・範囲外の行は出さない。Google 検索は使わない", async () => {
    const answer = "・[2] 新型ロケット打ち上げ成功｜種子島から打ち上げた｜日本\n・[9] 存在しない記事｜x｜世界\n・番号なし｜y｜世界\n・[1] 日銀が金利据え置き｜政策金利を維持｜日本";
    await withFakes(answer, () => Response.json(articles), async ({ asked, newsAsked }) => {
      const { getEdithNews } = await import("../src/integrations/edith-news");
      const news = await getEdithNews("tech");
      assert.ok(newsAsked.some((u) => new URL(u).searchParams.get("q") === "technology AI"));
      assert.doesNotMatch(asked[0], /googleSearch|google_search/);
      assert.match(asked[0], /新型ロケットの打ち上げに成功/);
      assert.deepEqual(news.items.map((i) => i.title), ["新型ロケット打ち上げ成功", "日銀が金利据え置き"]);
      assert.deepEqual(news.items[0].sources, [{ title: "例テレビ", uri: "https://news.example.jp/b" }]);
      assert.equal(news.items[0].place?.name, "日本");
    });
  });
  it("記事が取れなければ Google 検索で調べる（これまでどおり）", async () => {
    await withFakes("・話題｜要約｜世界", () => new Response("down", { status: 503 }), async ({ asked }) => {
      const { getEdithNews } = await import("../src/integrations/edith-news");
      await getEdithNews("culture").catch(() => null);
      assert.ok(asked.some((b) => /googleSearch|google_search/.test(b)), "Google 検索に戻す");
    });
  });
});

describe("FreeNewsApi：通知の見出し・朝のニュースのまとめ", () => {
  it("通知の見出しを記事から作る（Google 検索は使わない）", async () => {
    await withFakes("・[1] 日銀が金利据え置き\n・ロケット打ち上げ成功\n前置き", () => Response.json(articles), async ({ asked }) => {
      const { newsHeadlines } = await import("../src/integrations/headlines");
      const text = await newsHeadlines([]);
      assert.doesNotMatch(asked[0], /googleSearch|google_search/);
      assert.match(asked[0], /日銀、金利を据え置き/);
      assert.equal(text.split("\n")[0], "・日銀が金利据え置き", "記事の番号は消す");
      assert.match(text, /タップして F\.R\.I\.D\.A\.Y\. で詳しく聞く$/);
    });
  });
  it("朝のニュースのまとめ：今日の記事を渡してまとめさせる（Google 検索は使わない）。出典を返す", async () => {
    await withFakes("今日のニュースです。日銀は金利を据え置きました。", () => Response.json(articles), async ({ asked }) => {
      const { chatAgent } = await import("../src/agents/chat/index");
      const chunks: { text: string; sources?: { title: string; uri: string }[] }[] = [];
      for await (const c of chatAgent.run({
        messages: [{ role: "user", content: "今日のニュースを教えて" }],
        memory: { connected: false, recall: async () => [], save: async () => {} } as never,
        news: { settings: { time: "07:00", topics: [], fromBrain: false }, deliver: "asked", canSave: false },
        now: new Date(),
        timezone: "Asia/Tokyo",
        voice: false,
      } as never))
        chunks.push(c);
      const body = asked.at(-1)!;
      assert.doesNotMatch(body, /googleSearch|google_search/);
      assert.match(body, /今日のニュースの記事（FreeNewsApi/);
      assert.match(body, /日銀、金利を据え置き/);
      assert.ok(chunks.some((c) => c.sources?.some((s) => s.uri === "https://news.example.jp/a")));
    });
  });
});
