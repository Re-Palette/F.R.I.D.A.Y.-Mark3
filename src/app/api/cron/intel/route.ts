/**
 * GET /api/cron/intel — E.D.I.T.H. の情報収集（GitHub Actions から 5 分ごとに呼ばれる。Authorization: Bearer <CRON_SECRET>）。
 * EDITH_INTEL=on のときだけ動く。各情報源は自分の間隔が来たときだけ取りに行く（runIntel）。
 * 返すのは件数・状態だけ（集めた本文や鍵は返さない）。
 */
import { runIntel } from "@/integrations/intel/collect";
import { safeEqual } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: Request): Promise<Response> {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret || !safeEqual(req.headers.get("authorization") ?? "", `Bearer ${secret}`)) {
    return Response.json({ ok: false, error: secret ? "unauthorized" : "CRON_SECRET が設定されていません" }, { status: 401 });
  }
  const result = await runIntel();
  if (result.status !== "done") console.info(`[edith-intel] ${result.status}${result.error ? `: ${result.error}` : ""}`);
  return Response.json({ ok: result.status !== "error", ...result }, { status: result.status === "error" ? 500 : 200, headers: { "Cache-Control": "no-store" } });
}
