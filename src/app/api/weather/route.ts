/**
 * GET /api/weather — 右パネル用の天気（Open-Meteo、15 分キャッシュ）。
 */
import { getWeather } from "@/integrations/weather";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  try {
    return Response.json({ ok: true, weather: await getWeather() }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ ok: false }, { headers: { "Cache-Control": "no-store" } });
  }
}
