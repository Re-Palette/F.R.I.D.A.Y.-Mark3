/**
 * F.R.I.D.A.Y. が書いた資料（Markdown）を PDF に、スライドを PDF・PowerPoint にする（ブラウザの中で作る）。
 *   資料   … A4 縦。表題・見出し・箇条書き・チェックボックス・番号・引用・表・区切り線
 *   スライド … 16:9。1 枚目は表紙、2 枚目からは見出し＋箇条書き（文字が多いときは自動で小さく）
 * スライドの Markdown は「---」の行で 1 枚ずつ区切る。「# 見出し」「## 小見出し」「- 箇条書き」「> 話す内容のメモ」。
 */
import { rgb, type PDFFont, type PDFPage } from "pdf-lib";
import { A4, ACCENT, INK, MARGIN, newPdf, printable, SOFT, SUB, WIDTH, wrap, Writer } from "./pdf-kit";

/** 見た目だけの記号を外す（**太字**・`コード`・[文字](URL) → 文字（URL）） */
function inline(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*|__(.+?)__/g, "$1$2")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, "$1（$2）")
    .replace(/<[^>]+>/g, "")
    .trim();
}

const today = () => new Intl.DateTimeFormat("ja-JP", { year: "numeric", month: "long", day: "numeric" }).format(new Date());

/** ファイル名に使えない文字を除く */
export function fileName(title: string, ext: "pdf" | "pptx"): string {
  const day = new Intl.DateTimeFormat("sv-SE").format(new Date());
  return `${day}_${(title || "資料").replace(/[\\/:*?"<>|\s]+/g, "_").slice(0, 60)}.${ext}`;
}

