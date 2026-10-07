/**
 * 「API の残りどれくらい？」に答えるための材料。
 *   ElevenLabs … 今月の利用枠（使った文字数・上限・戻る日）を ElevenLabs に聞く（正確）
 *   Gemini     … 残りを教えてくれる仕組みが無いので、無料枠が戻る時刻（アメリカ西海岸の 0 時＝日本の 16〜17 時）からの
 *                会話の回数を、脳の会話ログから数える（目安）。上限（GEMINI_DAILY_LIMIT）を設定していれば残りも出す。
 *                上限に達して切り替えたモデルがあれば、それも伝える。
 */
import { getGeminiConfig, getTtsConfig } from "@/lib/config";
import { limitedModels } from "@/llm/gemini";
import { isBrainConfigured, LOG_DIR, readFresh } from "@/memory/github-brain";
import { isTtsConfigured, ttsQuota } from "@/voice/elevenlabs";

/** API の残り・使用量を聞いているか */
export function asksForUsage(text: string): boolean {
  return /(API|ＡＰＩ|エーピーアイ|無料枠|利用枠|クォータ|使用量|利用量|ElevenLabs|イレブンラボ|Gemini|ジェミニ|声の(残り|文字数)).*(残|あと|どれ|いくつ|何回|量|上限|使った|確認)|残り.*(API|回数|文字数|枠)|あと何回(話せ|使え)/i.test(text);
}

const fmtJst = (ms: number) => new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(ms));

/** 直近の「アメリカ西海岸の 0 時」（Gemini の無料枠が戻る時刻） */
function lastPacificMidnight(now = Date.now()): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", hourCycle: "h23", hour: "2-digit", minute: "2-digit", second: "2-digit" })
      .formatToParts(new Date(now))
      .map((p) => [p.type, p.value]),
  );
  const sinceMidnight = (Number(parts.hour) * 3600 + Number(parts.minute) * 60 + Number(parts.second)) * 1000;
  return now - sinceMidnight;
}

/** 日本時間の日付（YYYY-MM-DD）と時刻（HH:MM） */
const jst = (ms: number) => {
  const d = new Date(ms);
  return {
    date: new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo" }).format(d),
    time: new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Tokyo", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(d),
  };
};

/** 無料枠が戻ってからの会話の回数（会話ログの「### HH:MM」を数える） */
async function turnsSince(from: number): Promise<{ turns: number; voice: number } | null> {
  if (!isBrainConfigured()) return null;
  const start = jst(from);
  const today = jst(Date.now());
  const days = start.date === today.date ? [today.date] : [start.date, today.date];
  let turns = 0;
  let voice = 0;
  for (const day of days) {
    const text = (await readFresh(`${LOG_DIR}/${day}.md`).catch(() => null)) ?? "";
    for (const m of text.matchAll(/^### (\d{2}:\d{2})(（音声）)?/gm)) {
      if (day === start.date && m[1] < start.time) continue;
      turns++;
      if (m[2]) voice++;
    }
  }
  return { turns, voice };
}

export async function usageReport(): Promise<string> {
  const lines: string[] = [];
  const config = getGeminiConfig();

  // Gemini
  const reset = lastPacificMidnight();
  const next = reset + 24 * 60 * 60_000;
  const used = await turnsSince(reset).catch(() => null);
  const limit = Number(process.env.GEMINI_DAILY_LIMIT);
  lines.push(`## Gemini（会話の AI・無料枠）`);
  lines.push(`- 使っているモデル：${config.models.slice(0, 3).join("、")}`);
  lines.push(`- 無料枠が戻った時刻：${fmtJst(reset)}（次は ${fmtJst(next)}。日本時間の 16〜17 時ごろ）`);
  if (used) {
    lines.push(`- それから話した回数：${used.turns} 回（うち音声 ${used.voice} 回）。1 回の会話でおよそ 1〜2 回分を使う（スマホの声は文字起こしも同じ回に含む）。`);
    if (Number.isFinite(limit) && limit > 0) lines.push(`- 1 日の上限の目安 ${limit} 回に対して、残りはおよそ ${Math.max(0, limit - used.turns)} 回。`);
    else lines.push("- Gemini は残りの回数を教えてくれないので、正確な残りは分からない（Google AI Studio の「使用量」画面で確認できる）。");
  } else lines.push("- 脳（会話ログ）が無いので、今日の回数は数えられない。");
  const limited = limitedModels();
  lines.push(
    limited.length
      ? `- いま上限・混雑で休ませているモデル：${limited.map((m) => `${m.model}（${fmtJst(m.until)} まで）`).join("、")}。ほかのモデルで答えている。`
      : "- いま上限に達しているモデルは無い（このサーバーが知っている範囲）。",
  );

  // ElevenLabs
  lines.push(`\n## ElevenLabs（声）`);
  if (!isTtsConfigured(getTtsConfig())) lines.push("- 設定されていない（ブラウザの声で読み上げている）。");
  else {
    const q = await ttsQuota().catch(() => null);
    if (!q) lines.push("- 残りを確認できなかった（API キーに「ユーザー情報を読む」権限が無い可能性）。");
    else {
      const left = Math.max(0, q.limit - q.used);
      lines.push(`- 今月使った文字数：${q.used.toLocaleString("ja-JP")} / ${q.limit.toLocaleString("ja-JP")} 文字（残り ${left.toLocaleString("ja-JP")} 文字・${Math.round((left / Math.max(1, q.limit)) * 100)}%）`);
      if (q.resetAt) lines.push(`- 次に枠が戻るのは ${fmtJst(q.resetAt)}`);
      lines.push(`- 目安：返事 1 回の読み上げは 60〜150 文字くらい。`);
    }
  }
  return lines.join("\n");
}
