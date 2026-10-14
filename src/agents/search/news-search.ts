/**
 * 話題のニュースの質問（「アメリカでのニュースは？」「これの詳細は？」）を FreeNewsApi で探して答える。
 * Google 検索は使わない（記事が見つからないときだけ、呼ぶ側が通常の検索に戻す）。
 */
import { newsTopic, asksForNews, asksForNewsDetail } from "@/integrations/news";
import { articleLines, type NewsArticle } from "@/integrations/free-news";
import { getGeminiConfig } from "@/lib/config";
import { streamGemini } from "@/llm/gemini";

/** 前の話の続きを聞いている（「これの詳細は？」「それってどうなった？」「もっと詳しく」） */
const FOLLOW_UP = /^(これ|それ|あれ|この|その|あの|さっき|今の|いまの|上の|1つ目|2つ目|3つ目|一つ目|二つ目|三つ目|最初の|最後の)|詳細|詳しく|くわしく|もっと|続き|その後|どうなった|背景|理由は|なんで|なぜ/;

/** 直前のやりとりがニュースの話だったか */
function newsContext(prevUser?: string, prevAssistant?: string): boolean {
  return Boolean((prevUser && asksForNews(prevUser)) || (prevAssistant && /ニュース|報道|によると|発表しました|発表した/.test(prevAssistant)));
}

export type NewsAsk = { kind: "topic"; topic: string; detail: boolean } | { kind: "detail" } | null;

/**
 * このニュースの質問で記事を探すか。
 *   topic ：話題が分かる（「アメリカでのニュースは？」。「トヨタのニュースの詳細」なら detail で本文も）
 *   detail：前の返事のニュースの詳細・続き（「ニュースの詳細を教えて」「これの詳細は？」「もっと詳しく」）
 */
export function newsAsk(latest: string, prevUser?: string, prevAssistant?: string): NewsAsk {
  const t = latest.trim();
  const topic = newsTopic(t);
  if (topic) return { kind: "topic", topic, detail: asksForNewsDetail(t) };
  if (asksForNewsDetail(t) || (t.length <= 60 && FOLLOW_UP.test(t) && newsContext(prevUser, prevAssistant))) return { kind: "detail" };
  return null;
}

/**
 * 続きの質問（「これの詳細は？」）から、探すニュースの言葉を作る（会話の流れを Gemini に読ませて 1 行で）。
 * 作れなければ、直前の質問の話題・発言そのものを使う
 */
export async function followUpQuery(latest: string, prevUser: string | undefined, prevAssistant: string | undefined, signal?: AbortSignal): Promise<string> {
  const fallback = (prevUser && newsTopic(prevUser)) || latest;
  try {
    const config = getGeminiConfig();
    let text = "";
    const ask = `次の会話で、ユーザーが最後に知りたがっているニュースを探すための検索語を、日本語の名詞 1〜4 語（空白区切り）で 1 行だけ書いてください。説明は書かないでください。

ユーザー: ${(prevUser ?? "").slice(0, 200)}
あなた: ${(prevAssistant ?? "").slice(0, 1200)}
ユーザー: ${latest.slice(0, 200)}`;
    for await (const chunk of streamGemini({
      config: { ...config, thinkingLevel: "minimal", maxOutputTokens: 40 },
      systemInstruction: "あなたは検索語を作る係。検索語だけを 1 行で書く。",
      contents: [{ role: "user", parts: [{ text: ask }] }],
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(1500)]) : AbortSignal.timeout(1500),
    })) {
      text += chunk.text;
    }
    const q = text.split("\n").map((l) => l.replace(/^[・\-*\s「『]+|[」』\s]+$/g, "").trim()).find(Boolean) ?? "";
    return q.length >= 2 && q.length <= 60 ? q : fallback;
  } catch {
    return fallback;
  }
}

/** AI に渡す記事の一覧と答え方 */
export function newsSearchSection(query: string, articles: NewsArticle[], timezone: string, detail = false): string {
  return `

# ニュースの記事（FreeNewsApi。検索語「${query}」）
- 今回のニュースの質問は、下の記事から答える（Google 検索は使わない）。記事を読み、聞かれたことに合う内容を要約して伝える。${
    detail
      ? "\n- 詳細を聞かれているので、記事の本文から、何が起きたか・背景・数字や日付・関係する人や組織・今後の見通しを、分かりやすく詳しく説明する。"
      : ""
  }
- 話し方・返事の長さはいつもの会話のまま。記事に書かれていないことは足さない・推測で埋めない。日付が古い記事なら、そう添える。
- 記事に答えが無ければ、「ニュースの記事では見つかりませんでした」と正直に言う。
- 出典は画面に自動で表示されるので、本文に URL は書かない。
${articleLines(articles, timezone)}`;
}
