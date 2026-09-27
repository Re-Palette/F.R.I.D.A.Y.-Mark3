/**
 * 軽量 Markdown レンダラー（依存なし・HTML を注入しない安全な実装）。
 * 会話で使う範囲（段落 / 見出し / 箇条書き / 番号付き / 引用 / コード / 太字 / リンク）に対応。
 */
import { memo, type ReactNode } from "react";

function renderInline(text: string, keyBase: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\[[^\]\n]+\]\((https?:\/\/[^)\s]+)\))/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const key = `${keyBase}-${i++}`;
    if (m[1]) out.push(<code key={key}>{m[1].slice(1, -1)}</code>);
    else if (m[2]) out.push(<strong key={key}>{m[2].slice(2, -2)}</strong>);
    else if (m[3]) {
      const label = m[3].slice(1, m[3].indexOf("]"));
      out.push(
        <a key={key} href={m[4]} target="_blank" rel="noreferrer noopener">
          {label}
        </a>,
      );
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function withBreaks(lines: string[], keyBase: string): ReactNode[] {
  return lines.flatMap((line, i) => {
    const nodes = renderInline(line, `${keyBase}-${i}`);
    return i < lines.length - 1 ? [...nodes, <br key={`${keyBase}-br-${i}`} />] : nodes;
  });
}

const UL = /^\s*[-*・]\s+/;
const OL = /^\s*\d+[.)]\s+/;

function MarkdownImpl({ text }: { text: string }) {
  const blocks: ReactNode[] = [];
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  let i = 0;
  let k = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (line.trim().startsWith("```")) {
      const lang = line.trim().slice(3).trim();
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith("```")) body.push(lines[i++]);
      i++; // 閉じ ``` （ストリーミング中で未到着でもよい）
      blocks.push(
        <pre key={k++} data-lang={lang || undefined}>
          <code>{body.join("\n")}</code>
        </pre>,
      );
      continue;
    }

    if (!line.trim()) {
      i++;
      continue;
    }

    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      const level = heading[1].length;
      const Tag = (level <= 2 ? "h3" : "h4") as "h3" | "h4";
      blocks.push(<Tag key={k++}>{renderInline(heading[2], `h${k}`)}</Tag>);
      i++;
      continue;
    }

    if (UL.test(line) || OL.test(line)) {
      const ordered = OL.test(line);
      const re = ordered ? OL : UL;
      const items: string[] = [];
      while (i < lines.length && re.test(lines[i])) {
        items.push(lines[i].replace(re, ""));
        i++;
        // 継続行（インデントされた行）
        while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !UL.test(lines[i]) && !OL.test(lines[i])) {
          items[items.length - 1] += "\n" + lines[i].trim();
          i++;
        }
      }
      const List = ordered ? "ol" : "ul";
      blocks.push(
        <List key={k++}>
          {items.map((it, j) => (
            <li key={j}>{withBreaks(it.split("\n"), `li${k}-${j}`)}</li>
          ))}
        </List>,
      );
      continue;
    }

    if (line.startsWith(">")) {
      const quote: string[] = [];
      while (i < lines.length && lines[i].startsWith(">")) quote.push(lines[i++].replace(/^>\s?/, ""));
      blocks.push(<blockquote key={k++}>{withBreaks(quote, `q${k}`)}</blockquote>);
      continue;
    }

    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !lines[i].trim().startsWith("```") &&
      !/^#{1,4}\s/.test(lines[i]) &&
      !UL.test(lines[i]) &&
      !OL.test(lines[i]) &&
      !lines[i].startsWith(">")
    ) {
      para.push(lines[i++]);
    }
    blocks.push(<p key={k++}>{withBreaks(para, `p${k}`)}</p>);
  }

  return <>{blocks}</>;
}

export const Markdown = memo(MarkdownImpl);
