/**
 * GET /api/cron/diary — 毎夜の自動日記（Vercel Cron から呼ばれる）。
 * 他人に叩かれないよう、Vercel が付ける「Authorization: Bearer <CRON_SECRET>」を確かめる。
 */
import { writeDailyDiary } from "@/integrations/diary";
import { safeEqual } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: Request): Promise<Response> {
  const secret = process.env.CRON_SECRET?.trim();
  const auth = req.headers.get("authorization") ?? "";
  if (!secret || !safeEqual(auth, `Bearer ${secret}`)) {
    return Response.json({ ok: false, error: secret ? "unauthorized" : "CRON_SECRET が設定されていません" }, { status: 401 });
  }
  try {
    return Response.json({ ok: true, ...(await writeDailyDiary()) });
  } catch (err) {
    console.error("[friday] diary failed:", err);
    return Response.json({ ok: false, error: err instanceof Error ? err.message : "failed" }, { status: 500 });
  }
}
