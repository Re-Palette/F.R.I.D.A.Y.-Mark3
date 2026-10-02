/**
 * 授業のまとめを PDF にする（ブラウザの中で作って、そのまま保存する）。
 * 日本語を表示するため、Noto Sans JP（build 時に public/fonts/ へコピー）を、使う文字だけに絞って埋め込む
 * （絞るのは HarfBuzz。pdf-lib の絞り込みは日本語の一部の文字を落とすため使わない）。
 */
import fontkit from "@pdf-lib/fontkit";
import { PDFDocument, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import { subsetFont } from "./font-subset";
import { clock, transcriptText, type Lecture } from "./lecture";

const A4 = { w: 595.28, h: 841.89 };
const MARGIN = { x: 52, top: 60, bottom: 58 };
const WIDTH = A4.w - MARGIN.x * 2;

const INK = rgb(0.13, 0.13, 0.15);
const SUB = rgb(0.42, 0.42, 0.46);
const ACCENT = rgb(0.86, 0.45, 0.1);
const SOFT = rgb(0.99, 0.95, 0.9);

/** 行の頭に来てはいけない文字（行末に追い出す） */
const NO_START = "、。，．,.)）」』】〕〉》！？!?ー…‥っゃゅょァィゥェォッャュョ々ゝゞヽヾ・：；:;";
/** 行の終わりに来てはいけない文字（次の行へ送る） */
const NO_END = "(（「『【〔〈《";

/** PDF に決まって書く言葉・記号（フォントを絞るときに必ず入れる） */
const LABELS =
  "LECTURE NOTE全体像重要なところテストに出そうなところ授業の流れ用語課題・連絡復習チェック文字起こし（全文）" +
  "音声認識による自動の文字起こしです。聞き間違いを含むことがあります。・★■□　｜分〜（）/F.R.I.D.A.Y.0123456789:";

let fonts: Promise<{ regular: ArrayBuffer; bold: ArrayBuffer }> | null = null;
function loadFonts() {
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
function wrap(text: string, font: PDFFont, size: number, width: number): string[] {
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
function printable(text: string): string {
  return text.replace(/[⁰¹²³⁴-⁹⁺⁻ⁿ]+/g, (run) => (/^[¹²³]$/.test(run) ? run : `^${[...run].map((c) => SUPER[c] ?? c).join("")}`));
}

class Writer {
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

/** まとめ（と文字起こし）の PDF を作る */
export async function lecturePdf(lecture: Lecture, opts: { transcript: boolean }): Promise<Blob> {
  const s = lecture.summary;
  const { regular, bold } = await loadFonts();
  const title = s?.title || lecture.subject || "授業ノート";
  const date = new Date(lecture.startedAt);
  const when = new Intl.DateTimeFormat("ja-JP", { year: "numeric", month: "long", day: "numeric", weekday: "short", hour: "2-digit", minute: "2-digit" }).format(date);
  // PDF に書く文字をすべて集めて、その文字だけのフォントにする（数 MB → 数十 KB）
  const used = "^-+n" + [title, when, LABELS, JSON.stringify(lecture.summary ?? {}), lecture.subject, opts.transcript ? transcriptText(lecture.segments) : ""].join("");
  const [regularSub, boldSub] = await Promise.all([subsetFont(regular, used), subsetFont(bold, used)]);
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const f = { regular: await doc.embedFont(regularSub, { subset: false }), bold: await doc.embedFont(boldSub, { subset: false }) };
  doc.setTitle(title);
  doc.setSubject(lecture.subject);
  doc.setCreator("F.R.I.D.A.Y. Mark3");
  const w = new Writer(doc, f);

  // 表題
  w.text("LECTURE NOTE", { size: 9, bold: true, color: ACCENT, lead: 1.2 });
  w.gap(4);
  w.text(title, { size: 20, bold: true, lead: 1.35 });
  w.gap(4);
  w.text([lecture.subject, when, `${Math.max(1, Math.round(lecture.duration / 60))} 分`].filter(Boolean).join("　｜　"), { size: 9.5, color: SUB });
  w.gap(6);
  w.page.drawLine({ start: { x: MARGIN.x, y: w.y }, end: { x: MARGIN.x + WIDTH, y: w.y }, thickness: 0.8, color: ACCENT });
  w.gap(6);

  if (s) {
    if (s.overview) {
      w.heading("全体像");
      // 淡い色の枠の中に（何ページにもまたがらない長さのとき）
      const lines = wrap(printable(s.overview), f.regular, 10.5, WIDTH - 20);
      const h = lines.length * 10.5 * 1.65 + 16;
      if (h < A4.h - MARGIN.top - MARGIN.bottom - 60) {
        w.need(h);
        w.page.drawRectangle({ x: MARGIN.x, y: w.y - h, width: WIDTH, height: h, color: SOFT });
        w.gap(8);
        w.text(s.overview, { indent: 10, width: WIDTH - 10 });
        w.gap(8);
      } else w.text(s.overview);
    }
    if (s.keyPoints.length) {
      w.heading("重要なところ");
      s.keyPoints.forEach((k, i) => {
        w.bullet(k.point, { mark: `${i + 1}.`, bold: true, tag: k.time });
        if (k.detail) w.text(k.detail, { indent: 18, color: SUB, size: 10 });
        w.gap(3);
      });
    }
    if (s.exam.length) {
      w.heading("テストに出そうなところ");
      for (const e of s.exam) w.bullet(e, { mark: "★" });
    }
    if (s.outline.length) {
      w.heading("授業の流れ");
      for (const o of s.outline) {
        w.need(40);
        w.text(o.time ? `${o.heading}　（${o.time}〜）` : o.heading, { bold: true, size: 11 });
        for (const p of o.points) w.bullet(p, { indent: 6 });
        w.gap(4);
      }
    }
    if (s.terms.length) {
      w.heading("用語");
      for (const t of s.terms) {
        w.bullet(`${t.term}`, { mark: "■", bold: true });
        w.text(t.meaning, { indent: 18, size: 10 });
        w.gap(2);
      }
    }
    if (s.notices.length) {
      w.heading("課題・連絡");
      for (const n of s.notices) w.bullet(n, { mark: "□" });
    }
    if (s.review.length) {
      w.heading("復習チェック");
      for (const r of s.review) w.bullet(r, { mark: "□" });
    }
  }

  if (opts.transcript && lecture.segments.length) {
    // まとめがあるときは、文字起こしは新しいページから（まとめが無ければ、表題のすぐ下から）
    if (s) w.newPage();
    else w.gap(10);
    w.text("文字起こし（全文）", { size: 14, bold: true, lead: 1.4 });
    w.text("音声認識による自動の文字起こしです。聞き間違いを含むことがあります。", { size: 8.5, color: SUB });
    w.gap(8);
    for (const para of transcriptText(lecture.segments).split("\n")) {
      const m = /^\[([\d:]+)\]\s*/.exec(para);
      if (m) {
        w.need(30);
        w.text(m[1], { size: 8.5, bold: true, color: ACCENT, lead: 1.5 });
      }
      w.text(para.replace(/^\[[\d:]+\]\s*/, ""), { size: 9.5, lead: 1.6 });
    }
  }

  // ページ番号
  const total = w.pages.length;
  w.pages.forEach((p, i) => {
    const label = `${i + 1} / ${total}`;
    p.drawText(label, { x: A4.w - MARGIN.x - f.regular.widthOfTextAtSize(label, 8), y: 30, size: 8, font: f.regular, color: SUB });
    p.drawText(`F.R.I.D.A.Y.　｜　${title}`.slice(0, 60), { x: MARGIN.x, y: 30, size: 8, font: f.regular, color: SUB });
  });

  const bytes = await doc.save();
  return new Blob([bytes as BlobPart], { type: "application/pdf" });
}

/** PDF の名前（例：2026-10-02_線形代数_授業ノート.pdf） */
export function pdfName(lecture: Lecture): string {
  const day = new Intl.DateTimeFormat("sv-SE").format(new Date(lecture.startedAt));
  const name = (lecture.subject || lecture.summary?.title || "授業").replace(/[\\/:*?"<>|\s]+/g, "_").slice(0, 40);
  return `${day}_${name}_授業ノート.pdf`;
}

export { clock };
