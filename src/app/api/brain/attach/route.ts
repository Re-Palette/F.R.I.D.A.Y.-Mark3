/**
 * POST /api/brain/attach — 添えたファイルの原本を脳（Obsidian）の「添付」フォルダに保存する
 *   { path: "添付/YYYY-MM/YYYY-MM-DD_HHmmss_名前", data: base64 } → { ok, path }
 * F.R.I.D.A.Y. が書いた資料の PDF・スライド（文書/〇〇.pdf など）もここで保存する（作り直したら上書き）。
 * 置き場所は決まった形だけ受け付ける（ほかの場所には書かせない）。カメラの映像はここに送らない（保存しない）。
 */
import { isAttachmentPath, isDocFilePath } from "@/lib/brain-paths";
import { isBrainConfigured, putBinary } from "@/memory/github-brain";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** base64 の文字数の上限（Vercel が 1 回に受け付ける 4.5MB に収まる大きさ） */
const MAX_DATA_CHARS = 4_300_000;

export async function POST(req: Request): Promise<Response> {
  if (!isBrainConfigured()) return Response.json({ ok: false, error: "脳（Obsidian）が接続されていません。" }, { status: 503 });
  const body = (await req.json().catch(() => null)) as { path?: unknown; data?: unknown } | null;
  const path = typeof body?.path === "string" ? body.path : "";
  const data = typeof body?.data === "string" ? body.data : "";
  const doc = isDocFilePath(path);
  if (!isAttachmentPath(path) && !doc) return Response.json({ ok: false, error: "保存する場所が正しくありません。" }, { status: 400 });
  if (!data || data.length > MAX_DATA_CHARS || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) {
    return Response.json({ ok: false, error: "ファイルが大きすぎるか、形式が正しくありません。" }, { status: 400 });
  }
  try {
    await putBinary(path, data, doc ? `F.R.I.D.A.Y.: 資料を保存（${path}）` : `F.R.I.D.A.Y.: 添付ファイルを保存（${path}）`, doc);
    return Response.json({ ok: true, path });
  } catch (err) {
    return Response.json({ ok: false, error: err instanceof Error ? err.message : "保存できませんでした。" }, { status: 502 });
  }
}
