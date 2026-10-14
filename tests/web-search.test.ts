/**
 * 調べもの（Web 検索 API：LangSearch・Brave）のテスト（模擬の検索 API。本物には問い合わせない）。
 *   - 発言から検索の言葉を作る（頼む言葉を取る・続きの質問は前の発言を補う）
 *   - 検索結果を読み取り、AI に渡す（要約の指示つき）。LangSearch を優先する
 *   - ふだんの会話（検索が要らない発言）は検索しない
 *   - リアルタイム音声会話では Google 検索の代わりに web_search を渡す
 *   npm test
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

const ws = await import("../src/integrations/web-search");
const { buildSetup } = await import("../src/lib/live-voice");
const { buildLiveInstruction } = await import("../src/integrations/live");
const route = await import("../src/app/api/search/route");

const lang = {
  code: 200,
  msg: null,
  data: {
    webPages: {
      value: [
        { name: "日銀、金利を据え置き", url: "https://news.example.jp/a", text: "日本銀行は<b>13日</b>、政策金利を 0.5% に据え置いた。", datePublished: "2026-10-13T09:00:00+09:00" },
        { name: "日本銀行 &amp; 金融政策", url: "https://www.boj.or.jp/", snippet: "金融政策決定会合の結果" },
        { name: "重複", url: "https://news.example.jp/a", text: "同じページ" },
        { name: "", url: "https://empty.example/", text: "見出しなし" },
      ],
    },
  },
};
const brave = {
  news: { results: [{ title: "日銀、金利を据え置き", url: "https://news.example.jp/a", description: "日本銀行は<strong>13日</strong>…", age: "2 時間前" }] },
  web: { results: [{ title: "日本銀行", url: "https://www.boj.or.jp/", description: "金融政策決定会合の結果", extra_snippets: ["政策金利は 0.5%"] }] },
};

describe("Web 検索：検索の言葉", () => {
  it("頼む言葉・呼びかけを取る", () => {
    assert.equal(ws.searchQuery("フライデー、今日の日経平均について調べて"), "今日の日経平均");
    assert.equal(ws.searchQuery("東京の天気予報を検索してください"), "東京の天気予報");
    assert.equal(ws.searchQuery("iPhone 18 の発売日は？"), "iPhone 18 の発売日は？");
  });
  it("続きの質問は、ひとつ前の発言を補う", () => {
    assert.equal(ws.searchQuery("それの値段は？", "iPhone 18 の発売日は？"), "iPhone 18 の発売日は？ それの値段は？");
    assert.equal(ws.searchQuery("大谷翔平の今日の成績", "さっきの話"), "大谷翔平の今日の成績");
  });
});

describe("Web 検索：検索する", () => {
  it("どの API を使うか：LangSearch を優先。キーが無ければ検索しない", async () => {
    assert.equal(ws.searchProvider({ LANGSEARCH_API_KEY: "lk", BRAVE_SEARCH_API_KEY: "bk" }), "langsearch");
    assert.equal(ws.searchProvider({ BRAVE_SEARCH_API_KEY: "bk" }), "brave");
    assert.equal(ws.searchProvider({}), null);
    let called = false;
    assert.equal(await ws.webSearch("x", { env: {}, fetchImpl: (async () => ((called = true), new Response("{}"))) as never }), null);
    assert.equal(called, false);
  });
  it("LangSearch：本文つきで検索し、結果を読み取る（重複・見出しなしは除く・タグを取る）。同じ検索は覚えておく", async () => {
    let calls = 0;
    let seen: { url: string; auth: string | null; body: Record<string, unknown> } | null = null;
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      calls++;
      seen = { url, auth: new Headers(init?.headers).get("authorization"), body: JSON.parse(String(init?.body)) };
      return Response.json(lang);
    }) as never;
    const q = `日銀 金利 ${Math.random()}`;
    const out = await ws.webSearch(q, { env: { LANGSEARCH_API_KEY: "lk" }, fetchImpl });
    assert.ok(out);
    assert.equal(out.provider, "langsearch");
    assert.equal(seen!.url, "https://api.langsearch.com/v1/web-search");
    assert.equal(seen!.auth, "Bearer lk");
    assert.equal(seen!.body.query, q);
    assert.deepEqual(seen!.body.contents, { text: { max_characters: 1200 } });
    assert.equal(seen!.body.freshness, undefined, "ニュース・今日のこと以外は期間を絞らない");
    assert.deepEqual(out.results.map((r) => r.url), ["https://news.example.jp/a", "https://www.boj.or.jp/"]);
    assert.equal(out.results[0].snippet, "日本銀行は13日、政策金利を 0.5% に据え置いた。");
    assert.equal(out.results[0].age, "2026-10-13");
    assert.equal(out.results[1].title, "日本銀行 & 金融政策");
    assert.equal(out.results[1].snippet, "金融政策決定会合の結果");
    await ws.webSearch(q, { env: { LANGSEARCH_API_KEY: "lk" }, fetchImpl });
    assert.equal(calls, 1, "同じ検索は 10 分のあいだ問い合わせない");
  });
  it("LangSearch：ニュース・今日のことは 1 週間以内に絞る", async () => {
    let body: Record<string, unknown> = {};
    await ws.webSearch(`今日のニュース ${Math.random()}`, {
      env: { LANGSEARCH_API_KEY: "lk" },
      fetchImpl: (async (_u: string, init?: RequestInit) => ((body = JSON.parse(String(init?.body))), Response.json(lang))) as never,
    });
    assert.equal(body.freshness, "oneWeek");
  });
  it("LangSearch がエラーを返したら失敗にする（呼ぶ側が Google 検索に戻す）", async () => {
    const env = { LANGSEARCH_API_KEY: "lk" };
    await assert.rejects(ws.webSearch(`e1 ${Math.random()}`, { env, fetchImpl: (async () => new Response("no", { status: 429 })) as never }), /429/);
    await assert.rejects(ws.webSearch(`e2 ${Math.random()}`, { env, fetchImpl: (async () => Response.json({ code: 401, msg: "Invalid API key" })) as never }), /Invalid API key/);
  });
  it("Brave：LangSearch のキーが無いときは Brave で検索する", async () => {
    let seen: { url: string; key: string | null } | null = null;
    const out = await ws.webSearch(`日銀 ${Math.random()}`, {
      env: { BRAVE_SEARCH_API_KEY: "bk" },
      fetchImpl: (async (url: string, init?: RequestInit) => ((seen = { url, key: new Headers(init?.headers).get("x-subscription-token") }), Response.json(brave))) as never,
    });
    assert.ok(out);
    assert.equal(out.provider, "brave");
    assert.match(seen!.url, /^https:\/\/api\.search\.brave\.com\/res\/v1\/web\/search\?/);
    assert.equal(seen!.key, "bk");
    assert.deepEqual(out.results.map((r) => r.url), ["https://news.example.jp/a", "https://www.boj.or.jp/"]);
    assert.equal(out.results[0].news, true);
    assert.equal(out.results[0].snippet, "日本銀行は13日…");
    assert.match(out.results[1].snippet, /金融政策決定会合の結果 … 政策金利は 0\.5%/);
  });
  it("AI に渡す説明：検索結果を要約して答える指示と、結果の中身", () => {
    const text = ws.searchSection({ query: "日銀 金利", provider: "langsearch", results: [{ title: "日銀、金利を据え置き", url: "https://news.example.jp/a", snippet: "政策金利は 0.5%", age: "2026-10-13", news: false }] });
    assert.match(text, /LangSearch/);
    assert.match(text, /要約/);
    assert.match(text, /いつもの会話のまま/);
    assert.match(text, /書かれていないことは足さない/);
    assert.match(text, /\[1\] 日銀、金利を据え置き（2026-10-13）\nnews\.example\.jp\n政策金利は 0\.5%/);
    assert.doesNotMatch(text, /https:\/\//, "URL は本文に書かせない");
  });
});

describe("Web 検索：リアルタイム音声会話", () => {
  const prep = { model: "m", systemInstruction: "i" };
  it("検索 API があれば Google 検索の代わりに web_search を渡す", () => {
    const on = JSON.stringify(buildSetup(prep, true, undefined, true).setup.tools);
    assert.match(on, /web_search/);
    assert.doesNotMatch(on, /googleSearch/);
    assert.match(on, /friday_action/);
    const off = JSON.stringify(buildSetup(prep, true).setup.tools);
    assert.match(off, /googleSearch/);
    assert.doesNotMatch(off, /web_search/);
  });
  it("最初の指示：検索 API のときは web_search で調べて要約するよう伝える", () => {
    const base = { now: new Date(), timezone: "Asia/Tokyo", events: null, tasks: null, reminders: null, weather: null, recent: [] };
    const on = buildLiveInstruction({ ...base, persona: "edith", searchApi: "langsearch" });
    assert.match(on, /web_search を呼ぶ/);
    assert.match(on, /LangSearch/);
    assert.match(on, /要約/);
    assert.doesNotMatch(on, /Google 検索/);
    assert.match(buildLiveInstruction({ ...base, searchApi: null }), /Google 検索/);
  });
  it("/api/search：言葉が空なら 400、キーが無ければ 503", async () => {
    assert.equal((await route.GET(new Request("http://x/api/search?q="))).status, 400);
    const keys = ["LANGSEARCH_API_KEY", "BRAVE_SEARCH_API_KEY", "BRAVE_API_KEY"] as const;
    const saved = keys.map((k) => process.env[k]);
    for (const k of keys) delete process.env[k];
    try {
      assert.equal((await route.GET(new Request("http://x/api/search?q=test"))).status, 503);
    } finally {
      keys.forEach((k, i) => saved[i] !== undefined && (process.env[k] = saved[i]));
    }
  });
});

describe("Web 検索：文字の会話", () => {
  /** 模擬の Gemini と、模擬の LangSearch で 1 回会話する */
  async function talk(content: string) {
    let asked = "";
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        asked = body;
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: "日銀は金利を据え置きました。" }] }, finishReason: "STOP" }] })}\n\n`);
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    const realFetch = globalThis.fetch;
    let searched: Record<string, unknown> | null = null;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.startsWith("https://api.langsearch.com/")) {
        searched = JSON.parse(String(init?.body));
        return Response.json(lang);
      }
      return realFetch(input, init);
    }) as typeof fetch;
    const keys = ["GEMINI_API_BASE_URL", "GEMINI_API_KEY", "LANGSEARCH_API_KEY"] as const;
    const saved = keys.map((k) => process.env[k]);
    process.env.GEMINI_API_BASE_URL = `http://127.0.0.1:${port}/v1beta`;
    process.env.GEMINI_API_KEY = "test-key";
    process.env.LANGSEARCH_API_KEY = "lk";
    try {
      const { chatAgent } = await import("../src/agents/chat/index");
      const chunks: { text: string; sources?: { title: string; uri: string }[] }[] = [];
      for await (const c of chatAgent.run({
        messages: [{ role: "user", content }],
        memory: { connected: false, recall: async () => [], save: async () => {} } as never,
        now: new Date(),
        timezone: "Asia/Tokyo",
        voice: false,
      } as never))
        chunks.push(c);
      return { asked, searched: searched as Record<string, unknown> | null, chunks };
    } finally {
      globalThis.fetch = realFetch;
      server.close();
      keys.forEach((k, i) => (saved[i] === undefined ? delete process.env[k] : (process.env[k] = saved[i])));
    }
  }

  it("調べものは LangSearch で検索し、結果を Gemini に渡して要約させる（Google 検索は使わない）。出典を返す", async () => {
    const { asked, searched, chunks } = await talk(`${Math.random().toString(36).slice(2, 6)} 日銀の最新の金利について調べて`);
    assert.match(String(searched?.query), /日銀の最新の金利/, "LangSearch に検索の言葉を送る");
    assert.doesNotMatch(String(searched?.query), /調べて/, "「調べて」は検索の言葉に入れない");
    assert.doesNotMatch(asked, /googleSearch|google_search/, "Google 検索の道具は渡さない");
    assert.match(asked, /LangSearch/);
    assert.match(asked, /日銀、金利を据え置き/);
    assert.deepEqual(chunks.find((c) => c.sources)?.sources?.map((s) => s.uri), ["https://news.example.jp/a", "https://www.boj.or.jp/"]);
    assert.match(chunks.map((c) => c.text).join(""), /据え置きました/);
  });
  it("ふだんの会話は今までどおり（検索しない）", async () => {
    const { asked, searched, chunks } = await talk("ちょっと疲れたなあ");
    assert.equal(searched, null, "検索 API は呼ばない");
    assert.doesNotMatch(asked, /Web 検索の結果/);
    assert.equal(chunks.some((c) => c.sources), false);
  });
});
