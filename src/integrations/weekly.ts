/**
 * 週の振り返り（日曜の夜に自動で作る）。
 * この 1 週間の会話ログ・ToDo・プロジェクトの動き・これから 1 週間の予定から、
 * 「進んだこと・止まっていること・来週の予定と締め切り・次の一手」をまとめて、脳の「振り返り/」に保存する。
 * 定期実行（/api/cron/push・/api/cron/diary）から呼ばれ、作ったらプッシュ通知で知らせる。会話で「振り返り聞かせて」と言えば、これを読んで話す。
 */
import { CalendarAccess, getCalendarConfig } from "@/integrations/google-calendar";
import { DOC_FOLDERS, docPath } from "@/integrations/documents";
import { formatMaterial, gatherReview } from "@/integrations/review";
import { getGeminiConfig, getTimezone } from "@/lib/config";
import { streamGemini } from "@/llm/gemini";
import { getPushConfig, listSubscriptions, readPushState, sendPush, writePushState } from "@/integrations/push";
import { isBrainConfigured, listNotes, readNote, updateNote } from "@/memory/github-brain";

const MARK = "F.R.I.D.A.Y. が作成";
const PREFIX = "週次振り返り ";

const SYSTEM = `あなたは F.R.I.D.A.Y.（フライデー）。陽大の副社長・参謀・秘書。
毎週日曜の夜に、この 1 週間の振り返りを書く。
- 渡された材料だけを使う。材料に無いことは書かない。
- 落ち着いた「です・ます」体。事実ベースで、責めない。
- 1 行目は「要約: 」で始めて、通知に出す 1 文（60 字以内。いちばん大事な点と次の一手）を書く。
- 2 行目から Markdown の本文。次の見出しを使う：
  # 週次振り返り 開始日〜終了日
  ## 今週のハイライト（3 つまで）
  ## 進んだこと（プロジェクトごと）
  ## 止まっていること（「止まっている」プロジェクト・進まなかった ToDo）
  ## 来週の予定と締め切り（日付順）
  ## 次の一手（具体的な行動を 3 つまで。止まっているものの再開を優先）
- 該当する内容が無い見出しは省く。前置きやコードブロックは付けない。`;

export type WeeklyResult = { status: "saved"; path: string; summary: string } | { status: "skipped"; reason: string };

const weekTitle = (from: string, to: string) => `${PREFIX}${from}〜${to}`;

/** 今週（直近 7 日）の振り返りを作って保存する */
export async function writeWeeklyReview(calendar?: CalendarAccess): Promise<WeeklyResult> {
  if (!isBrainConfigured()) return { status: "skipped", reason: "脳が設定されていません" };
  const config = getGeminiConfig();
  if (!config.apiKey) return { status: "skipped", reason: "Gemini API キーが設定されていません" };
  const tz = getTimezone();
  // 予定は、画面から呼ばれたときはその端末の接続、自動実行では全端末共通のトークン（GOOGLE_REFRESH_TOKEN）があるときだけ
  const refresh = getCalendarConfig().refreshToken;
  const access = calendar ?? (refresh ? new CalendarAccess(refresh, tz) : undefined);
  const material = await gatherReview(tz, 7, access);

  let text = "";
  for await (const chunk of streamGemini({
    config: { ...config, thinkingLevel: "low", maxOutputTokens: Math.max(config.maxOutputTokens, 4000), temperature: 0.4 },
    systemInstruction: SYSTEM,
    contents: [{ role: "user", parts: [{ text: `${material.from}〜${material.to} の 1 週間を振り返ってください。\n\n${formatMaterial(material)}` }] }],
  })) {
    text += chunk.text;
  }
  const cleaned = text
    .replace(/^```(?:markdown)?\s*|```\s*$/g, "")
    .replace(/<(memory|document|reminder|news-settings|project-progress|todo-[\w-]+|calendar[\w-]*)\b[\s\S]*?(<\/\1>|$)/g, "")
    .trim();
  const m = /^要約[:：]\s*(.+)\n+/.exec(cleaned);
  const summary = (m?.[1] ?? "").trim().slice(0, 120);
  const body = (m ? cleaned.slice(m[0].length) : cleaned).trim();
  if (!body) return { status: "skipped", reason: "振り返りを書けませんでした" };

  const path = docPath("振り返り", weekTitle(material.from, material.to));
  await updateNote(path, () => `${body}\n\n---\n*${MARK}（自動・${material.to}）*\n`, `F.R.I.D.A.Y.: 週次振り返り ${material.to}`);
  return { status: "saved", path, summary: summary || "今週の振り返りをまとめました。" };
}

/** 直近（終わりの日が 6 日以内）に保存した週の振り返り。無ければ null */
export async function latestWeeklyReview(): Promise<{ path: string; text: string } | null> {
  const today = new Intl.DateTimeFormat("sv-SE", { timeZone: getTimezone() }).format(new Date());
  const limit = new Date(`${today}T00:00:00Z`);
  limit.setUTCDate(limit.getUTCDate() - 6);
  const since = limit.toISOString().slice(0, 10);
  const files = (await listNotes())
    .filter((f) => f.path.startsWith(`${DOC_FOLDERS.振り返り}/${PREFIX}`))
    .map((f) => ({ f, end: /〜(\d{4}-\d{2}-\d{2})\.md$/.exec(f.path)?.[1] ?? "" }))
    .filter((x) => x.end >= since)
    .sort((a, b) => b.end.localeCompare(a.end));
  if (!files.length) return null;
  return { path: files[0].f.path, text: (await readNote(files[0].f)).slice(0, 8000) };
}

/** 日曜の夜（20 時以降）か */
export function isSundayEvening(tz = getTimezone(), now = new Date()): { due: boolean; date: string } {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", hour: "2-digit", hourCycle: "h23" }).formatToParts(now);
  const weekday = parts.find((p) => p.type === "weekday")?.value;
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? 0);
  const date = new Intl.DateTimeFormat("sv-SE", { timeZone: tz }).format(now);
  return { due: weekday === "Sun" && hour >= 20, date };
}

/**
 * 定期実行から呼ぶ：日曜の夜で、今週まだ作っていなければ作って、プッシュ通知で知らせる（1 週間に 1 回）。
 * 通知の設定が無くても、振り返りのノートは作る。
 */
export async function runWeeklyIfDue(): Promise<WeeklyResult | null> {
  if (!isBrainConfigured()) return null;
  const { due, date } = isSundayEvening();
  if (!due) return null;
  const state = await readPushState();
  if (state.weeklyDate === date) return null;
  await writePushState({ ...state, weeklyDate: date }); // 失敗しても何度も作らないよう先に記録
  const result = await writeWeeklyReview();
  if (result.status === "saved" && getPushConfig().configured && (await listSubscriptions()).length) {
    await sendPush({ title: "🗓 今週の振り返り", body: result.summary, tag: `weekly-${date}`, url: "/" }).catch(() => 0);
  }
  return result;
}
