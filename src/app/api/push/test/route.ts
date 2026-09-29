/**
 * POST /api/push/test { endpoint } — この端末にテストの通知を送る。
 */
import { sendPush } from "@/integrations/push";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as { endpoint?: unknown };
  try {
    const sent = await sendPush(
      { title: "F.R.I.D.A.Y.", body: "通知のテストです。アプリを閉じていても、こうしてお知らせします。", tag: "friday-test", url: "/" },
      typeof body.endpoint === "string" ? body.endpoint : undefined,
    );
    return Response.json({ ok: sent > 0, sent });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "送れませんでした。" }, { status: 400 });
  }
}
