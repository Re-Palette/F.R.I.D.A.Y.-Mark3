/**
 * POST   /api/push/subscribe { subscription, label } — この端末を通知の宛先に加える
 * DELETE /api/push/subscribe { endpoint }            — この端末を外す
 */
import { addSubscription, removeSubscription } from "@/integrations/push";
import { isBrainConfigured } from "@/memory/github-brain";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  if (!isBrainConfigured()) return Response.json({ error: "通知の宛先の保存には脳（Obsidian）の接続が必要です。" }, { status: 400 });
  const body = (await req.json().catch(() => ({}))) as { subscription?: unknown; label?: unknown };
  try {
    const count = await addSubscription(body.subscription, typeof body.label === "string" ? body.label : "端末");
    return Response.json({ ok: true, count });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "登録できませんでした。" }, { status: 400 });
  }
}

export async function DELETE(req: Request): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as { endpoint?: unknown };
  if (typeof body.endpoint !== "string") return Response.json({ error: "不正な指定です。" }, { status: 400 });
  await removeSubscription([body.endpoint]).catch(() => {});
  return Response.json({ ok: true });
}
