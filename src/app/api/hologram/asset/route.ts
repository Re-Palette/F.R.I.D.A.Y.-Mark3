/**
 * GET /api/hologram/asset?u=… — 3D モデル（.glb）の取り寄せ。
 * ブラウザから直接読めない（CORS）ときだけ使う中継。Poly Pizza の置き場所以外の URL は扱わない。
 */
import { isAllowedAssetUrl } from "@/integrations/hologram-assets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BYTES = 12 * 1024 * 1024;

export async function GET(req: Request): Promise<Response> {
  const u = new URL(req.url).searchParams.get("u") ?? "";
  if (!isAllowedAssetUrl(u)) return new Response("not allowed", { status: 400 });
  let res: Response;
  try {
    res = await fetch(u, { signal: AbortSignal.timeout(15000), redirect: "error" });
  } catch {
    return new Response("upstream error", { status: 502 });
  }
  const size = Number(res.headers.get("content-length") ?? 0);
  if (!res.ok || !res.body || size > MAX_BYTES) return new Response("upstream error", { status: 502 });
  return new Response(res.body, {
    headers: {
      "Content-Type": "model/gltf-binary",
      "Cache-Control": "public, max-age=86400",
      ...(size ? { "Content-Length": String(size) } : {}),
    },
  });
}
