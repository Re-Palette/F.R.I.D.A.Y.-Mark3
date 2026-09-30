/**
 * 手の認識（MediaPipe）の wasm を public/mediapipe/ にコピーする。
 * CDN に頼らず自分のサイトから配ることで、ライブラリと wasm の版が必ずそろう。npm run build の前に自動で実行される。
 */
import { copyFileSync, mkdirSync } from "node:fs";

const SRC = "node_modules/@mediapipe/tasks-vision/wasm";
const OUT = "public/mediapipe";
// 画面で動かすとき用（SIMD あり／なし）と、別の作業場所（public/hand-worker.mjs）で動かすとき用（module）
const FILES = [
  "vision_wasm_internal.js",
  "vision_wasm_internal.wasm",
  "vision_wasm_nosimd_internal.js",
  "vision_wasm_nosimd_internal.wasm",
  "vision_wasm_module_internal.js",
  "vision_wasm_module_internal.wasm",
];

mkdirSync(OUT, { recursive: true });
for (const f of FILES) copyFileSync(`${SRC}/${f}`, `${OUT}/${f}`);
// 別の作業場所から読み込むライブラリ本体
copyFileSync("node_modules/@mediapipe/tasks-vision/vision_bundle.mjs", `${OUT}/vision_bundle.mjs`);
console.log(`copied ${FILES.length + 1} files -> ${OUT}`);
