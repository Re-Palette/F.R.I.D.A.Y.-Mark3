/**
 * GET /api/chat-check?q=こんにちは&news=scheduled — 本番のサーバーで 1 回答えてみて、どこで止まるかを時間つきで返す（調べる用）。
 *   準備（記憶・予定・ニュースの記事）→ Gemini → 返事、のそれぞれの時刻・エラーを並べる。最大 40 秒。合言葉のロックの内側。
 *   news=scheduled で「その日最初の会話（ニュースを添える）」と同じ道筋を試す。
 */
import { handleConversation } from "@/core/friday";
import { CalendarAccess, refreshTokenFrom } from "@/integrations/google-calendar";
import { peekNewsSettings } from "@/integrations/news";
import { getGeminiConfig, getTimezone } from "@/lib/config";
import { pickTextModels } from "@/llm/gemini";
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
  // Google 側の様子：使えるモデルの一覧と、各モデルに 1 回だけ短く聞いたときの返事（404 の理由を見るため）
  const probe = await probeGemini(config).catch((err) => ({ error: String(err) }));
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
    probe,
    answer: text.slice(0, 400),
  };
  return new Response(JSON.stringify(body, null, 2), { headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } });
}

async function probeGemini(config: ReturnType<typeof getGeminiConfig>) {
  const headers = { "x-goog-api-key": config.apiKey ?? "", "Content-Type": "application/json" };
  const signal = AbortSignal.timeout(8000);
  const listRes = await fetch(`${config.baseUrl}/models?pageSize=1000`, { headers, signal, cache: "no-store" });
  const listRaw = await listRes.text();
  let all: { name: string; supportedGenerationMethods?: string[] }[] = [];
  try {
    all = (JSON.parse(listRaw) as { models?: typeof all }).models ?? [];
  } catch {
    /* JSON でなければ下で生の文字を見せる */
  }
  const flash = all
    .filter((m) => /flash/i.test(m.name) && m.supportedGenerationMethods?.includes("generateContent"))
    .map((m) => m.name.replace(/^models\//, ""));
  const picked = pickTextModels(all);
  const tries = [];
  for (const model of [...new Set([config.models[0], ...picked])].filter(Boolean).slice(0, 4)) {
    const res = await fetch(`${config.baseUrl}/models/${encodeURIComponent(model)}:generateContent`, {
      method: "POST",
      headers,
      signal: AbortSignal.timeout(10_000),
      cache: "no-store",
      body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "hi" }] }], generationConfig: { maxOutputTokens: 8 } }),
    }).catch((err: unknown) => err as Error);
    tries.push(
      res instanceof Error
        ? { model, error: String(res) }
        : { model, status: res.status, body: res.ok ? "OK" : (await res.text()).slice(0, 300) },
    );
  }
  return {
    baseUrl: config.baseUrl,
    listStatus: listRes.status,
    listError: listRes.ok ? undefined : listRaw.slice(0, 300),
    modelCount: all.length,
    flashModels: flash,
    picked,
    tries,
  };
}
