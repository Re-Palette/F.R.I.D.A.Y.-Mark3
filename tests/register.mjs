// テスト用：TypeScript のファイルを拡張子なし（"./provider"）や "@/..." で読めるようにする（追加の依存なし）
import { register } from "node:module";
register("./resolve-ts.mjs", import.meta.url);
