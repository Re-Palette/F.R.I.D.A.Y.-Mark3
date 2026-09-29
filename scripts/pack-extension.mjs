/**
 * extension/ フォルダ（Chrome 拡張機能）を public/friday-extension.zip にまとめる。
 * 設定画面の「拡張機能をダウンロード」から配る。npm run build の前に自動で実行される。
 * 依存を増やさないよう、無圧縮の ZIP を自前で書く。
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const SRC = "extension";
const OUT = "public/friday-extension.zip";
const ROOT = "friday-extension/";

const table = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = table[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

const locals = [];
const centrals = [];
let offset = 0;
for (const file of readdirSync(SRC).sort()) {
  const data = readFileSync(join(SRC, file));
  const name = Buffer.from(ROOT + file);
  const crc = crc32(data);
  const head = Buffer.alloc(30);
  head.writeUInt32LE(0x04034b50, 0);
  head.writeUInt16LE(20, 4);
  head.writeUInt16LE(0x0800, 6); // UTF-8 の名前
  head.writeUInt16LE(0, 8); // 無圧縮
  head.writeUInt32LE(0x00210000, 10); // 1980-01-01 00:00（毎回同じ中身になるように固定）
  head.writeUInt32LE(crc, 14);
  head.writeUInt32LE(data.length, 18);
  head.writeUInt32LE(data.length, 22);
  head.writeUInt16LE(name.length, 26);
  locals.push(head, name, data);

  const dir = Buffer.alloc(46);
  dir.writeUInt32LE(0x02014b50, 0);
  dir.writeUInt16LE(20, 4);
  dir.writeUInt16LE(20, 6);
  dir.writeUInt16LE(0x0800, 8);
  dir.writeUInt16LE(0, 10);
  dir.writeUInt32LE(0x00210000, 12);
  dir.writeUInt32LE(crc, 16);
  dir.writeUInt32LE(data.length, 20);
  dir.writeUInt32LE(data.length, 24);
  dir.writeUInt16LE(name.length, 28);
  dir.writeUInt32LE(offset, 42);
  centrals.push(dir, name);
  offset += head.length + name.length + data.length;
}
const central = Buffer.concat(centrals);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0);
end.writeUInt16LE(centrals.length / 2, 8);
end.writeUInt16LE(centrals.length / 2, 10);
end.writeUInt32LE(central.length, 12);
end.writeUInt32LE(offset, 16);
writeFileSync(OUT, Buffer.concat([...locals, central, end]));
console.log(`packed ${centrals.length / 2} files -> ${OUT}`);
