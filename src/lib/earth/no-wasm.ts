// satellite.js の WASM（複数スレッド版）は使わない。ビルドで読み込まないための空の部品（next.config.ts の resolveAlias で置き換える）
export default function createWasmModule(): never {
  throw new Error("WASM runtime is not used");
}
