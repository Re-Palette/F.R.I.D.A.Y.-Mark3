/**
 * PDF を作る共通の道具（ブラウザの中で作る）。授業ノートの PDF・F.R.I.D.A.Y. が書いた資料の PDF・スライドで使う。
 * 日本語を表示するため、Noto Sans JP（build 時に public/fonts/ へコピー）を、使う文字だけに絞って埋め込む
 * （絞るのは HarfBuzz。pdf-lib の絞り込みは日本語の一部の文字を落とすため使わない）。
 */
import fontkit from "@pdf-lib/fontkit";
import { PDFDocument, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import { subsetFont } from "./font-subset";

export const A4 = { w: 595.28, h: 841.89 };
export const MARGIN = { x: 52, top: 60, bottom: 58 };
export const WIDTH = A4.w - MARGIN.x * 2;

export const INK = rgb(0.13, 0.13, 0.15);
export const SUB = rgb(0.42, 0.42, 0.46);
export const ACCENT = rgb(0.86, 0.45, 0.1);
export const SOFT = rgb(0.99, 0.95, 0.9);

/** 行の頭に来てはいけない文字（行末に追い出す） */
const NO_START = "、。，．,.)）」』】〕〉》！？!?ー…‥っゃゅょァィゥェォッャュョ々ゝゞヽヾ・：；:;";
/** 行の終わりに来てはいけない文字（次の行へ送る） */
const NO_END = "(（「『【〔〈《";

let fonts: Promise<{ regular: ArrayBuffer; bold: ArrayBuffer }> | null = null;
export function loadFonts() {
  fonts ??= Promise.all(
    ["/fonts/NotoSansJP-Regular.ttf", "/fonts/NotoSansJP-Bold.ttf"].map(async (url) => {
      const res = await fetch(url);
      if (!res.ok) throw new Error("PDF 用の文字（フォント）を読み込めませんでした。");
      return res.arrayBuffer();
    }),
  )
    .then(([regular, bold]) => ({ regular, bold }))
    .catch((err) => {
      fonts = null;
      throw err;
    });
  return fonts;
}

/** 文章を、幅に収まる行に分ける（英数字の単語は途中で切らない・句読点は行頭に置かない） */
export function wrap(text: string, font: PDFFont, size: number, width: number): string[] {
  const out: string[] = [];
  for (const para of text.replace(/\r/g, "").split("\n")) {
    // 英数字のまとまりは 1 つとして扱う
    const tokens = para.match(/[A-Za-z0-9][A-Za-z0-9.,'%\-_/]*|\s+|./gu) ?? [];
    let line = "";
    for (const tok of tokens) {
      const next = line + tok;
      if (!line || font.widthOfTextAtSize(next, size) <= width) {
        line = next;
        continue;
      }
      if (NO_START.includes(tok[0])) {
        // 句読点はぶら下げる（少しはみ出しても行末に置く）
        line = next;
        continue;
      }
      let carry = "";
      while (line.length > 1 && NO_END.includes(line[line.length - 1])) {
        carry = line[line.length - 1] + carry;
        line = line.slice(0, -1);
      }
      out.push(line.trimEnd());
      line = (carry + tok).trimStart();
      // 1 語が幅より長い（URL など）ときは文字単位で切る
      while (font.widthOfTextAtSize(line, size) > width && line.length > 1) {
        let cut = line.length - 1;
        while (cut > 1 && font.widthOfTextAtSize(line.slice(0, cut), size) > width) cut--;
        out.push(line.slice(0, cut));
        line = line.slice(cut);
      }
    }
    out.push(line.trimEnd());
  }
  return out;
}

/** 上付きの数字・記号（P⁻¹ など）は日本語のフォントに無いものがあるので、P^-1 のように書き直す */
const SUPER: Record<string, string> = { "⁰": "0", "¹": "1", "²": "2", "³": "3", "⁴": "4", "⁵": "5", "⁶": "6", "⁷": "7", "⁸": "8", "⁹": "9", "⁺": "+", "⁻": "-", "ⁿ": "n" };
export function printable(text: string): string {
  return text.replace(/[⁰¹²³⁴-⁹⁺⁻ⁿ]+/g, (run) => (/^[¹²³]$/.test(run) ? run : `^${[...run].map((c) => SUPER[c] ?? c).join("")}`));
}

export class Writer {
  page!: PDFPage;
  y = 0;
  pages: PDFPage[] = [];
  constructor(
    private doc: PDFDocument,
    public f: { regular: PDFFont; bold: PDFFont },
  ) {
    this.newPage();
  }
  newPage() {
    this.page = this.doc.addPage([A4.w, A4.h]);
    this.pages.push(this.page);
    this.y = A4.h - MARGIN.top;
  }
  /** 残りの高さが足りなければ改ページ */
  need(h: number) {
    if (this.y - h < MARGIN.bottom) this.newPage();
  }
  text(s: string, opts: { size?: number; bold?: boolean; color?: ReturnType<typeof rgb>; indent?: number; lead?: number; width?: number } = {}) {
    const size = opts.size ?? 10.5;
    const font = opts.bold ? this.f.bold : this.f.regular;
    const indent = opts.indent ?? 0;
    const lh = size * (opts.lead ?? 1.65);
    for (const line of wrap(printable(s), font, size, (opts.width ?? WIDTH) - indent)) {
      this.need(lh);
      this.y -= lh;
      if (line) this.page.drawText(line, { x: MARGIN.x + indent, y: this.y + (lh - size) * 0.35, size, font, color: opts.color ?? INK });
    }
  }
  gap(h: number) {
    this.y -= h;
  }
  heading(s: string) {
    this.need(48);
    this.gap(14);
    this.y -= 18;
    this.page.drawRectangle({ x: MARGIN.x, y: this.y - 3, width: 4, height: 18, color: ACCENT });
    this.page.drawText(printable(s), { x: MARGIN.x + 12, y: this.y, size: 13.5, font: this.f.bold, color: INK });
    this.gap(10);
  }
  /** 箇条書き（頭の記号の後ろに、字下げした文章。tag は右端に出す時刻） */
  bullet(s: string, opts: { mark?: string; tag?: string; indent?: number; bold?: boolean } = {}) {
    const indent = opts.indent ?? 0;
    const size = 10.5;
    const lh = size * 1.65;
    this.need(lh); // 1 行目は必ずこのページに入る
    const firstY = this.y - lh + (lh - size) * 0.35;
    const mark = opts.mark ?? "・";
    this.page.drawText(mark, { x: MARGIN.x + indent, y: firstY, size, font: this.f.bold, color: ACCENT });
    const markW = Math.max(14, this.f.bold.widthOfTextAtSize(mark, size) + 4);
    let tagW = 0;
    if (opts.tag) {
      tagW = this.f.regular.widthOfTextAtSize(opts.tag, 8.5) + 10;
      this.page.drawText(opts.tag, { x: MARGIN.x + WIDTH - tagW + 10, y: firstY + 1, size: 8.5, font: this.f.regular, color: SUB });
    }
    this.text(s, { indent: indent + markW, bold: opts.bold, width: WIDTH - tagW });
  }
}


/** 使う文字だけに絞ったフォントを埋め込んだ、新しい PDF */
export async function newPdf(usedText: string): Promise<{ doc: PDFDocument; f: { regular: PDFFont; bold: PDFFont } }> {
  const { regular, bold } = await loadFonts();
  const used = "^-+n0123456789/ ・…" + usedText;
  const [regularSub, boldSub] = await Promise.all([subsetFont(regular, used), subsetFont(bold, used)]);
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const f = { regular: await doc.embedFont(regularSub, { subset: false }), bold: await doc.embedFont(boldSub, { subset: false }) };
  doc.setCreator("F.R.I.D.A.Y. Mark3");
  return { doc, f };
}
