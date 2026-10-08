/**
 * POST /api/offline/sync — オフライン中（LM Studio で話していた間）の会話を、オンラインに戻ってから脳に反映する。
 *   { turns: [{ id, at, user, assistant, voice, captures, attrs }] }
 * captures は返答の隠しタグの中身（覚えたこと・ToDo・リマインダー・予定・文書など）。オンラインのときと同じ処理（FRIDAY Core の Tool）で実行する。
 * 戻り値: { done: [id…], notes: [文…] }
 */
import { BRAIN_TAGS, runBrainActions, type BrainTag } from "@/core/brain-actions";
import { CALENDAR_TAGS, runCalendarActions, type CalendarTag } from "@/core/calendar-actions";
import { toFact } from "@/core/hidden-tags";
import { saveDocument, toFolder } from "@/integrations/documents";
import { CalendarAccess, refreshTokenFrom } from "@/integrations/google-calendar";
import { getTimezone } from "@/lib/config";
import { isBrainConfigured } from "@/memory/github-brain";
import { getLongTermMemory } from "@/memory/long-term";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_TURNS = 30;
const MAX_BODY = 800_000;
const TAGS = ["memory", "document", "slides", ...BRAIN_TAGS, ...CALENDAR_TAGS] as const;
type Tag = (typeof TAGS)[number];

interface Turn {
  id: string;
  at: number;
  user: string;
  assistant: string;
  voice: boolean;
  captures: Record<Tag, string[]>;
  attrs: Partial<Record<Tag, Record<string, string>[]>>;
}

const str = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : "");

function toTurn(raw: unknown): Turn | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const id = str(r.id, 64);
  if (!id) return null;
  const cap = (r.captures ?? {}) as Record<string, unknown>;
  const att = (r.attrs ?? {}) as Record<string, unknown>;
  const captures = {} as Record<Tag, string[]>;
  const attrs: Turn["attrs"] = {};
  for (const tag of TAGS) {
    const list = Array.isArray(cap[tag]) ? (cap[tag] as unknown[]).filter((x): x is string => typeof x === "string").slice(0, 3) : [];
    captures[tag] = list.map((x) => x.slice(0, tag === "document" || tag === "slides" ? 30_000 : 2000));
    if (Array.isArray(att[tag])) {
      attrs[tag] = (att[tag] as unknown[]).slice(0, 3).map((a) =>
        Object.fromEntries(Object.entries(a && typeof a === "object" ? a : {}).filter(([, v]) => typeof v === "string").map(([k, v]) => [k.slice(0, 20), (v as string).slice(0, 120)])),
      );
    }
  }
  return { id, at: Number(r.at) || Date.now(), user: str(r.user, 16000), assistant: str(r.assistant, 16000), voice: r.voice === true, captures, attrs };
}

export async function POST(req: Request): Promise<Response> {
  const text = await req.text();
  if (text.length > MAX_BODY) return Response.json({ error: "大きすぎます。" }, { status: 413 });
  let turns: Turn[] = [];
  try {
    const body = JSON.parse(text) as { turns?: unknown };
    turns = (Array.isArray(body.turns) ? body.turns : []).slice(0, MAX_TURNS).map(toTurn).filter((t): t is Turn => t !== null);
  } catch {
    return Response.json({ error: "形式が正しくありません。" }, { status: 400 });
  }
  if (!isBrainConfigured()) return Response.json({ done: turns.map((t) => t.id), notes: [], brain: false });

  const memory = getLongTermMemory();
  const refresh = refreshTokenFrom(req);
  const calendar = refresh ? new CalendarAccess(refresh, getTimezone()) : undefined;
  const done: string[] = [];
  const notes: string[] = [];
  for (const t of turns) {
    try {
      const facts = t.captures.memory.map(toFact).filter(Boolean);
      const when = new Intl.DateTimeFormat("ja-JP", { timeZone: getTimezone(), month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(t.at);
      await memory.save?.({ user: `${t.user}（オフライン中 ${when}・LOCAL AI）`, assistant: t.assistant, memories: facts, voice: t.voice });
      for await (const { note } of runBrainActions(t.captures as Record<BrainTag, string[]>, true)) if (note) notes.push(note);
      for await (const { note } of runCalendarActions(t.captures as Record<CalendarTag, string[]>, calendar)) if (note) notes.push(note);
      const docs = [
        ...t.captures.document.map((content, i) => ({ content, attrs: t.attrs.document?.[i] ?? {}, slides: false })),
        ...t.captures.slides.map((content, i) => ({ content, attrs: t.attrs.slides?.[i] ?? {}, slides: true })),
      ];
      for (const d of docs) {
        const title = d.attrs.title || /^#\s+(.+)$/m.exec(d.content)?.[1]?.trim() || "無題";
        await saveDocument({ title: d.slides ? `${title}（スライド）` : title, folder: toFolder(d.attrs.folder), content: d.content });
      }
      done.push(t.id);
    } catch (err) {
      notes.push(`オフライン中の会話の一部を脳に反映できませんでした（${err instanceof Error ? err.message : "不明"}）。`);
      break; // 順番を守るため、失敗したらそこで止めて次の機会に続きから
    }
  }
  return Response.json({ done, notes, brain: true });
}
