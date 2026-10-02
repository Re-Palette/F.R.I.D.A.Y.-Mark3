/**
 * 脳（Obsidian）に保存するファイルの置き場所（画面・サーバー両用。依存なし）。
 *   添付/YYYY-MM/YYYY-MM-DD_HHmmss_<名前>   … 添えたファイルの原本
 *   資料/YYYY-MM-DD <題>.md                 … 添えたファイルの要点
 *   授業/<科目>/YYYY-MM-DD HHmm <題>.md     … 授業ノート
 */

/** ファイル名に使えない・Obsidian で困る文字を除く */
export function safeName(name: string, max = 80): string {
  const clean = name
    .replace(/[\\/:]/g, "-")
    .replace(/[*?"<>|#^[\]\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^\.+/, "")
    .trim();
  if (clean.length <= max) return clean || "無題";
  // 拡張子は残して縮める
  const ext = /\.[A-Za-z0-9]{1,6}$/.exec(clean)?.[0] ?? "";
  return clean.slice(0, max - ext.length).trim() + ext;
}

const pad = (n: number) => String(n).padStart(2, "0");
const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** 添えたファイルの原本の置き場所（時刻は送った端末の時刻） */
export function attachmentPath(name: string, at: Date): string {
  const stamp = `${ymd(at)}_${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}`;
  return `添付/${ymd(at).slice(0, 7)}/${stamp}_${safeName(name).replace(/ /g, "_")}`;
}

/** 原本の置き場所として正しい形か（サーバーで、決まった場所以外に書かせないために確かめる） */
export function isAttachmentPath(path: string): boolean {
  return /^添付\/\d{4}-\d{2}\/\d{4}-\d{2}-\d{2}_\d{6}_[^/\\]{1,90}$/.test(path) && !path.includes("..");
}

/** 授業ノートの置き場所として正しい形か */
export function isLecturePath(path: string): boolean {
  return /^授業\/[^/\\]{1,60}\/[^/\\]{1,120}\.md$/.test(path) && !path.includes("..");
}
