/**
 * 添付した PDF を読む部品（pdf.js）を public/pdfjs/ にコピーする。
 * 画面は PDF を添えたときだけ、ここから読み込む（ふだんの画面を重くしない）。npm run build の前に自動で実行される。
 */
import { copyFileSync, mkdirSync } from "node:fs";

const OUT = "public/pdfjs";
mkdirSync(OUT, { recursive: true });
// 古めのブラウザでも動く版（legacy）を使う
for (const f of ["pdf.min.mjs", "pdf.worker.min.mjs"]) copyFileSync(`node_modules/pdfjs-dist/legacy/build/${f}`, `${OUT}/${f}`);
console.log(`copied pdf.js -> ${OUT}`);
