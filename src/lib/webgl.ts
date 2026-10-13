/**
 * WebGL が使えるか・GPU の名前を、ページの中で 1 回だけ調べる（結果は覚えておく）。
 *   調べるための描画の場所（WebGL のコンテキスト）を作るのは重く（数十 ms〜）、画面を切り替えるたびに作るとカクつくので。
 *   調べ終わったら、その場所はすぐ手放す（ブラウザが同時に持てる数には限りがある）。
 */
interface Probe {
  ok: boolean;
  gpu: string | null;
}
let probe: Probe | null = null;

function run(): Probe {
  if (typeof document === "undefined") return { ok: false, gpu: null };
  try {
    const c = document.createElement("canvas");
    const gl = (c.getContext("webgl2") || c.getContext("webgl")) as WebGLRenderingContext | null;
    if (!gl) return { ok: false, gpu: null };
    let gpu: string | null = null;
    try {
      const ext = gl.getExtension("WEBGL_debug_renderer_info");
      const raw = ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : null;
      gpu = raw ? raw.replace(/ANGLE \(|\)$|Direct3D.*$|vs_\d.*$/g, "").replace(/,.*$/, "").trim().slice(0, 28) || null : null;
    } catch {
      gpu = null;
    }
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    return { ok: true, gpu };
  } catch {
    return { ok: false, gpu: null };
  }
}

/** WebGL が使えるか（使えなければ 3D を作らず、理由を出す） */
export function webglAvailable(): boolean {
  if (typeof document === "undefined") return false;
  probe ??= run();
  return probe.ok;
}

/** GPU の名前（WebGL が教えてくれる場合だけ） */
export function gpuName(): string | null {
  if (typeof document === "undefined") return null;
  probe ??= run();
  return probe.gpu;
}
