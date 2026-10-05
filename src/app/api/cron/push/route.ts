/**
 * GET /api/cron/push — 5 分ごとに GitHub Actions から呼ばれる（Authorization: Bearer <CRON_SECRET>）。
 *   1. 時間が来たリマインダーを全端末に通知し、完了にする
 *   2. ニュースの時間を過ぎていて、今日まだ送っていなければ、今日のニュースの見出しを通知する
 *   3. 日曜の夜なら、週の振り返りを作って通知する（週 1 回。通知の設定が無くてもノートは作る）
 */
import { getPushConfig, listSubscriptions, readPushState, sendPush, writePushState } from "@/integrations/push";
import { listReminders, markReminderDone } from "@/integrations/reminders";
import { localNow, readNewsSettings } from "@/integrations/news";
import { newsHeadlines } from "@/integrations/headlines";
import { safeEqual } from "@/lib/auth";
import { getTimezone } from "@/lib/config";
import { runWeeklyIfDue } from "@/integrations/weekly";
import { isBrainConfigured } from "@/memory/github-brain";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: Request): Promise<Response> {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret || !safeEqual(req.headers.get("authorization") ?? "", `Bearer ${secret}`)) {
    return Response.json({ ok: false, error: secret ? "unauthorized" : "CRON_SECRET が設定されていません" }, { status: 401 });
  }
  // 週の振り返り（通知の設定が無くても作る）
  const weekly = await runWeeklyIfDue().catch((err: unknown) => ({ status: "skipped" as const, reason: err instanceof Error ? err.message : "failed" }));
  if (!getPushConfig().configured || !isBrainConfigured()) return Response.json({ ok: true, weekly, skipped: "push or brain not configured" });
  if (!(await listSubscriptions()).length) return Response.json({ ok: true, weekly, skipped: "no devices" });

  const result: { reminders: number; news: boolean | string } = { reminders: 0, news: false };

  // 1. リマインダー（閉じている間に来たもの。12 時間より前のものは送らずに完了だけにする）
  const now = Date.now();
  for (const r of (await listReminders()).filter((r) => r.at <= now)) {
    if (now - r.at < 12 * 60 * 60_000) {
      await sendPush({ title: `⏰ ${r.label.split(" ")[1] ?? ""} リマインダー`, body: r.text, tag: `reminder-${r.id}`, url: "/" });
      result.reminders++;
    }
    await markReminderDone(r.id);
  }

  // 2. 朝のニュース（1 日 1 回）
  const settings = await readNewsSettings();
  const { date, time } = localNow(getTimezone());
  const state = await readPushState();
  if (settings.time !== "off" && time >= settings.time && state.newsDate !== date) {
    await writePushState({ ...state, newsDate: date }); // 失敗しても何度も送らないよう先に記録
    try {
      const lines = await newsHeadlines(settings.topics);
      await sendPush({ title: "📰 今日のニュース", body: lines, tag: `news-${date}`, url: "/" });
      result.news = true;
    } catch (err) {
      result.news = err instanceof Error ? err.message : "failed";
    }
  }
  return Response.json({ ok: true, weekly, ...result });
}
