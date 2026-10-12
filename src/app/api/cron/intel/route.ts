/**
 * GET /api/cron/intel — E.D.I.T.H. の情報収集（GitHub Actions から 5 分ごとに呼ばれる。Authorization: Bearer <CRON_SECRET>）。
 * EDITH_INTEL=on のときだけ動く。各情報源は自分の間隔が来たときだけ取りに行く（runIntel）。
 * 返すのは件数・状態・health（ok / degraded / failed）だけ（集めた本文や鍵は返さない）。中身は integrations/intel/cron.ts。
 */
import { handleIntelCron } from "@/integrations/intel/cron";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: Request): Promise<Response> {
  return handleIntelCron(req);
}
