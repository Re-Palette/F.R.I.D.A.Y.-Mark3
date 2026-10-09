/**
 * POST /api/live — リアルタイム音声会話を始める準備
 *   { calendar?: スナップショット, recent?: 直近の会話, persona?: "karen" } → { ok, url, model, systemInstruction, voiceName }
 * Gemini API キーは返さない（返すのは 1 回だけ・数分で切れる使い捨ての鍵入りの宛先）。
 * 声は画面と Google の間で直接やりとりし、このサーバーには届かない。
 */
import { CalendarAccess, refreshTokenFrom, type CalendarEvent } from "@/integrations/google-calendar";
import { parseCalendarSnapshot, snapshotEvents } from "@/integrations/calendar-snapshot";
import { prepareLive } from "@/integrations/live";
import { listReminders } from "@/integrations/reminders";
import { getTasksOverview } from "@/integrations/tasks";
import { getWeather } from "@/integrations/weather";
import { getGeminiConfig, getTimezone } from "@/lib/config";
import { toFridayError } from "@/lib/errors";
import { isBrainConfigured } from "@/memory/github-brain";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** このサーバーの版（画面の版と同じでなければ、画面が古い） */
const SERVER_BUILD = process.env.VERCEL_GIT_COMMIT_SHA ?? "dev";

/** 予定・天気・ToDo を待てる時間（キャッシュがあればすぐ。会話を始めるのを待たせない） */
const CONTEXT_MS = 700;

function within<T>(p: Promise<T> | undefined, ms: number, fallback: T): Promise<T> {
  if (!p) return Promise.resolve(fallback);
  return Promise.race([p.catch(() => fallback), new Promise<T>((r) => setTimeout(() => r(fallback), ms))]);
}

function toRecent(raw: unknown): { role: "user" | "assistant"; content: string }[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((m): m is { role: "user" | "assistant"; content: string } =>
      Boolean(m) && (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim().length > 0,
    )
    // 「入力欄で頼んでください」と操作を断った古い返事は渡さない（今は声で操作できるのに、まねして断らないように）
    .filter((m) => !(m.role === "assistant" && /入力欄/.test(m.content)))
    .slice(-8)
    .map((m) => ({ role: m.role, content: m.content.slice(0, 600) }));
}

export async function POST(req: Request): Promise<Response> {
  const headers = { "Cache-Control": "no-store" };
  if (!getGeminiConfig().apiKey) {
    return Response.json({ ok: false, error: "Gemini API キーが設定されていません。" }, { status: 503, headers });
  }
  const body = (await req.json().catch(() => null)) as { calendar?: unknown; recent?: unknown; persona?: unknown; build?: unknown } | null;
  // 古い版の画面（裏で開きっぱなしのタブなど）には使わせない：画面はこれまでの方式で答えて、読み込み直す
  if (body?.build !== SERVER_BUILD) {
    return Response.json({ ok: false, stale: true, error: "画面が古い版です。読み込み直してください。" }, { status: 409, headers });
  }
  const timezone = getTimezone();
  const now = new Date();
  const snap = parseCalendarSnapshot(body?.calendar);
  const refresh = refreshTokenFrom(req);
  const brain = isBrainConfigured();
  try {
    const [live, weather, tasks, reminders] = await Promise.all([
      within<CalendarEvent[] | null>(refresh ? new CalendarAccess(refresh, timezone).upcoming(7, 40, CONTEXT_MS) : undefined, CONTEXT_MS + 100, null),
      within(getWeather(), CONTEXT_MS, null),
      within(brain ? getTasksOverview() : undefined, CONTEXT_MS, null),
      within(brain ? listReminders() : undefined, CONTEXT_MS, null),
    ]);
    const events = live ?? (snap ? snapshotEvents(snap, now, timezone) : null);
    const setup = await prepareLive({ now, timezone, events, tasks, reminders, weather, recent: toRecent(body?.recent), persona: body?.persona === "karen" ? "karen" : undefined }, req.signal);
    return Response.json({ ok: true, ...setup }, { headers });
  } catch (err) {
    return Response.json({ ok: false, error: toFridayError(err).message }, { status: 502, headers });
  }
}
