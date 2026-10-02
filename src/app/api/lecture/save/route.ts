/**
 * POST /api/lecture/save — 授業ノート（まとめ・文字起こし）を脳（Obsidian）の「授業」フォルダに保存する
 *   { lecture, path? } → { ok, path }   path は前に保存した場所（あれば、そこを書き直す）
 */
import { saveLectureNote } from "@/integrations/brain-notes";
import { sanitizeSummary } from "@/integrations/lecture";
import { isLecturePath } from "@/lib/brain-paths";
import type { Lecture, LectureSegment } from "@/lib/lecture";
import { isBrainConfigured } from "@/memory/github-brain";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

function toLecture(v: unknown): Lecture | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (typeof o.startedAt !== "string" || Number.isNaN(Date.parse(o.startedAt))) return null;
  const segments: LectureSegment[] = Array.isArray(o.segments)
    ? o.segments
        .filter((s): s is LectureSegment => !!s && typeof (s as LectureSegment).text === "string" && typeof (s as LectureSegment).t === "number")
        .slice(0, 8000)
        .map((s) => ({ t: Math.max(0, s.t), text: s.text.slice(0, 2000) }))
    : [];
  let summary: Lecture["summary"];
  try {
    summary = o.summary ? sanitizeSummary(o.summary, String(o.subject ?? "")) : undefined;
  } catch {
    summary = undefined;
  }
  if (!segments.length && !summary) return null;
  return {
    id: String(o.id ?? ""),
    subject: typeof o.subject === "string" ? o.subject.slice(0, 60) : "",
    startedAt: o.startedAt,
    duration: typeof o.duration === "number" && Number.isFinite(o.duration) ? Math.min(36_000, Math.max(0, o.duration)) : 0,
    segments,
    summary,
  };
}

export async function POST(req: Request): Promise<Response> {
  if (!isBrainConfigured()) return Response.json({ ok: false, error: "脳（Obsidian）が接続されていないため保存できません。" }, { status: 503 });
  const body = (await req.json().catch(() => null)) as { lecture?: unknown; path?: unknown } | null;
  const lecture = toLecture(body?.lecture);
  if (!lecture) return Response.json({ ok: false, error: "保存する授業の中身がありません。" }, { status: 400 });
  const previous = typeof body?.path === "string" && isLecturePath(body.path) ? body.path : undefined;
  try {
    return Response.json({ ok: true, ...(await saveLectureNote(lecture, previous)) });
  } catch (err) {
    return Response.json({ ok: false, error: err instanceof Error ? err.message : "保存できませんでした。" }, { status: 502 });
  }
}
