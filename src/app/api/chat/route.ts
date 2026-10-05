/**
 * POST /api/chat — F.R.I.D.A.Y. との会話（NDJSON ストリーミング）。
 * Gemini API キーはサーバー側でのみ使用し、ブラウザには一切渡さない。
 */
import { after } from "next/server";
import { handleConversation, preflight, sanitizeHistory } from "@/core/friday";
import type { StreamEvent } from "@/core/types";
import { CalendarAccess, hasComposeScope, refreshTokenFrom } from "@/integrations/google-calendar";
import { createDraft, recentMail, unreadMail } from "@/integrations/gmail";
import { isSpotifyConfigured, SpotifyAccess, spotifyTokenFrom } from "@/integrations/spotify";
import type { AmazonMusicState } from "@/lib/music";
import { asksForNews, localNow, NEWS_COOKIE, peekNewsSettings } from "@/integrations/news";
import { isBrainConfigured } from "@/memory/github-brain";
import { warmBrain } from "@/memory/obsidian";
import { getTasksOverview } from "@/integrations/tasks";
import { listReminders } from "@/integrations/reminders";
import { getWeather } from "@/integrations/weather";
import { cookieHeader, readCookie } from "@/lib/secure-cookie";
import { getTimezone } from "@/lib/config";
import { toFridayError } from "@/lib/errors";
import { getLongTermMemory, type SaveTurnInput } from "@/memory/long-term";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function errorResponse(err: unknown): Response {
  const e = toFridayError(err);
  const event: StreamEvent = { type: "error", code: e.code, message: e.message, retryable: e.retryable };
  return Response.json(event, { status: e.status });
}

export async function POST(req: Request): Promise<Response> {
  let history;
  let voice = false;
  let amazon: AmazonMusicState | undefined;
  try {
    const body = (await req.json()) as { messages?: unknown; mode?: unknown; music?: unknown };
    history = sanitizeHistory(body?.messages);
    voice = body?.mode === "voice";
    amazon = toAmazonState(body?.music);
    preflight();
  } catch (err) {
    if (err instanceof SyntaxError) {
      return Response.json(
        { type: "error", code: "BAD_REQUEST", message: "リクエストの形式が不正です。", retryable: false },
        { status: 400 },
      );
    }
    return errorResponse(err);
  }

  // 返答を返し終えてから、会話ログと覚えたことを脳に書き込む（返答は待たせない）
  let resolveTurn!: (turn: SaveTurnInput | null) => void;
  const turnReady = new Promise<SaveTurnInput | null>((resolve) => (resolveTurn = resolve));
  const memory = getLongTermMemory();
  if (memory.save) {
    after(async () => {
      const turn = await turnReady;
      if (!turn) return;
      try {
        await memory.save?.(turn);
      } catch (err) {
        console.warn("[friday] brain save failed:", err instanceof Error ? err.message : err);
      }
    });
  }

  const encoder = new TextEncoder();
  const refresh = refreshTokenFrom(req);
  const calendar = refresh ? new CalendarAccess(refresh, getTimezone()) : undefined;
  // ニュース: 決まった時間を過ぎてからその日最初の会話、または頼まれたときにまとめて伝える
  const news = newsPlan(req, history[history.length - 1]?.content ?? "");
  const mail = refresh ? () => unreadMail(refresh) : undefined;
  const mailRecent = refresh ? () => recentMail(refresh) : undefined;
  const mailCanDraft = refresh ? () => hasComposeScope(refresh) : undefined;
  const spotifyToken = spotifyTokenFrom(req);
  const draft = refresh ? (input: Parameters<typeof createDraft>[1]) => createDraft(refresh, input) : undefined;
  // 録った声で話しかけられたら、文字にしている間に予定・天気・ToDo・脳の読み込みを先に始めておく
  if (history[history.length - 1]?.audio) {
    void Promise.allSettled([
      getWeather(),
      calendar?.upcoming(7),
      ...(isBrainConfigured() ? [getTasksOverview(), listReminders(), warmBrain()] : []),
    ]);
  }
  const events = handleConversation(history, req.signal, {
    voice,
    onTurn: resolveTurn,
    calendar,
    news: news.context,
    mail,
    mailRecent,
    mailCanDraft,
    draft,
    spotify: spotifyToken ? new SpotifyAccess(spotifyToken) : undefined,
    spotifyConfigured: isSpotifyConfigured(),
    amazon,
  });

  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { value, done } = await events.next();
        if (done) {
          controller.close();
          return;
        }
        controller.enqueue(encoder.encode(JSON.stringify(value) + "\n"));
      } catch {
        controller.close();
      }
    },
    async cancel() {
      resolveTurn(null);
      await events.return(undefined);
    },
  });

  const headers = new Headers({
    "Content-Type": "application/x-ndjson; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    "X-Accel-Buffering": "no",
  });
  if (news.markDelivered) headers.append("Set-Cookie", cookieHeader(NEWS_COOKIE, news.markDelivered, 60 * 60 * 48));
  return new Response(stream, { headers });
}

/** 画面から届いた Amazon Music の状態を検証する（形の違うものは捨てる・文字は短く切る） */
function toAmazonState(v: unknown): AmazonMusicState | undefined {
  if (!v || typeof v !== "object") return undefined;
  const { ext, now } = v as { ext?: unknown; now?: unknown };
  if (typeof ext !== "boolean") return undefined;
  if (!now || typeof now !== "object") return { ext, now: now === null ? null : undefined };
  const n = now as Record<string, unknown>;
  const text = (x: unknown) => (typeof x === "string" ? x.replace(/[\r\n]+/g, " ").slice(0, 120) : undefined);
  return {
    ext,
    now: {
      playing: n.playing === true,
      title: text(n.title),
      artist: text(n.artist),
      volume: typeof n.volume === "number" && n.volume >= 0 && n.volume <= 100 ? Math.round(n.volume) : undefined,
    },
  };
}

/** ニュースを今回伝えるか。返答を待たせないよう、設定は前回読んだものを使う（最新は裏で読み直す） */
function newsPlan(req: Request, latest: string) {
  const settings = peekNewsSettings();
  const { date, time } = localNow(getTimezone());
  const deliveredToday = readCookie(req, NEWS_COOKIE) === date;
  const deliver: false | "scheduled" | "asked" = asksForNews(latest)
    ? "asked"
    : settings.time !== "off" && time >= settings.time && !deliveredToday
      ? "scheduled"
      : false;
  return {
    context: { settings, deliver, canSave: isBrainConfigured() },
    markDelivered: deliver ? date : undefined,
  };
}
