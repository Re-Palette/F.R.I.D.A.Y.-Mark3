/**
 * 会話に添えるファイル（写真・PDF・Word / Excel / PowerPoint・テキスト）。
 * 読み込みはすべてブラウザの中で行い、F.R.I.D.A.Y. のサーバーを通して Gemini に渡す（サーバーにも保存しない）。
 *
 *   写真        → 長い辺 1600px 以内の JPEG に縮めて、画像として渡す
 *   PDF         → 小さければそのまま渡す（図や表も読める）。大きければ文字を取り出す。文字が無い（スキャンした）PDF は、ページを画像にして渡す
 *   Word / Excel / PowerPoint → 中の文字（表・シート・スライド）を取り出して渡す
 *   テキスト・CSV・プログラムなど → そのまま文字として渡す
 *
 * Vercel は 1 回の送信を 4.5MB までしか受け付けないので、添付の合計がそれに収まるようにする。
 */
import { useSyncExternalStore } from "react";
import type { ChatFile } from "@/core/types";

export type AttachmentKind = "image" | "pdf" | "doc" | "sheet" | "slides" | "text";

export interface Attachment {
  id: string;
  name: string;
  kind: AttachmentKind;
  status: "reading" | "ready" | "error";
  error?: string;
  /** 画面に出す小さな画像（写真・PDF の 1 ページ目） */
  thumb?: string;
  /** Gemini に渡す中身（1 つのファイルが複数になることがある：スキャンした PDF のページなど） */
  files?: ChatFile[];
  /** 添えたときの一言（「大きいので文字だけ読みました」など） */
  note?: string;
}

/** 1 回に添えられる数 */
export const MAX_ATTACHMENTS = 6;
/** 画像・PDF をまとめて送れる大きさ（base64 の文字数。Vercel の 4.5MB の上限より少し小さく） */
export const MAX_BINARY_CHARS = 3_300_000;
/** 文字として渡す量の上限（ファイル 1 つ・合計） */
const MAX_TEXT_PER_FILE = 120_000;
export const MAX_TEXT_TOTAL = 250_000;
/** これより小さい PDF はそのまま渡す（図や表も読める） */
const PDF_INLINE_BYTES = 2_200_000;

const TEXT_EXT = /\.(txt|md|markdown|csv|tsv|json|jsonl|xml|html?|css|js|jsx|ts|tsx|mjs|cjs|py|rb|go|rs|java|kt|swift|c|h|cc|cpp|hpp|cs|php|sh|bash|zsh|ps1|bat|sql|ya?ml|toml|ini|cfg|conf|env\.example|log|tex|bib|srt|vtt|r|m|scala|lua|pl|dart|vue|svelte)$/i;

/* ---------- 添える予定のファイル（入力欄の上に並ぶ） ---------- */

let pending: Attachment[] = [];
const watchers = new Set<() => void>();
const publish = (next: Attachment[]) => {
  pending = next;
  watchers.forEach((w) => w());
};
const patch = (id: string, fn: (a: Attachment) => Attachment) => publish(pending.map((a) => (a.id === id ? fn(a) : a)));

export function useAttachments(): Attachment[] {
  return useSyncExternalStore(
    (fn) => (watchers.add(fn), () => watchers.delete(fn)),
    () => pending,
    () => EMPTY,
  );
}
const EMPTY: Attachment[] = [];

export function removeAttachment(id: string): void {
  publish(pending.filter((a) => a.id !== id));
}

/** 送るときに取り出す（読み込み済みのものだけ。取り出したら入力欄からは消す） */
export function takeAttachments(): Attachment[] {
  const ready = pending.filter((a) => a.status === "ready");
  publish(pending.filter((a) => a.status === "reading"));
  return ready;
}

export function attachmentsBusy(): boolean {
  return pending.some((a) => a.status === "reading");
}

