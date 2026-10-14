/**
 * プッシュ通知用の「今日のニュース」の見出し（1 日 1 回）。
 * FreeNewsApi の今日の記事から Gemini が見出しを作る（記事に無いことは書かない）。
 * 記事が取れないときは、これまでどおり Google 検索つきで Gemini に作らせる。
 */
import { getGeminiConfig, getTimezone } from "@/lib/config";
import { streamGemini } from "@/llm/gemini";
import { articleLines, dailyNews, freeNewsEnabled, type NewsArticle } from "@/integrations/free-news";

const SYSTEM = "あなたはニュースの見出しを短くまとめる係。事実だけを書き、分からないことは書かない。";

export async function newsHeadlines(topics: string[]): Promise<string> {
  const config = getGeminiConfig();
  const today = new Intl.DateTimeFormat("ja-JP", { month: "long", day: "numeric", weekday: "short" }).format(new Date());
  const want = `今日（${today}）の日本の主なニュースを 3 本${topics.length ? `、それと「${topics.join("、")}」の分野から話題を 1 本ずつ` : ""}`;
  const format = "1 行 1 本・各 30 字以内の見出しだけで書いてください。行頭は「・」。前置きや出典・URL は書かないでください。";

  // FreeNewsApi の記事があれば、それから作る（検索はしない）
  let articles: NewsArticle[] = [];
  if (freeNewsEnabled()) {
    const daily = await dailyNews(topics).catch(() => null);
    articles = daily ? [...daily.main.slice(0, 8), ...daily.byTopic.flatMap((t) => t.articles.slice(0, 2))] : [];
  }
  const fromArticles = articles.length >= 3;
  const ask = fromArticles
    ? `${want}を、次の記事の一覧から選んで、${format}記事に書かれていないことは書かないでください。\n\n${articleLines(articles, getTimezone())}`
    : `${want}を、Google 検索で調べて、${format}`;
  let text = "";
  for await (const chunk of streamGemini({
    config: { ...config, thinkingLevel: "low", maxOutputTokens: 800 },
    systemInstruction: SYSTEM,
    contents: [{ role: "user", parts: [{ text: ask }] }],
    googleSearch: !fromArticles,
  })) {
    text += chunk.text;
  }
  const lines = text
    .split("\n")
    .map((l) => l.trim().replace(/\[\d+\]\s*/g, ""))
    .filter((l) => l.startsWith("・"))
    .slice(0, 7);
  if (!lines.length) throw new Error("見出しを作れませんでした");
  return `${lines.join("\n")}\nタップして F.R.I.D.A.Y. で詳しく聞く`;
}
