/**
 * POST /api/hologram — 「〇〇の 3D ホログラム」の設計図を作る（{ subject } → { ok, model }）。
 */
import { generateHologram } from "@/integrations/hologram";
import { toFridayError } from "@/lib/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req: Request): Promise<Response> {
  const body = (await req.json().catch(() => null)) as { subject?: unknown } | null;
  const subject = typeof body?.subject === "string" ? body.subject.trim().slice(0, 60) : "";
  if (!subject) return Response.json({ ok: false, error: "何のホログラムを作るか分かりませんでした。" }, { status: 400 });
  try {
    return Response.json({ ok: true, model: await generateHologram(subject) }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    const message = err instanceof Error && err.message.includes("ホログラム") ? err.message : toFridayError(err).message;
    return Response.json({ ok: false, error: message }, { status: 502 });
  }
}