/** ファイルを添える（選んだ・ドロップした・貼り付けたもの） */
export function addFiles(list: FileList | File[]): string | null {
  const files = [...list];
  if (!files.length) return null;
  const room = MAX_ATTACHMENTS - pending.length;
  if (room <= 0) return `添付は 1 回に ${MAX_ATTACHMENTS} 個までです。`;
  const added = files.slice(0, room).map<Attachment>((f) => ({
    id: `att-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    name: f.name || "貼り付けた画像.png",
    kind: kindOf(f),
    status: "reading",
  }));
  publish([...pending, ...added]);
  added.forEach((a, i) => {
    void read(files[i], a.kind)
      .then((r) => {
        patch(a.id, (x) => ({ ...x, ...r, status: "ready" }));
        const err = overBudget();
        if (err) patch(a.id, (x) => ({ ...x, status: "error", error: err, files: undefined }));
      })
      .catch((err: unknown) =>
        patch(a.id, (x) => ({ ...x, status: "error", error: err instanceof Error ? err.message : "読み込めませんでした。" })),
      );
  });
  return files.length > room ? `添付は 1 回に ${MAX_ATTACHMENTS} 個までです（${files.length - room} 個は添えませんでした）。` : null;
}

/** 添付の合計が送れる大きさを超えていないか */
function overBudget(): string | null {
  const all = pending.filter((a) => a.status === "ready").flatMap((a) => a.files ?? []);
  const binary = all.reduce((n, f) => n + (f.data?.length ?? 0), 0);
  const text = all.reduce((n, f) => n + (f.text?.length ?? 0), 0);
  if (binary > MAX_BINARY_CHARS) return "添付の合計が大きすぎます（写真・PDF は合わせて約 2.4MB まで）。数を減らしてください。";
  if (text > MAX_TEXT_TOTAL) return "添付の文字が多すぎます。ファイルを分けて聞いてください。";
  return null;
}

function kindOf(f: File): AttachmentKind {
  const n = f.name.toLowerCase();
  if (f.type.startsWith("image/") || /\.(jpe?g|png|webp|gif|bmp|heic|heif|avif)$/.test(n)) return "image";
  if (f.type === "application/pdf" || n.endsWith(".pdf")) return "pdf";
  if (n.endsWith(".docx")) return "doc";
  if (n.endsWith(".xlsx")) return "sheet";
  if (n.endsWith(".pptx")) return "slides";
  return "text";
}

/* ---------- 読み込み ---------- */

type Read = Pick<Attachment, "files" | "thumb" | "note">;

async function read(file: File, kind: AttachmentKind): Promise<Read> {
  if (kind === "image") return readImage(file);
  if (kind === "pdf") return readPdf(file);
  if (kind === "doc") return asText(file.name, await docxText(file));
  if (kind === "sheet") return asText(file.name, await xlsxText(file));
  if (kind === "slides") return asText(file.name, await pptxText(file));
  if (/\.(doc|xls|ppt)$/i.test(file.name)) throw new Error("古い形式（.doc / .xls / .ppt）は読めません。.docx / .xlsx / .pptx か PDF で保存し直して添付してください。");
  if (!file.type.startsWith("text/") && !TEXT_EXT.test(file.name) && file.type !== "application/json") {
    // 種類が分からないファイルも、中身が文字なら読む
    const head = new Uint8Array(await file.slice(0, 4096).arrayBuffer());
    if (head.includes(0)) throw new Error("この種類のファイルは読めません（写真・PDF・Word・Excel・PowerPoint・テキストに対応）。");
  }
  return asText(file.name, await file.text());
}

function asText(name: string, text: string): Read {
  const clean = text.replace(/\r\n?/g, "\n").replace(/\n{4,}/g, "\n\n\n").trim();
  if (!clean) throw new Error("文字が見つかりませんでした。");
  const cut = clean.length > MAX_TEXT_PER_FILE;
  return {
    files: [{ name, mimeType: "text/plain", text: cut ? clean.slice(0, MAX_TEXT_PER_FILE) : clean }],
    note: cut ? `長いので最初の ${MAX_TEXT_PER_FILE.toLocaleString()} 文字を読みます` : undefined,
  };
}

const toBase64 = (dataUrl: string) => dataUrl.slice(dataUrl.indexOf(",") + 1);

/** 画像を縮めて JPEG に（向きは写真の情報どおりに直す） */
async function drawScaled(src: CanvasImageSource & { width: number; height: number }, max: number, quality: number): Promise<string> {
  const scale = Math.min(1, max / Math.max(src.width, src.height));
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(src.width * scale));
  c.height = Math.max(1, Math.round(src.height * scale));
  const g = c.getContext("2d")!;
  g.fillStyle = "#fff"; // 透明な部分は白に（JPEG には透明が無い）
  g.fillRect(0, 0, c.width, c.height);
  g.drawImage(src, 0, 0, c.width, c.height);
  return c.toDataURL("image/jpeg", quality);
}

async function readImage(file: File): Promise<Read> {
  let bmp: ImageBitmap;
  try {
    bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    throw new Error("この画像は読み込めません（iPhone の HEIC など）。JPEG か PNG にして添付してください。");
  }
  const full = await drawScaled(bmp, 1600, 0.85);
  const thumb = await drawScaled(bmp, 160, 0.7);
  bmp.close();
  return { files: [{ name: file.name, mimeType: "image/jpeg", data: toBase64(full) }], thumb };
}

/* ---------- PDF ---------- */

interface PdfJs {
  GlobalWorkerOptions: { workerSrc: string };
  getDocument(src: { data: Uint8Array }): { promise: Promise<PdfDoc>; destroy(): Promise<void> };
}
interface PdfDoc {
  numPages: number;
  getPage(n: number): Promise<PdfPage>;
}
interface PdfPage {
  getViewport(o: { scale: number }): { width: number; height: number };
  getTextContent(): Promise<{ items: { str?: string; hasEOL?: boolean }[] }>;
  render(o: { canvas: HTMLCanvasElement; viewport: { width: number; height: number } }): { promise: Promise<void> };
}

let pdfjs: Promise<PdfJs> | null = null;
/** PDF の部品（pdf.js）は、build 時に public/pdfjs/ へコピーしたものを、使うときだけ読み込む */
function loadPdfJs(): Promise<PdfJs> {
  pdfjs ??= (import(/* webpackIgnore: true */ /* turbopackIgnore: true */ "/pdfjs/pdf.min.mjs" as string) as Promise<PdfJs>)
    .then((lib) => {
      lib.GlobalWorkerOptions.workerSrc = "/pdfjs/pdf.worker.min.mjs";
      return lib;
    })
    .catch((err) => {
      pdfjs = null;
      throw err;
    });
  return pdfjs;
}

async function renderPage(page: PdfPage, max: number, quality: number): Promise<string> {
  const base = page.getViewport({ scale: 1 });
  const viewport = page.getViewport({ scale: Math.min(2.5, max / Math.max(base.width, base.height)) });
  const c = document.createElement("canvas");
  c.width = Math.round(viewport.width);
  c.height = Math.round(viewport.height);
  await page.render({ canvas: c, viewport }).promise;
  return drawScaled(c, max, quality);
}

async function readPdf(file: File): Promise<Read> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let doc: PdfDoc | null = null;
  let task: { destroy(): Promise<void> } | null = null;
  let thumb: string | undefined;
  try {
    const lib = await loadPdfJs();
    const loading = lib.getDocument({ data: bytes.slice() });
    task = loading;
    doc = await loading.promise;
    thumb = await renderPage(await doc.getPage(1), 160, 0.7);
  } catch {
    if (bytes.byteLength > PDF_INLINE_BYTES) throw new Error("この PDF は読み込めませんでした（壊れている・パスワード付きなど）。");
  }
  try {
    // 小さい PDF はそのまま（図・表・手書きも Gemini が読める）
    if (bytes.byteLength <= PDF_INLINE_BYTES) {
      let bin = "";
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      return { files: [{ name: file.name, mimeType: "application/pdf", data: btoa(bin) }], thumb };
    }
    // 大きい PDF は文字を取り出す
    const d = doc!;
    const pages: string[] = [];
    let total = 0;
    for (let n = 1; n <= d.numPages && total < MAX_TEXT_PER_FILE; n++) {
      const tc = await (await d.getPage(n)).getTextContent();
      const text = tc.items.map((it) => (it.str ?? "") + (it.hasEOL ? "\n" : "")).join("").trim();
      pages.push(`--- ${n} ページ ---\n${text}`);
      total += text.length;
    }
    if (total > 200) {
      const r = asText(file.name, pages.join("\n\n"));
      return { ...r, thumb, note: r.note ?? `大きい PDF なので文字だけ読みます（${d.numPages} ページ）` };
    }
    // 文字が無い（スキャンした）PDF → 最初の数ページを画像にして渡す
    const files: ChatFile[] = [];
    let size = 0;
    for (let n = 1; n <= Math.min(d.numPages, 10); n++) {
      const data = toBase64(await renderPage(await d.getPage(n), 1400, 0.72));
      if (size + data.length > MAX_BINARY_CHARS * 0.9) break;
      size += data.length;
      files.push({ name: `${file.name}（${n} ページ）`, mimeType: "image/jpeg", data });
    }
    if (!files.length) throw new Error("この PDF は読み込めませんでした。");
    return { files, thumb, note: `スキャンした PDF なので、${files.length} ページを画像として読みます${files.length < d.numPages ? `（全 ${d.numPages} ページ中）` : ""}` };
  } finally {
    void task?.destroy().catch(() => {});
  }
}

/* ---------- Word / Excel / PowerPoint（中身は XML の入った zip） ---------- */

async function unzip(file: File): Promise<Record<string, Uint8Array>> {
  const { unzipSync } = await import("fflate");
  try {
    return unzipSync(new Uint8Array(await file.arrayBuffer()));
  } catch {
    throw new Error("ファイルを開けませんでした（壊れている・パスワード付きなど）。");
  }
}
const xml = (bytes: Uint8Array | undefined) => (bytes ? new DOMParser().parseFromString(new TextDecoder().decode(bytes), "application/xml") : null);
/** 名前空間を気にせず、タグ名（"w:t" の "t" の部分）で探す */
const tags = (root: Document | Element, local: string) => [...root.getElementsByTagNameNS("*", local)];

async function docxText(file: File): Promise<string> {
  const zip = await unzip(file);
  const doc = xml(zip["word/document.xml"]);
  if (!doc) throw new Error("Word の文書を読めませんでした。");
  const lines: string[] = [];
  const body = tags(doc, "body")[0] ?? doc.documentElement;
  for (const el of [...body.children]) {
    if (el.localName === "p") lines.push(tags(el, "t").map((t) => t.textContent ?? "").join(""));
    else if (el.localName === "tbl") {
      // 表は 1 行ずつ「 | 」で区切る
      for (const tr of tags(el, "tr")) lines.push(tags(tr, "tc").map((tc) => tags(tc, "t").map((t) => t.textContent ?? "").join("")).join(" | "));
      lines.push("");
    }
  }
  return lines.join("\n");
}

async function xlsxText(file: File): Promise<string> {
  const zip = await unzip(file);
  const shared = tags(xml(zip["xl/sharedStrings.xml"]) ?? new Document(), "si").map((si) => tags(si, "t").map((t) => t.textContent ?? "").join(""));
  const book = xml(zip["xl/workbook.xml"]);
  const names = book ? tags(book, "sheet").map((s) => s.getAttribute("name") ?? "") : [];
  const sheets = Object.keys(zip)
    .filter((p) => /^xl\/worksheets\/sheet\d+\.xml$/.test(p))
    .sort((a, b) => Number(/(\d+)\.xml$/.exec(a)![1]) - Number(/(\d+)\.xml$/.exec(b)![1]));
  const out: string[] = [];
  sheets.forEach((path, i) => {
    const sheet = xml(zip[path]);
    if (!sheet) return;
    out.push(`--- シート「${names[i] || `Sheet${i + 1}`}」 ---`);
    let rows = 0;
    for (const row of tags(sheet, "row")) {
      if (++rows > 3000) {
        out.push("（以下省略）");
        break;
      }
      const cells = tags(row, "c").map((c) => {
        const t = c.getAttribute("t");
        const v = tags(c, "v")[0]?.textContent ?? "";
        if (t === "s") return shared[Number(v)] ?? "";
        if (t === "inlineStr") return tags(c, "t").map((x) => x.textContent ?? "").join("");
        return v;
      });
      if (cells.some((x) => x)) out.push(cells.join("\t"));
    }
  });
  return out.join("\n");
}

async function pptxText(file: File): Promise<string> {
  const zip = await unzip(file);
  const slides = Object.keys(zip)
    .filter((p) => /^ppt\/slides\/slide\d+\.xml$/.test(p))
    .sort((a, b) => Number(/(\d+)\.xml$/.exec(a)![1]) - Number(/(\d+)\.xml$/.exec(b)![1]));
  return slides
    .map((path, i) => {
      const s = xml(zip[path]);
      const lines = s ? tags(s, "p").map((p) => tags(p, "t").map((t) => t.textContent ?? "").join("")).filter(Boolean) : [];
      const notesPath = `ppt/notesSlides/notesSlide${/(\d+)\.xml$/.exec(path)![1]}.xml`;
      const notes = xml(zip[notesPath]);
      const noteLines = notes ? tags(notes, "p").map((p) => tags(p, "t").map((t) => t.textContent ?? "").join("")).filter((l) => l && !/^\d+$/.test(l)) : [];
      return `--- スライド ${i + 1} ---\n${lines.join("\n")}${noteLines.length ? `\n（ノート）${noteLines.join(" ")}` : ""}`;
    })
    .join("\n\n");
}
