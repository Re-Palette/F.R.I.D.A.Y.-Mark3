/**
 * POST /api/hologram — 「〇〇の 3D ホログラム」
 *   { subject, step: "research" } → { ok, brief }   見た目を Google 検索で調べる（調べられなければ brief: null）
 *   { subject, notes? }           → { ok, model }   設計図を作る（notes は調べた見た目）
 */
import { generateHologram, researchHologram } from "@/integrations/hologram";
import { toFridayError } from "@/lib/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req: Request): Promise<Response> {
  const body = (await req.json().catch(() => null)) as { subject?: unknown; step?: unknown; notes?: unknown } | null;
  const subject = typeof body?.subject === "string" ? body.subject.trim().slice(0, 60) : "";
  if (!subject) return Response.json({ ok: false, error: "何のホログラムを作るか分かりませんでした。" }, { status: 400 });
  const headers = { "Cache-Control": "no-store" };
  if (body?.step === "research") {
    return Response.json({ ok: true, brief: await researchHologram(subject) }, { headers });
  }
  const notes = typeof body?.notes === "string" ? body.notes.slice(0, 2000) : undefined;
  try {
    return Response.json({ ok: true, model: await generateHologram(subject, notes) }, { headers });
  } catch (err) {
    const message = err instanceof Error && err.message.includes("ホログラム") ? err.message : toFridayError(err).message;
    return Response.json({ ok: false, error: message }, { status: 502 });
  }
}
