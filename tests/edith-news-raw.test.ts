import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { newsFromArticlesRaw } from "@/integrations/edith-news";
import { parseFreeNews } from "@/integrations/free-news";

describe("E.D.I.T.H. NEWS：Gemini が使えないときは FreeNewsApi の記事をそのまま出す", () => {
  it("見出し・要約・出典・国をそのまま使う（作り話を足さない）", () => {
    const articles = parseFreeNews({
      results: [
        { title: "Japan unveils new space probe", description: "JAXA said on Tuesday...", url: "https://example.com/a", sitename: "Example News", country: "jp", published_at: "2026-10-14T01:00:00Z" },
        { title: "Markets rally in Europe", description: null, url: "https://example.com/b", host: "b.example.com", published_at: "2026-10-14T02:00:00Z" },
      ],
    });
    const news = newsFromArticlesRaw("news", articles);
    assert.ok(news);
    assert.equal(news.items.length, 2);
    assert.equal(news.items[0].title, "Japan unveils new space probe");
    assert.equal(news.items[0].region, "日本");
    assert.deepEqual(news.items[0].sources, [{ title: "Example News", uri: "https://example.com/a" }]);
    assert.equal(news.items[1].region, "世界");
    assert.equal(news.items[1].summary, "");
  });

  it("記事が無ければ null", () => {
    assert.equal(newsFromArticlesRaw("tech", []), null);
  });
});
