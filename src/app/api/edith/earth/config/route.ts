/**
 * GET /api/edith/earth/config → { google3dKey: string | null, windyMapKey: string | null, services: { opensky, tomtom, odpt, ais, webcams } }
 * GOD'S EYE VIEW（EARTH）で使える外部サービスの設定の有無。合言葉のロック（proxy.ts）の内側。
 *   - Google の 3D の街（Photorealistic 3D Tiles）は、ブラウザが Google から直接読み込むため、キーを画面に渡す必要がある。
 *     キーは Google Cloud の設定で「このサイトからだけ使える」（HTTP リファラーの制限）と「Map Tiles API だけ」に制限しておくこと
 *   - Windy の天気の地図（Map Forecast API）も、ブラウザが Windy のライブラリを直接読み込むため、キーを画面に渡す。
 *     Windy のキーの設定で、このサイトのドメインだけで使えるように制限しておくこと
 *   - ほかのサービスのキーは画面に返さない（使えるかどうかだけ）
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const has = (v: string | undefined) => Boolean(v && v.trim());

export async function GET(): Promise<Response> {
  const env = process.env;
  const google3dKey = env.GOOGLE_MAPS_API_KEY?.trim() || null;
  const windyMapKey = env.WINDY_MAP_KEY?.trim() || null;
  return Response.json(
    {
      google3dKey,
      windyMapKey,
      services: {
        opensky: has(env.OPENSKY_CLIENT_ID) && has(env.OPENSKY_CLIENT_SECRET) ? "auth" : "anonymous",
        tomtom: has(env.TOMTOM_API_KEY),
        odpt: has(env.ODPT_CONSUMER_KEY),
        ais: has(env.AISSTREAM_API_KEY),
        webcams: has(env.WINDY_WEBCAMS_KEY),
      },
    },
    { headers: { "Cache-Control": "private, no-store" } },
  );
}
