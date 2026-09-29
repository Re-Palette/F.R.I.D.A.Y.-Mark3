/**
 * プッシュ通知用の「今日のニュース」の見出し（Google 検索つきで Gemini に作らせる。1 日 1 回）。
 */
import { getGeminiConfig } from "@/lib/config";
import { streamGemini } from "@/llm/gemini";

export async function newsHeadlines(topics: string[]): Promise<string> {
  const config = getGeminiConfig();
  const today = new Intl.DateTimeFormat("ja-JP", { month: "long", day: "numeric", weekday: "short" }).format(new Date());
  const ask = `今日（${today}）の日本の主なニュースを 3 本${topics.length ? `、それと「${topics.join("、")}」の分野から話題を 1 本ずつ` : ""}、
Google 検索で調べて、1 行 1 本・各 30 字以内の見出しだけで書いてください。行頭は「・」。前置きや出典・URL は書かないでください。`;
  let text = "";
  for await (const chunk of streamGemini({
    config: { ...config, thinkingLevel: "low", maxOutputTokens: 800 },
    systemInstruction: "あなたはニュースの見出しを短くまとめる係。事実だけを書き、分からないことは書かない。",
    contents: [{ role: "user", parts: [{ text: ask }] }],
    googleSearch: true,
  })) {
    text += chunk.text;
  }
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("・"))
    .slice(0, 7);
  if (!lines.length) throw new Error("見出しを作れませんでした");
  return `${lines.join("\n")}\nタップして F.R.I.D.A.Y. で詳しく聞く`;
}
