/**
 * 声紋認証で使う AI の実行部品（onnxruntime-web の wasm 版）を public/ort/ にコピーする。
 * 画面は声紋認証を使うときだけ、ここから読み込む（ふだんの画面を重くしない）。npm run build の前に自動で実行される。
 */
import { copyFileSync, mkdirSync } from "node:fs";

const OUT = "public/ort";
mkdirSync(OUT, { recursive: true });
for (const f of ["ort.wasm.min.mjs", "ort-wasm-simd-threaded.mjs", "ort-wasm-simd-threaded.wasm"]) copyFileSync(`node_modules/onnxruntime-web/dist/${f}`, `${OUT}/${f}`);
console.log(`copied onnxruntime-web -> ${OUT}`);
