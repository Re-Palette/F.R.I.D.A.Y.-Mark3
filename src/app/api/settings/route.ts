/**
 * GET  /api/settings — 画面の SETTINGS 用に、今の設定を返す。
 * POST /api/settings — 設定を変える（脳の「FRIDAY/設定.md」「FRIDAY/ニュース.md」に保存）。
 */
import { geocode, readAppSettings, saveAppSettings, type AppSettings } from "@/integrations/settings";
import { normalizeTime, readNewsSettings, saveNewsSettings } from "@/integrations/news";
import { getSearchMode, getTtsConfig } from "@/lib/config";
import { isBrainConfigured } from "@/memory/github-brain";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function current() {
  const [saved, news] = await Promise.all([readAppSettings().catch(() => ({}) as AppSettings), readNewsSettings().catch(() => null)]);
  return {
    canSave: isBrainConfigured(),
    saved,
    effective: {
      voiceSpeed: saved.voiceSpeed ?? getTtsConfig().speed,
      weatherCity: saved.weather?.city ?? (process.env.WEATHER_CITY?.trim() || "TOKYO"),
      search: saved.search ?? getSearchMode(),
      replyLength: saved.replyLength ?? "normal",
      newsTime: news?.time ?? "07:00",
      newsTopics: news?.topics ?? [],
    },
  };
}

export async function GET(): Promise<Response> {
  return Response.json(await current(), { headers: { "Cache-Control": "no-store" } });
}

export async function POST(req: Request): Promise<Response> {
  if (!isBrainConfigured()) return Response.json({ error: "設定の保存には脳（Obsidian）の接続が必要です。" }, { status: 400 });
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const change: { [K in keyof AppSettings]?: AppSettings[K] | null } = {};

  if (body.voiceSpeed !== undefined) change.voiceSpeed = body.voiceSpeed === null ? null : Number(body.voiceSpeed);
  if (body.search !== undefined) change.search = body.search === null ? null : (body.search as AppSettings["search"]);
  if (body.replyLength !== undefined) change.replyLength = body.replyLength === null ? null : (body.replyLength as AppSettings["replyLength"]);
  if (typeof body.weatherCity === "string") {
    const city = body.weatherCity.trim();
    if (!city) change.weather = null;
    else {
      const place = await geocode(city).catch(() => null);
      if (!place) return Response.json({ error: `「${city}」の場所が見つかりませんでした。市区町村名で試してください。` }, { status: 400 });
      change.weather = place;
    }
  }

  try {
    if (Object.keys(change).length) await saveAppSettings(change);
    if (body.newsTime !== undefined || body.newsTopics !== undefined) {
      const time = typeof body.newsTime === "string" ? normalizeTime(body.newsTime) : undefined;
      if (body.newsTime !== undefined && !time) return Response.json({ error: "ニュースの時間は 07:30 のように入力してください（off で自動なし）。" }, { status: 400 });
      await saveNewsSettings({
        ...(time ? { time } : {}),
        ...(Array.isArray(body.newsTopics) ? { topics: body.newsTopics.map(String) } : {}),
      });
    }
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "保存できませんでした。" }, { status: 502 });
  }
  return Response.json(await current());
}
