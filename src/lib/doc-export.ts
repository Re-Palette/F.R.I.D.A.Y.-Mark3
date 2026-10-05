/**
 * F.R.I.D.A.Y. が書いた資料・スライドを、PDF・PowerPoint にして保存する（画面側）。
 *   - ボタンで：この端末にダウンロード
 *   - 書いた直後に：脳（Obsidian）の Markdown と同じ場所に PDF（スライドは PDF と PowerPoint）も保存する
 * 作るのはブラウザの中（PDF の部品は必要になったときに読み込む）。
 */
import type { DocKind } from "@/core/types";
import { docFilePath } from "./brain-paths";

export interface ExportableDoc {
  title: string;
  content?: string;
  kind?: DocKind;
  path?: string;
}

/** 資料・スライドを PDF / PowerPoint の形にする */
export async function buildDoc(doc: ExportableDoc, ext: "pdf" | "pptx"): Promise<{ blob: Blob; name: string }> {
  const { fileName, markdownPdf, parseSlides, slidesPdf, slidesPptx } = await import("./doc-pdf");
  const content = doc.content ?? "";
  if (doc.kind === "slides") {
    const deck = parseSlides(doc.title, content);
    return { blob: ext === "pptx" ? await slidesPptx(deck) : await slidesPdf(deck), name: fileName(`${doc.title}_スライド`, ext) };
  }
  return { blob: await markdownPdf(doc.title, content), name: fileName(doc.title, "pdf") };
}

/** この端末に保存する（ダウンロード） */
export async function downloadDoc(doc: ExportableDoc, ext: "pdf" | "pptx"): Promise<void> {
  const { blob, name } = await buildDoc(doc, ext);
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

const toBase64 = async (blob: Blob) => {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
};

/** 脳（Obsidian）にも PDF（スライドは PowerPoint も）を保存する。保存した場所を返す */
export async function saveDocFiles(doc: ExportableDoc): Promise<string[]> {
  if (!doc.path || !doc.kind) return [];
  const saved: string[] = [];
  for (const ext of doc.kind === "slides" ? (["pdf", "pptx"] as const) : (["pdf"] as const)) {
    const { blob } = await buildDoc(doc, ext);
    const path = docFilePath(doc.path, ext);
    const res = await fetch("/api/brain/attach", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path, data: await toBase64(blob) }),
    });
    if (res.ok) saved.push(path);
  }
  return saved;
}
