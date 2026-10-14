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
async function fakeGemini(answer: string | ((body: string) => string)) {
  const asked: string[] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      asked.push(body);
      res.writeHead(200, { "content-type": "text/event-stream" });
      const text = typeof answer === "string" ? answer : answer(body);
      res.end(`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text }] }, finishReason: "STOP" }] })}\n\n`);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { asked, port: (server.address() as { port: number }).port, close: () => server.close() };
}

/** 模擬の Gemini と模擬の FreeNewsApi の中で動かす */
async function withFakes<T>(answer: string | ((body: string) => string), news: (url: string) => Response, run: (g: { asked: string[]; newsAsked: string[] }) => Promise<T>): Promise<T> {
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

/** 会話を 1 回進める（模擬の Gemini・FreeNewsApi の中で） */
async function talk(messages: { role: "user" | "assistant"; content: string }[], extra: Record<string, unknown> = {}) {
  const { chatAgent } = await import("../src/agents/chat/index");
  const chunks: { text: string; sources?: { title: string; uri: string }[] }[] = [];
  for await (const c of chatAgent.run({
    messages,
    memory: { connected: false, recall: async () => [], save: async () => {} } as never,
    now: new Date(),
    timezone: "Asia/Tokyo",
    voice: false,
    ...extra,
  } as never))
    chunks.push(c);
  return chunks;
}

describe("話題のニュースの質問（FreeNewsApi で探す。Google 検索は使わない）", () => {
  it("質問から話題を取り出す。全般のニュース・設定の変更は話題にしない", async () => {
    const { newsTopic } = await import("../src/integrations/news");
    assert.equal(newsTopic("アメリカでのニュースは？"), "アメリカ");
    assert.equal(newsTopic("AI関連のニュース教えて"), "AI");
    assert.equal(newsTopic("大谷翔平の最新ニュース"), "大谷翔平");
    assert.equal(newsTopic("フライデー、ウクライナ情勢のニュースを教えて"), "ウクライナ情勢");
    assert.equal(newsTopic("今日のニュースは？"), null);
    assert.equal(newsTopic("最新のニュースを調べて"), null);
    assert.equal(newsTopic("ニュースまとめて"), null);
    assert.equal(newsTopic("ニュースの時間を7時半にして"), null);
    assert.equal(newsTopic("明日の天気は？"), null);
  });
  it("続きの質問は、直前がニュースの話のときだけ", async () => {
    const { newsAsk } = await import("../src/agents/search/news-search");
    assert.deepEqual(newsAsk("これの詳細は？", "今日のニュースは？", "日銀は金利を据え置きました。"), { kind: "detail" });
    assert.deepEqual(newsAsk("もっと詳しく", "アメリカのニュースは？", "…"), { kind: "detail" });
    assert.deepEqual(newsAsk("ニュースの詳細を教えて"), { kind: "detail" }, "「の詳細」を話題にしない");
    assert.deepEqual(newsAsk("そのニュースの詳細は？"), { kind: "detail" });
    assert.equal(newsAsk("これの詳細は？", "この資料を見て", "資料の要点です。"), null, "ニュースの話でなければ探さない");
    assert.deepEqual(newsAsk("トヨタのニュースある？"), { kind: "topic", topic: "トヨタ", detail: false });
    assert.deepEqual(newsAsk("トヨタのニュースの詳細を教えて"), { kind: "topic", topic: "トヨタ", detail: true });
  });
  it("「アメリカでのニュースは？」：FreeNewsApi で「アメリカ」を探し、記事から答える（Google 検索は使わない）。出典を返す", async () => {
    await withFakes("アメリカでは…", () => Response.json(articles), async ({ asked, newsAsked }) => {
      const chunks = await talk([{ role: "user", content: `アメリカでのニュースは？${"　".repeat(Math.floor(Math.random() * 3))}` }]);
      assert.ok(newsAsked.some((u) => new URL(u).searchParams.get("q") === "アメリカ"));
      const body = asked.at(-1)!;
      assert.doesNotMatch(body, /googleSearch|google_search/);
      assert.match(body, /ニュースの記事（FreeNewsApi。検索語「アメリカ」）/);
      assert.match(body, /日銀、金利を据え置き/);
      assert.ok(chunks.some((c) => c.sources?.some((s) => s.uri === "https://news.example.jp/a")));
    });
  });
  it("「ニュースの詳細を教えて」：前の返事に出た記事を（AI に聞き直さずに）見つけ、本文を FreeNewsApi から持ってきて詳しく答える", async () => {
    const withBody = { articles: [{ ...articles.articles[0], full_text: "日本銀行は13日の金融政策決定会合で、政策金利を0.5%に据え置くことを決めた。植田総裁は会見で、物価の動向を見極める考えを示した。".repeat(2) }] };
    // 本文は full_text=true で頼んだときだけ返す（本物の FreeNewsApi と同じ）
    await withFakes("詳しくは…", (u) => Response.json(u.includes("full_text=true") ? withBody : articles), async ({ asked, newsAsked }) => {
      // 前に「日銀、金利を据え置き」の記事を見せておく（ニュースの質問で記事を取ってくる）
      await talk([{ role: "user", content: `日銀${Math.random().toString(36).slice(2, 5)}のニュースは？` }]);
      asked.length = 0;
      newsAsked.length = 0;
      await talk([
        { role: "user", content: "今日のニュースは？" },
        { role: "assistant", content: "今日のニュースです。日銀、金利を据え置きの話題があります。" },
        { role: "user", content: "ニュースの詳細を教えて" },
      ]);
      assert.ok(!asked.some((b) => b.includes("検索語を作る係")), "記事が分かっているので AI に検索語を作らせない（速い）");
      const detailCall = newsAsked.map((u) => new URL(u)).find((u) => u.searchParams.get("full_text") === "true");
      assert.ok(detailCall, "本文を頼む");
      assert.equal(detailCall.searchParams.get("q"), "日銀、金利を据え置き");
      const body = asked.at(-1)!;
      assert.doesNotMatch(body, /googleSearch|google_search/);
      assert.match(body, /詳細を聞かれている/);
      assert.match(body, /本文：日本銀行は13日の金融政策決定会合で/);
    });
  });
  it("「これの詳細は？」で前の返事の記事が分からないときは、会話の流れから検索語を作って探す", async () => {
    const answer = (b: string) => (b.includes("検索語を作る係") ? "宇宙ステーション 計画" : "詳しくは…");
    await withFakes(answer, () => Response.json(articles), async ({ asked, newsAsked }) => {
      await talk([
        { role: "user", content: "今日のニュースは？" },
        { role: "assistant", content: "今日のニュースです。新しい宇宙ステーションの建設計画が発表されました。" },
        { role: "user", content: "これの詳細は？" },
      ]);
      assert.ok(newsAsked.some((u) => new URL(u).searchParams.get("q") === "宇宙ステーション 計画"), newsAsked.join("\n"));
      assert.match(asked.at(-1)!, /検索語「宇宙ステーション 計画」/);
    });
  });
  it("ニュースのときは、考える量を最小にして速く答える", async () => {
    await withFakes("…", () => Response.json(articles), async ({ asked }) => {
      await talk([{ role: "user", content: `カナダ${Math.random().toString(36).slice(2, 5)}のニュースは？` }]);
      assert.match(asked.at(-1)!, /"thinkingLevel":"minimal"|"thinkingLevel":"MINIMAL"/i);
    });
  });
  it("記事が見つからなくても、ニュースの質問では検索しない（取れなかったと正直に伝える）", async () => {
    await withFakes("…", () => Response.json({ articles: [] }), async ({ asked }) => {
      await talk([{ role: "user", content: `ゼロ件テスト${Math.random().toString(36).slice(2, 6)}のニュースは？` }]);
      const body = asked.at(-1)!;
      assert.doesNotMatch(body, /googleSearch|google_search/);
      assert.match(body, /ニュースの記事が取れなかった/);
    });
  });
  it("F.R.I.D.A.Y. で（ニュースのまとめの設定が渡らない LINE などでも）「今日のニュースは？」は FreeNewsApi の記事から（検索しない）", async () => {
    await withFakes("今日のニュースです。", () => Response.json(articles), async ({ asked }) => {
      // （今日の記事は前のテストで取って覚えているので、ここでは問い合わせないこともある）
      const chunks = await talk([{ role: "user", content: "今日のニュースは？" }]);
      const body = asked.at(-1)!;
      assert.doesNotMatch(body, /googleSearch|google_search/);
      assert.match(body, /検索語「今日のニュース」/);
      assert.ok(chunks.some((c) => c.sources?.length));
    });
  });
  it("Web 検索をオフにしていても、ニュースは FreeNewsApi から（検索ではないので）", async () => {
    await withFakes("…", () => Response.json(articles), async ({ asked, newsAsked }) => {
      process.env.FRIDAY_SEARCH = "off";
      try {
        await talk([{ role: "user", content: `イギリス${Math.random().toString(36).slice(2, 5)}のニュースは？` }]);
      } finally {
        delete process.env.FRIDAY_SEARCH;
      }
      assert.ok(newsAsked.length > 0);
      assert.match(asked.at(-1)!, /ニュースの記事（FreeNewsApi/);
    });
  });
  it("E.D.I.T.H. でも、調べものでない発言では検索しない", async () => {
    await withFakes("こんにちは。", () => Response.json(articles), async ({ asked, newsAsked }) => {
      await talk([{ role: "user", content: "こんにちは、調子はどう？" }], { persona: "edith" });
      assert.doesNotMatch(asked.at(-1)!, /googleSearch|google_search/);
      assert.equal(newsAsked.length, 0);
    });
  });
  it("/api/search（声の会話）：ニュースの検索は FreeNewsApi の記事を返す", async () => {
    await withFakes("", () => Response.json(articles), async ({ newsAsked }) => {
      const route = await import("../src/app/api/search/route");
      const res = await route.GET(new Request(`http://x/api/search?q=${encodeURIComponent("トヨタのニュース")}`));
      const json = (await res.json()) as { ok: boolean; kind?: string; results: { url: string }[] };
      assert.equal(json.ok, true);
      assert.equal(json.kind, "news");
      assert.equal(json.results[0].url, "https://news.example.jp/a");
      assert.ok(newsAsked.some((u) => new URL(u).searchParams.get("q") === "トヨタ"));
    });
  });
});
