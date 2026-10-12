/**
 * E.D.I.T.H. の 3D 地球儀（CesiumJS）の本体と静的ファイル（Workers・Assets・ThirdParty・Widgets）を public/cesium/ にコピーする。
 * CDN に頼らず自分のサイトから配る（版が必ずそろう・外部に通信しない）。npm run build の前に自動で実行される。
 * 地球の画像は Cesium に同梱の Natural Earth II（パブリックドメイン）だけを使う（Cesium ion・外部の地図タイルは使わない）。
 */
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";

const SRC = "node_modules/cesium/Build/Cesium";
const OUT = "public/cesium";
const PARTS = ["Cesium.js", "Workers", "Assets", "ThirdParty", "Widgets"];

if (!existsSync(SRC)) throw new Error(`${SRC} が見つかりません（npm install を実行してください）`);
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
for (const p of PARTS) cpSync(`${SRC}/${p}`, `${OUT}/${p}`, { recursive: true });
console.log(`copied ${PARTS.join(", ")} -> ${OUT}`);
