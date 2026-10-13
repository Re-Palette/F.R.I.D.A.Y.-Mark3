/**
 * GET /api/edith/earth/traffic/{z}/{x}/{y} → 道路の渋滞の画像（PNG。TomTom の Traffic Flow のタイル）
 * キーはサーバーだけが持ち（TOMTOM_API_KEY）、画像はこのサイトを通して配る。合言葉のロック（proxy.ts）の内側。
 *   - 決まった段階（8〜16）だけ。ブラウザに 2 分ためさせて、同じ画像を何度も取りに行かない
 *   - キーが未設定なら 503。失敗は 502（画像は返さない）
 *   ※ TomTom のタイルの URL の形（Orbis の Traffic Flow）と利用条件は、公式の原文の最終確認が必要
 */
import { validTrafficTile } from "@/lib/earth/transport";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ z: string; x: string; y: string }> }): Promise<Response> {
  const { z, x, y } = await ctx.params;
  const [zi, xi, yi] = [Number(z), Number(x), Number(y.replace(/\.png$/, ""))];
  if (!validTrafficTile(zi, xi, yi)) return new Response("bad tile", { status: 400 });
  const key = process.env.TOMTOM_API_KEY?.trim();
  if (!key) return new Response("not configured", { status: 503 });
  try {
    const res = await fetch(`https://api.tomtom.com/maps/orbis/traffic/tile/flow/${zi}/${xi}/${yi}.png?apiVersion=1&key=${encodeURIComponent(key)}&tileSize=256&style=light`, {
      headers: { "TomTom-Api-Key": key },
      signal: AbortSignal.timeout(10_000),
      redirect: "manual",
      cache: "no-store",
    });
    const type = res.headers.get("content-type") ?? "";
    if (!res.ok || !/^image\//.test(type)) return new Response("upstream error", { status: 502 });
    const body = await res.arrayBuffer();
    if (body.byteLength > 1_000_000) return new Response("too large", { status: 502 });
    return new Response(body, { headers: { "Content-Type": type, "Cache-Control": "private, max-age=120" } });
  } catch {
    return new Response("upstream error", { status: 502 });
  }
}
