/**
 * 手の認識（MediaPipe）の wasm を public/mediapipe/ にコピーする。
 * CDN に頼らず自分のサイトから配ることで、ライブラリと wasm の版が必ずそろう。npm run build の前に自動で実行される。
 */
import { copyFileSync, mkdirSync } from "node:fs";

const SRC = "node_modules/@mediapipe/tasks-vision/wasm";
const OUT = "public/mediapipe";
const FILES = ["vision_wasm_internal.js", "vision_wasm_internal.wasm", "vision_wasm_nosimd_internal.js", "vision_wasm_nosimd_internal.wasm"];

mkdirSync(OUT, { recursive: true });
for (const f of FILES) copyFileSync(`${SRC}/${f}`, `${OUT}/${f}`);
console.log(`copied ${FILES.length} files -> ${OUT}`);