/** 資料（Markdown）を A4 の PDF にする */
export async function markdownPdf(title: string, markdown: string): Promise<Blob> {
  const body = markdown.replace(/\r/g, "");
  // 先頭の「# 表題」は表紙の表題として使う（本文には重ねない）
  const lines = body.split("\n");
  if (/^#\s+/.test(lines[0] ?? "")) lines.shift();
  const date = today();
  const { doc, f } = await newPdf(`F.R.I.D.A.Y. DOCUMENT${title}${date}${body}□■☑｜`);
  doc.setTitle(title);
  const w = new Writer(doc, f);

  w.text("F.R.I.D.A.Y. DOCUMENT", { size: 9, bold: true, color: ACCENT, lead: 1.2 });
  w.gap(4);
  w.text(title, { size: 20, bold: true, lead: 1.35 });
  w.gap(2);
  w.text(date, { size: 9.5, color: SUB });
  w.gap(6);
  w.page.drawLine({ start: { x: MARGIN.x, y: w.y }, end: { x: MARGIN.x + WIDTH, y: w.y }, thickness: 0.8, color: ACCENT });
  w.gap(8);

  let code = false;
  let tableRow = 0;
  for (const raw of lines) {
    const line = raw.replace(/\t/g, "  ");
    if (/^```/.test(line.trim())) {
      code = !code;
      w.gap(4);
      continue;
    }
    if (code) {
      w.text(line || " ", { size: 9, indent: 12, color: SUB, lead: 1.45 });
      continue;
    }
    if (!/^\s*\|/.test(line)) tableRow = 0;
    const t = line.trim();
    if (!t) {
      w.gap(5);
      continue;
    }
    let m: RegExpExecArray | null;
    if ((m = /^#{1,2}\s+(.+)$/.exec(t))) w.heading(inline(m[1]));
    else if ((m = /^#{3,6}\s+(.+)$/.exec(t))) {
      w.need(30);
      w.gap(6);
      w.text(inline(m[1]), { size: 11.5, bold: true });
    } else if (/^(-{3,}|\*{3,}|_{3,})$/.test(t)) {
      w.gap(6);
      w.need(10);
      w.page.drawLine({ start: { x: MARGIN.x, y: w.y }, end: { x: MARGIN.x + WIDTH, y: w.y }, thickness: 0.5, color: SUB });
      w.gap(8);
    } else if ((m = /^(\s*)[-*+]\s+\[( |x|X)\]\s+(.+)$/.exec(line))) {
      w.bullet(inline(m[3]), { mark: m[2] === " " ? "□" : "■", indent: Math.min(3, Math.floor(m[1].length / 2)) * 14 });
    } else if ((m = /^(\s*)[-*+・]\s+(.+)$/.exec(line))) {
      w.bullet(inline(m[2]), { indent: Math.min(3, Math.floor(m[1].length / 2)) * 14 });
    } else if ((m = /^(\s*)(\d{1,3})[.)]\s+(.+)$/.exec(line))) {
      w.bullet(inline(m[3]), { mark: `${m[2]}.`, indent: Math.min(3, Math.floor(m[1].length / 2)) * 14 });
    } else if ((m = /^>\s?(.*)$/.exec(t))) {
      w.text(inline(m[1]) || " ", { indent: 14, color: SUB, size: 10 });
    } else if (/^\|/.test(t)) {
      // 表：区切りの行（|---|）は飛ばし、1 行目は太字で
      if (/^\|?\s*:?-{2,}/.test(t.replace(/\|/g, "|").replace(/^\|/, ""))) continue;
      const cells = t.replace(/^\||\|$/g, "").split("|").map((c) => inline(c));
      w.text(cells.join("　｜　"), { bold: tableRow === 0, size: 10, indent: 6 });
      tableRow++;
    } else w.text(inline(t));
  }

  // ページ番号
  const total = w.pages.length;
  w.pages.forEach((p, i) => {
    const label = `${i + 1} / ${total}`;
    p.drawText(label, { x: A4.w - MARGIN.x - f.regular.widthOfTextAtSize(label, 8), y: 30, size: 8, font: f.regular, color: SUB });
    p.drawText(printable(`F.R.I.D.A.Y.　｜　${title}`).slice(0, 60), { x: MARGIN.x, y: 30, size: 8, font: f.regular, color: SUB });
  });
  return new Blob([(await doc.save()) as BlobPart], { type: "application/pdf" });
}

/* ---------- スライド ---------- */

export interface Slide {
  title: string;
  subtitle?: string;
  bullets: { text: string; level: number }[];
  /** 話す内容のメモ（PowerPoint のノートに入れる） */
  notes?: string;
}

export interface Deck {
  title: string;
  slides: Slide[];
}

/** スライドの Markdown を読む（「---」の行で 1 枚ずつ） */
export function parseSlides(title: string, markdown: string): Deck {
  const slides: Slide[] = [];
  for (const chunk of markdown.replace(/\r/g, "").split(/^\s*-{3,}\s*$/m)) {
    const s: Slide = { title: "", bullets: [] };
    const notes: string[] = [];
    for (const raw of chunk.split("\n")) {
      const line = raw.replace(/\t/g, "  ");
      const t = line.trim();
      if (!t) continue;
      let m: RegExpExecArray | null;
      if ((m = /^#\s+(.+)$/.exec(t)) && !s.title) s.title = inline(m[1]);
      else if ((m = /^#{2,6}\s+(.+)$/.exec(t))) {
        if (!s.title) s.title = inline(m[1]);
        else if (!s.subtitle && !s.bullets.length) s.subtitle = inline(m[1]);
        else s.bullets.push({ text: inline(m[1]), level: 0 });
      } else if ((m = /^>\s?(.*)$/.exec(t))) notes.push(inline(m[1]));
      else if ((m = /^(\s*)(?:[-*+・]|\d{1,2}[.)])\s+(?:\[[ xX]\]\s+)?(.+)$/.exec(line))) s.bullets.push({ text: inline(m[2]), level: Math.min(2, Math.floor(m[1].length / 2)) });
      else s.bullets.push({ text: inline(t), level: 0 });
    }
    if (notes.length) s.notes = notes.join("\n");
    if (s.title || s.bullets.length) slides.push(s);
  }
  // 1 枚目が表紙になっていなければ、表紙を足す
  if (!slides.length || slides[0].bullets.length > 1) slides.unshift({ title, subtitle: today(), bullets: [] });
  return { title, slides };
}

const SLIDE = { w: 960, h: 540 };
const DARK = rgb(0.07, 0.07, 0.08);

/** スライドを 16:9 の PDF にする */
export async function slidesPdf(deck: Deck): Promise<Blob> {
  const all = deck.slides.map((s) => [s.title, s.subtitle ?? "", ...s.bullets.map((b) => b.text)].join("")).join("");
  const { doc, f } = await newPdf(`${deck.title}${all}F.R.I.D.A.Y.`);
  doc.setTitle(deck.title);
  const pages: PDFPage[] = [];
  deck.slides.forEach((s, i) => {
    const page = doc.addPage([SLIDE.w, SLIDE.h]);
    pages.push(page);
    if (i === 0) drawCover(page, f, s);
    else drawContent(page, f, s);
  });
  pages.forEach((p, i) => {
    if (i === 0) return;
    const label = `${i + 1} / ${pages.length}`;
    p.drawText(label, { x: SLIDE.w - 48 - f.regular.widthOfTextAtSize(label, 10), y: 22, size: 10, font: f.regular, color: SUB });
    p.drawText(printable(deck.title).slice(0, 50), { x: 48, y: 22, size: 10, font: f.regular, color: SUB });
  });
  return new Blob([(await doc.save()) as BlobPart], { type: "application/pdf" });
}

function drawCover(page: PDFPage, f: { regular: PDFFont; bold: PDFFont }, s: Slide) {
  page.drawRectangle({ x: 0, y: 0, width: SLIDE.w, height: SLIDE.h, color: DARK });
  page.drawRectangle({ x: 64, y: 300, width: 8, height: 120, color: ACCENT });
  let y = 380;
  for (const line of wrap(printable(s.title), f.bold, 40, SLIDE.w - 180).slice(0, 3)) {
    page.drawText(line, { x: 92, y, size: 40, font: f.bold, color: rgb(1, 1, 1) });
    y -= 52;
  }
  if (s.subtitle) page.drawText(printable(s.subtitle).slice(0, 60), { x: 92, y: y - 6, size: 18, font: f.regular, color: rgb(1, 0.76, 0.48) });
  page.drawText("F.R.I.D.A.Y.", { x: 64, y: 48, size: 12, font: f.bold, color: ACCENT });
}

function drawContent(page: PDFPage, f: { regular: PDFFont; bold: PDFFont }, s: Slide) {
  page.drawRectangle({ x: 0, y: SLIDE.h - 8, width: SLIDE.w, height: 8, color: ACCENT });
  page.drawRectangle({ x: 48, y: SLIDE.h - 92, width: 6, height: 40, color: ACCENT });
  const titleLines = wrap(printable(s.title), f.bold, 30, SLIDE.w - 140).slice(0, 2);
  let y = SLIDE.h - 80;
  for (const line of titleLines) {
    page.drawText(line, { x: 68, y, size: 30, font: f.bold, color: INK });
    y -= 38;
  }
  if (s.subtitle) {
    page.drawText(printable(s.subtitle).slice(0, 70), { x: 68, y: y + 6, size: 16, font: f.regular, color: SUB });
    y -= 24;
  }
  // 文字が多いときは、収まる大きさまで小さくする
  const top = y - 14;
  const bottom = 56;
  let size = 28; // 文字が少ないときは大きく見せる
  let laid: { lines: string[]; level: number }[] = [];
  for (; size >= 12; size -= 1) {
    laid = s.bullets.map((b) => ({ level: b.level, lines: wrap(printable(b.text), f.regular, size - b.level * 2, SLIDE.w - 150 - b.level * 32) }));
    const h = laid.reduce((n, b) => n + b.lines.length * (size - b.level * 2) * 1.45 + size * 0.5, 0);
    if (h <= top - bottom) break;
  }
  let cy = top;
  for (const b of laid) {
    const sz = size - b.level * 2;
    const x = 80 + b.level * 32;
    b.lines.forEach((line, i) => {
      cy -= sz * 1.45;
      if (cy < bottom) return;
      if (i === 0) page.drawRectangle({ x: x - 16, y: cy + sz * 0.3, width: b.level ? 5 : 7, height: b.level ? 5 : 7, color: b.level ? SUB : ACCENT });
      page.drawText(line, { x, y: cy, size: sz, font: f.regular, color: INK });
    });
    cy -= size * 0.5;
  }
  if (!s.bullets.length) page.drawRectangle({ x: 68, y: top - 20, width: 120, height: 3, color: SOFT });
}

/** スライドを PowerPoint（.pptx）にする（あとで PowerPoint・Google スライド・Keynote で直せる） */
export async function slidesPptx(deck: Deck): Promise<Blob> {
  const { default: PptxGenJS } = await import("pptxgenjs");
  const pptx = new PptxGenJS();
  pptx.layout = "LAYOUT_WIDE";
  pptx.title = deck.title;
  const font = "Noto Sans JP";
  deck.slides.forEach((s, i) => {
    const slide = pptx.addSlide();
    if (i === 0) {
      slide.background = { color: "121214" };
      slide.addShape(pptx.ShapeType.rect, { x: 0.8, y: 2.3, w: 0.1, h: 1.6, fill: { color: "DC7319" } });
      slide.addText(s.title, { x: 1.1, y: 2.1, w: 11, h: 1.4, fontSize: 40, bold: true, color: "FFFFFF", fontFace: font });
      if (s.subtitle) slide.addText(s.subtitle, { x: 1.1, y: 3.5, w: 11, h: 0.6, fontSize: 18, color: "FFC27A", fontFace: font });
    } else {
      slide.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: 13.33, h: 0.12, fill: { color: "DC7319" } });
      slide.addText(s.title, { x: 0.7, y: 0.35, w: 12, h: 0.9, fontSize: 30, bold: true, color: "222226", fontFace: font });
      if (s.subtitle) slide.addText(s.subtitle, { x: 0.7, y: 1.15, w: 12, h: 0.5, fontSize: 16, color: "6B6B75", fontFace: font });
      if (s.bullets.length) {
        slide.addText(
          s.bullets.map((b) => ({ text: b.text, options: { bullet: true, indentLevel: b.level, fontSize: 22 - b.level * 2, breakLine: true } })),
          { x: 0.9, y: s.subtitle ? 1.8 : 1.5, w: 11.6, h: 5.2, color: "222226", fontFace: font, valign: "top", fit: "shrink", paraSpaceAfter: 8 },
        );
      }
      slide.addText(`${i + 1} / ${deck.slides.length}`, { x: 11.5, y: 7.0, w: 1.4, h: 0.3, fontSize: 10, color: "6B6B75", align: "right", fontFace: font });
    }
    if (s.notes) slide.addNotes(s.notes);
  });
  const data = (await pptx.write({ outputType: "blob" })) as Blob;
  return data;
}
