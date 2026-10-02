/**
 * 授業ノートの PDF に埋め込む日本語の文字（Noto Sans JP の標準・太字）を public/fonts/ にコピーする。
 * PDF を作るときだけ画面が読み込み、使った文字だけに絞って埋め込む。絞るための HarfBuzz（hb-subset の wasm）も一緒にコピーする。
 * npm run build の前に自動で実行される。
 */
import { copyFileSync, mkdirSync } from "node:fs";

const SRC = "node_modules/@expo-google-fonts/noto-sans-jp";
const OUT = "public/fonts";
const FILES = [
  ["400Regular/NotoSansJP_400Regular.ttf", "NotoSansJP-Regular.ttf"],
  ["700Bold/NotoSansJP_700Bold.ttf", "NotoSansJP-Bold.ttf"],
];

mkdirSync(OUT, { recursive: true });
for (const [from, to] of FILES) copyFileSync(`${SRC}/${from}`, `${OUT}/${to}`);
copyFileSync("node_modules/harfbuzzjs/dist/harfbuzz-subset.wasm", `${OUT}/hb-subset.wasm`);
console.log(`copied ${FILES.length} fonts + hb-subset.wasm -> ${OUT}`);
