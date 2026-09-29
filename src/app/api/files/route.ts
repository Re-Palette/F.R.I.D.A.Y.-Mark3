/**
 * GET /api/files — FILES 画面用。F.R.I.D.A.Y. が書いた文書（文書・SNS・振り返り・日記）の一覧。
 * GET /api/files?path=… — その文書の本文（上のフォルダの中だけ読める）。
 */
import { DOC_FOLDERS } from "@/integrations/documents";
import { isBrainConfigured, listNotes, readFresh } from "@/memory/github-brain";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const FOLDERS = Object.values(DOC_FOLDERS);
const inFolders = (path: string) => FOLDERS.some((f) => path.startsWith(`${f}/`)) && path.endsWith(".md") && !path.includes("..");

export async function GET(req: Request): Promise<Response> {
  if (!isBrainConfigured()) return Response.json({ error: "脳（Obsidian）が接続されていません。", files: [] }, { status: 400 });
  const path = new URL(req.url).searchParams.get("path");
  if (path) {
    if (!inFolders(path)) return Response.json({ error: "その場所は読めません。" }, { status: 400 });
    const text = await readFresh(path);
    return text === null ? Response.json({ error: "見つかりませんでした。" }, { status: 404 }) : Response.json({ path, text });
  }
  const files = (await listNotes(true))
    .filter((f) => inFolders(f.path))
    .map((f) => {
      const folder = f.path.slice(0, f.path.indexOf("/"));
      return { path: f.path, folder, title: f.path.slice(folder.length + 1).replace(/\.md$/, ""), size: f.size };
    })
    .sort((a, b) => b.title.localeCompare(a.title, "ja"));
  return Response.json({ files }, { headers: { "Cache-Control": "no-store" } });
}
