/**
 * F.R.I.D.A.Y. が書いた文書を脳（Obsidian）に保存する。
 *
 *   文書/<タイトル>.md       … 企画書・レポート・メールの下書き・投稿文など（同じタイトルなら上書き＝直した版）
 *   振り返り/<タイトル>.md   … 週次の振り返り
 *   日記/YYYY-MM-DD.md      … 毎日の日記
 *   SNS/<タイトル>.md        … SNS の投稿案
 */
import { getTimezone } from "@/lib/config";
import { isBrainConfigured, listNotes, readNote, updateNote } from "@/memory/github-brain";

export const DOC_FOLDERS = { 文書: "文書", 振り返り: "振り返り", 日記: "日記", SNS: "SNS" } as const;
export type DocFolder = keyof typeof DOC_FOLDERS;
const MAX_DOC_CHARS = 30_000;

/** ファイル名に使えない文字を除く */
function safeName(title: string): string {
  return (
    title
      .replace(/[\\/:]/g, "-") // 「9/23」「10:00」などは読める形に
      .replace(/[*?"<>|#^[\]]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 80) || "無題"
  );
}

const today = () => new Intl.DateTimeFormat("sv-SE", { timeZone: getTimezone() }).format(new Date());

export function docPath(folder: DocFolder, title: string, date = today()): string {
  return folder === "日記" ? `${DOC_FOLDERS.日記}/${date}.md` : `${DOC_FOLDERS[folder]}/${safeName(title)}.md`;
}

export function toFolder(v: string | undefined): DocFolder {
  return v && v in DOC_FOLDERS ? (v as DocFolder) : "文書";
}

/** 文書を保存（同じ場所にあれば上書き）。本文の先頭に見出しが無ければ付ける */
export async function saveDocument(input: {
  title: string;
  folder?: DocFolder;
  content: string;
  date?: string;
}): Promise<{ path: string; title: string; updated: boolean }> {
  if (!isBrainConfigured()) throw new Error("脳（Obsidian）が接続されていないため保存できません。");
  const title = input.title.replace(/\s+/g, " ").trim().slice(0, 80) || "無題";
  const folder = input.folder ?? "文書";
  const body = input.content.trim().slice(0, MAX_DOC_CHARS);
  if (!body) throw new Error("文書の中身がありませんでした。");
  const path = docPath(folder, title, input.date);
  const text = /^#\s/.test(body) ? body : `# ${title}\n\n${body}`;
  let updated = false;
  await updateNote(
    path,
    (current) => {
      updated = current !== null;
      return `${text}\n\n---\n*F.R.I.D.A.Y. が作成（${today()}）*\n`;
    },
    `F.R.I.D.A.Y.: 文書を保存（${path}）`,
  );
  return { path, title, updated };
}

/** 日付の範囲のノートを読む（会話ログ・日記など。YYYY-MM-DD.md のもの） */
export async function readDatedNotes(dir: string, from: string, to: string, maxChars = 6000): Promise<{ date: string; text: string }[]> {
  const files = (await listNotes())
    .filter((f) => f.path.startsWith(`${dir}/`))
    .map((f) => ({ f, date: f.path.slice(dir.length + 1).replace(/\.md$/, "") }))
    .filter(({ date }) => /^\d{4}-\d{2}-\d{2}$/.test(date) && date >= from && date <= to)
    .sort((a, b) => a.date.localeCompare(b.date));
  const texts = await Promise.all(files.map(({ f }) => readNote(f).catch(() => "")));
  return files.map(({ date }, i) => ({ date, text: texts[i].slice(-maxChars) }));
}
