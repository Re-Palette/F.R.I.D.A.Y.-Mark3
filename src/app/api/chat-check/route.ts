/**
 * GET /api/chat-check?q=こんにちは&news=scheduled — 本番のサーバーで 1 回答えてみて、どこで止まるかを時間つきで返す（調べる用）。
 *   準備（記憶・予定・ニュースの記事）→ Gemini → 返事、のそれぞれの時刻・エラーを並べる。最大 40 秒。合言葉のロックの内側。
 *   news=scheduled で「その日最初の会話（ニュースを添える）」と同じ道筋を試す。
 */
import { handleConversation } from "@/core/friday";
import { CalendarAccess, refreshTokenFrom } from "@/integrations/google-calendar";
import { peekNewsSettings } from "@/integrations/news";
import { getGeminiConfig, getTimezone } from "@/lib/config";
import { isBrainConfigured } from "@/memory/github-brain";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: Request): Promise<Response> {
  const params = new URL(req.url).searchParams;
  const q = params.get("q")?.trim() || "こんにちは";
  const scheduled = params.get("news") === "scheduled";
  const config = getGeminiConfig();
  const refresh = refreshTokenFrom(req);
  const t0 = Date.now();
  const timeline: { t: number; type: string; detail?: string }[] = [];
  const ac = new AbortController();
  const stop = setTimeout(() => ac.abort(), 40_000);
  let text = "";
  try {
    const events = handleConversation([{ role: "user", content: q }], ac.signal, {
      voice: false,
      calendar: refresh ? new CalendarAccess(refresh, getTimezone()) : undefined,
      news: { settings: peekNewsSettings(), deliver: scheduled ? "scheduled" : false, canSave: false },
    });
    for await (const ev of events) {
      const e = ev as { type: string; text?: string; stage?: string; message?: string; code?: string; model?: string };
      if (e.type === "delta") {
        if (!text) timeline.push({ t: Date.now() - t0, type: "最初の文字" });
        text += e.text ?? "";
        continue;
      }
      timeline.push({ t: Date.now() - t0, type: e.type, detail: e.stage ?? e.model ?? (e.code ? `${e.code}: ${e.message}` : undefined) });
    }
  } catch (err) {
    timeline.push({ t: Date.now() - t0, type: "例外", detail: err instanceof Error ? `${err.name}: ${err.message}` : String(err) });
  } finally {
    clearTimeout(stop);
  }
  const body = {
    question: q,
    newsScheduled: scheduled,
    totalMs: Date.now() - t0,
    timedOut: ac.signal.aborted,
    gemini: { keySet: Boolean(config.apiKey), models: config.models },
    brain: isBrainConfigured(),
    calendarCookie: Boolean(refresh),
    freenewsapi: process.env.FREENEWSAPI ?? "(未設定=使う)",
    timeline,
    answer: text.slice(0, 400),
  };
  return new Response(JSON.stringify(body, null, 2), { headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } });
}
