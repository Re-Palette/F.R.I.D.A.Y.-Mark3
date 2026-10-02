/**
 * フォントを、使う文字だけに絞る（HarfBuzz の hb-subset。ブラウザの中で動く wasm）。
 * PDF の部品（pdf-lib）にも絞る機能はあるが、日本語のフォントでは一部の文字が消えてしまうため、こちらで絞ってから埋め込む。
 * wasm は build 時に public/fonts/ へコピーしたもの（scripts/copy-fonts.mjs）。
 */
interface HbExports {
  memory: WebAssembly.Memory;
  malloc(size: number): number;
  free(ptr: number): void;
  hb_blob_create(data: number, length: number, mode: number, userData: number, destroy: number): number;
  hb_blob_destroy(blob: number): void;
  hb_blob_get_data(blob: number, length: number): number;
  hb_blob_get_length(blob: number): number;
  hb_face_create(blob: number, index: number): number;
  hb_face_destroy(face: number): void;
  hb_face_reference_blob(face: number): number;
  hb_set_add(set: number, codepoint: number): void;
  hb_subset_input_create_or_fail(): number;
  hb_subset_input_destroy(input: number): void;
  hb_subset_input_unicode_set(input: number): number;
  hb_subset_or_fail(face: number, input: number): number;
}

let hb: Promise<HbExports> | null = null;
function loadHb(): Promise<HbExports> {
  hb ??= (async () => {
    const res = await fetch("/fonts/hb-subset.wasm");
    if (!res.ok) throw new Error("PDF 用の部品を読み込めませんでした。");
    const { instance } = await WebAssembly.instantiate(await res.arrayBuffer(), {});
    return instance.exports as unknown as HbExports;
  })().catch((err) => {
    hb = null;
    throw err;
  });
  return hb;
}

/** font を、text に出てくる文字（＋基本的な英数字・記号）だけに絞ったフォントにする */
export async function subsetFont(font: ArrayBuffer, text: string): Promise<Uint8Array> {
  const x = await loadHb();
  const bytes = new Uint8Array(font);
  const ptr = x.malloc(bytes.byteLength);
  new Uint8Array(x.memory.buffer).set(bytes, ptr);
  const blob = x.hb_blob_create(ptr, bytes.byteLength, 2 /* HB_MEMORY_MODE_WRITABLE */, 0, 0);
  const face = x.hb_face_create(blob, 0);
  x.hb_blob_destroy(blob);
  const input = x.hb_subset_input_create_or_fail();
  if (!input) {
    x.hb_face_destroy(face);
    x.free(ptr);
    throw new Error("PDF の文字を準備できませんでした。");
  }
  const set = x.hb_subset_input_unicode_set(input);
  const chars = new Set<number>();
  for (const ch of text) chars.add(ch.codePointAt(0)!);
  for (let c = 0x20; c < 0x7f; c++) chars.add(c);
  for (const c of chars) x.hb_set_add(set, c);
  const subset = x.hb_subset_or_fail(face, input);
  x.hb_subset_input_destroy(input);
  if (!subset) {
    x.hb_face_destroy(face);
    x.free(ptr);
    throw new Error("PDF の文字を準備できませんでした。");
  }
  const out = x.hb_face_reference_blob(subset);
  const data = x.hb_blob_get_data(out, 0);
  const length = x.hb_blob_get_length(out);
  // 絞ったあとはメモリが増えていることがあるので、読み直してから写す
  const result = new Uint8Array(x.memory.buffer).slice(data, data + length);
  x.hb_blob_destroy(out);
  x.hb_face_destroy(subset);
  x.hb_face_destroy(face);
  x.free(ptr);
  if (!length) throw new Error("PDF の文字を準備できませんでした。");
  return result;
}
