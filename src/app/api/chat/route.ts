/**
 * POST /api/chat — F.R.I.D.A.Y. との会話（NDJSON ストリーミング）。
 * Gemini API キーはサーバー側でのみ使用し、ブラウザには一切渡さない。
 */
import { after } from "next/server";
import { handleConversation, preflight, sanitizeHistory } from "@/core/friday";
import type { StreamEvent } from "@/core/types";
import { CalendarAccess, refreshTokenFrom } from "@/integrations/google-calendar";
import { asksForNews, localNow, NEWS_COOKIE, readNewsSettings, type NewsSettings } from "@/integrations/news";
import { isBrainConfigured } from "@/memory/github-brain";
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
  try {
    const body = (await req.json()) as { messages?: unknown; mode?: unknown };
    history = sanitizeHistory(body?.messages);
    voice = body?.mode === "voice";
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
  const news = await newsPlan(req, history[history.length - 1]?.content ?? "");
  const events = handleConversation(history, req.signal, { voice, onTurn: resolveTurn, calendar, news: news.context });

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

/** 設定の読み込みに待てる時間（脳が遅ければ既定の設定で進める） */
const NEWS_SETTINGS_BUDGET_MS = 800;

async function newsPlan(req: Request, latest: string) {
  const fallback: NewsSettings = { time: "07:00", topics: [], fromBrain: false };
  const settings = await Promise.race([
    readNewsSettings().catch(() => fallback),
    new Promise<NewsSettings>((r) => setTimeout(() => r(fallback), NEWS_SETTINGS_BUDGET_MS)),
  ]);
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
