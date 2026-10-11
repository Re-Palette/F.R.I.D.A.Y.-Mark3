/**
 * テスト用：GitHub の Contents API と同じく、読んだときの版（sha）と違えば書き込みを拒否する脳の偽物。
 * （ファイル名が .test.ts でないので、これ自体はテストとして動かない）
 */
import type { IntelBrainIO } from "../src/integrations/intel/brain-io";

export function fakeBrain(initial: Record<string, string> = {}) {
  const files = new Map<string, { text: string; sha: number }>(Object.entries(initial).map(([p, t]) => [p, { text: t, sha: 1 }]));
  let writes = 0;
  const writeLog: string[] = [];
  let beforePut: ((path: string) => void) | null = null;
  let failPut: ((path: string) => Error | null) | null = null;
  const io: IntelBrainIO = {
    configured: () => true,
    read: async (path) => files.get(path)?.text ?? null,
    update: async (path, update) => {
      for (let attempt = 0; attempt < 2; attempt++) {
        const cur = files.get(path) ?? null;
        const next = update(cur?.text ?? null);
        if (cur && next === cur.text) return;
        const hook = beforePut;
        beforePut = null;
        hook?.(path);
        const err = failPut?.(path);
        if (err) throw err;
        const now = files.get(path) ?? null;
        if ((now?.sha ?? null) !== (cur?.sha ?? null)) continue; // 409：最新を読み直してもう一度
        files.set(path, { text: next, sha: (cur?.sha ?? 0) + 1 });
        writes++;
        writeLog.push(path);
        return;
      }
      throw new Error("conflict");
    },
  };
  return {
    io,
    files,
    writeLog,
    get writes() {
      return writes;
    },
    /** 次の書き込みの直前に割り込ませる（同時実行の再現） */
    interrupt(fn: (path: string) => void) {
      beforePut = fn;
    },
    /** 書き込みを失敗させる（GitHub の 429・障害の再現） */
    failWrites(fn: ((path: string) => Error | null) | null) {
      failPut = fn;
    },
    /** 別の実行がこっそり書く */
    rawWrite(path: string, text: string) {
      const cur = files.get(path);
      files.set(path, { text, sha: (cur?.sha ?? 0) + 1 });
    },
  };
}

/** 使われたら失敗する脳（「触れないこと」を確かめる） */
export const untouchableBrain: IntelBrainIO = {
  configured: () => {
    throw new Error("脳に触れてはいけない");
  },
  read: async () => {
    throw new Error("脳に触れてはいけない");
  },
  update: async () => {
    throw new Error("脳に触れてはいけない");
  },
};
