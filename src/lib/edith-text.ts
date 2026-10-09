/**
 * E.D.I.T.H. の情報ウィンドウの文章：Markdown の表（| a | b |）を取り出す（ほかは共通の Markdown 表示に任せる）。
 */
export type Block = { kind: "text"; text: string } | { kind: "table"; head: string[]; rows: string[][] };

/** 文章を、表の部分とそれ以外に分ける */
export function splitTables(text: string): Block[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const cells = (l: string) => l.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
  const isRow = (l: string) => /^\s*\|.*\|\s*$/.test(l);
  const isSep = (l: string) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l);
  const out: Block[] = [];
  let buf: string[] = [];
  const flush = () => {
    if (buf.join("").trim()) out.push({ kind: "text", text: buf.join("\n") });
    buf = [];
  };
  for (let i = 0; i < lines.length; i++) {
    if (isRow(lines[i]) && i + 1 < lines.length && isSep(lines[i + 1])) {
      flush();
      const head = cells(lines[i]);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && isRow(lines[i])) rows.push(cells(lines[i++]));
      i--;
      out.push({ kind: "table", head, rows });
    } else buf.push(lines[i]);
  }
  flush();
  return out;
}

