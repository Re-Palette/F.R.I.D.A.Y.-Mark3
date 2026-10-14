/**
 * 圧縮された 3D モデル（Draco）を読む部品を public/draco/ にコピーする。
 * K.A.R.E.N. で外部の 3D モデルを取り込むときだけ、ここから読み込む。npm run build の前に自動で実行される。
 */
import { copyFileSync, mkdirSync } from "node:fs";

const OUT = "public/draco";
mkdirSync(OUT, { recursive: true });
for (const f of ["draco_decoder.js", "draco_decoder.wasm", "draco_wasm_wrapper.js"]) copyFileSync(`node_modules/three/examples/jsm/libs/draco/gltf/${f}`, `${OUT}/${f}`);
console.log(`copied draco -> ${OUT}`);
