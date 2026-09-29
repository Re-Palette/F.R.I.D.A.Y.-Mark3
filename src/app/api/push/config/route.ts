/**
 * GET /api/push/config — 画面が通知を登録するための公開鍵（秘密鍵は返さない）。
 */
import { getPushConfig, listSubscriptions } from "@/integrations/push";
import { isBrainConfigured } from "@/memory/github-brain";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const c = getPushConfig();
  const devices = c.configured && isBrainConfigured() ? (await listSubscriptions().catch(() => [])).map((s) => ({ label: s.label, endpoint: s.endpoint })) : [];
  return Response.json(
    { configured: c.configured, brain: isBrainConfigured(), publicKey: c.publicKey ?? null, cron: Boolean(process.env.CRON_SECRET?.trim()), devices },
    { headers: { "Cache-Control": "no-store" } },
  );
}
