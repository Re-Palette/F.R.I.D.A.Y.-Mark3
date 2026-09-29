/**
 * 毎夜の自動日記（AUTOMATION）。Vercel Cron が毎晩 /api/cron/diary を呼び、
 * その日の会話ログ・覚えたこと・ToDo・予定から日記を書いて、脳の「日記/YYYY-MM-DD.md」に保存する。
 * 画面を開いていなくても動く。
 */
import { CalendarAccess, getCalendarConfig } from "@/integrations/google-calendar";
import { docPath } from "@/integrations/documents";
import { formatMaterial, gatherReview } from "@/integrations/review";
import { getGeminiConfig, getTimezone } from "@/lib/config";
import { streamGemini } from "@/llm/gemini";
import { isBrainConfigured, updateNote } from "@/memory/github-brain";

const MARK = "F.R.I.D.A.Y. が作成";

const SYSTEM = `あなたは F.R.I.D.A.Y.（フライデー）。ユーザー一人のための専属 AI アシスタント。
毎晩、その日の記録から「今日の日記」を書く係として動く。
- 渡された材料（会話ログ・覚えたこと・ToDo・予定）だけを使う。材料に無いことは書かない。
- あとで読み返して楽しく役に立つように、やさしい「です・ます」体で書く。
- Markdown で、次の見出しを使う：
  # 日記 YYYY-MM-DD（曜日）
  ## 今日のできごと
  ## 決めたこと・覚えたこと
  ## 終わったこと
  ## 明日へのひとこと
- 材料が少ない日は短くてよい。該当する内容が無い見出しは省く。
- 本文だけを出力する（前置きやコードブロックは付けない）。`;

export type DiaryResult = { status: "saved"; path: string } | { status: "skipped"; reason: string };

export async function writeDailyDiary(): Promise<DiaryResult> {
  if (!isBrainConfigured()) return { status: "skipped", reason: "脳が設定されていません" };
  const config = getGeminiConfig();
  if (!config.apiKey) return { status: "skipped", reason: "Gemini API キーが設定されていません" };
  const tz = getTimezone();

  // 予定は、全端末共通のトークン（GOOGLE_REFRESH_TOKEN）があるときだけ（夜中の自動実行にはブラウザの Cookie が無いため）
  const refresh = getCalendarConfig().refreshToken;
  const material = await gatherReview(tz, 1, refresh ? new CalendarAccess(refresh, tz) : undefined);
  const empty = !material.logs.length && !material.memories && !material.done.length && !material.events?.length;
  if (empty) return { status: "skipped", reason: "今日は記録がありません" };

  let text = "";
  for await (const chunk of streamGemini({
    config: { ...config, maxOutputTokens: Math.max(config.maxOutputTokens, 3000) },
    systemInstruction: SYSTEM,
    contents: [{ role: "user", parts: [{ text: `今日（${material.to}）の日記を書いてください。\n\n${formatMaterial(material)}` }] }],
  })) {
    text += chunk.text;
  }
  const diary = text
    .replace(/^```(?:markdown)?\s*|```\s*$/g, "")
    // 会話用の隠しタグが紛れ込んでいたら取り除く（閉じていないものも）
    .replace(/<(memory|document|reminder|news-settings|project-progress|todo-[\w-]+|calendar[\w-]*)\b[\s\S]*?(<\/\1>|$)/g, "")
    .trim();
  if (!diary) return { status: "skipped", reason: "日記を書けませんでした" };

  const path = docPath("日記", "", material.to);
  const stamped = `${diary}\n\n---\n*${MARK}（自動・${material.to}）*\n`;
  await updateNote(
    path,
    // 自分で書いた日記があれば消さずに、F.R.I.D.A.Y. のまとめを下に足す
    (current) => (current && !current.includes(MARK) ? `${current.trimEnd()}\n\n## F.R.I.D.A.Y. のまとめ\n\n${stamped}` : stamped),
    `F.R.I.D.A.Y.: 日記 ${material.to}`,
  );
  return { status: "saved", path };
}
