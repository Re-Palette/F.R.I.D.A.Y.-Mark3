/**
 * /api/voiceprint — 登録した声紋（陽大の声の特徴を表す数字の並び）。スマホとパソコンで共有する。
 *   GET → { configured, voiceprint }　POST {声紋} → 保存　DELETE → 消す
 * 保存先は脳（GitHub）の .friday/voiceprint.json。声そのものは受け取らない（数字だけ）。
 */
import { isBrainConfigured, readFresh, updateNote } from "@/memory/github-brain";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PATH = ".friday/voiceprint.json";
const DIM = 512;
const STRICT = ["loose", "normal", "strict"];
const headers = { "Cache-Control": "no-store" };

type Print = { embedding: number[]; strictness: string; enabled: boolean; samples: number; createdAt: string };

function parse(raw: unknown): Print | null {
  if (typeof raw !== "object" || raw === null) return null;
  const v = raw as Record<string, unknown>;
  const e = v.embedding;
  if (!Array.isArray(e) || e.length !== DIM || !e.every((x) => typeof x === "number" && Number.isFinite(x))) return null;
  return {
    embedding: e.map((x: number) => Math.round(x * 1e6) / 1e6),
    strictness: typeof v.strictness === "string" && STRICT.includes(v.strictness) ? v.strictness : "normal",
    enabled: v.enabled !== false,
    samples: typeof v.samples === "number" && v.samples > 0 ? Math.min(20, Math.floor(v.samples)) : 1,
    createdAt: typeof v.createdAt === "string" && v.createdAt.length < 40 ? v.createdAt : new Date().toISOString(),
  };
}

const fromText = (text: string | null) => {
  try {
    return text ? parse(JSON.parse(text)) : null;
  } catch {
    return null;
  }
};

export async function GET(): Promise<Response> {
  if (!isBrainConfigured()) return Response.json({ configured: false }, { headers });
  try {
    return Response.json({ configured: true, voiceprint: fromText(await readFresh(PATH)) }, { headers });
  } catch {
    return Response.json({ configured: true, error: "声紋を読み込めませんでした。" }, { status: 502, headers });
  }
}

export async function POST(req: Request): Promise<Response> {
  if (!isBrainConfigured()) return Response.json({ configured: false }, { headers });
  const text = await req.text();
  if (text.length > 40_000) return Response.json({ error: "大きすぎます。" }, { status: 413, headers });
  const print = fromText(text);
  if (!print) return Response.json({ error: "声紋の形が正しくありません。" }, { status: 400, headers });
  try {
    await updateNote(PATH, () => JSON.stringify(print), "FRIDAY: 声紋を保存");
    return Response.json({ configured: true, voiceprint: print }, { headers });
  } catch {
    return Response.json({ configured: true, error: "声紋を保存できませんでした。" }, { status: 502, headers });
  }
}

export async function DELETE(): Promise<Response> {
  if (!isBrainConfigured()) return Response.json({ configured: false }, { headers });
  try {
    await updateNote(PATH, () => "null", "FRIDAY: 声紋を削除");
    return Response.json({ configured: true, voiceprint: null }, { headers });
  } catch {
    return Response.json({ configured: true, error: "声紋を消せませんでした。" }, { status: 502, headers });
  }
}
