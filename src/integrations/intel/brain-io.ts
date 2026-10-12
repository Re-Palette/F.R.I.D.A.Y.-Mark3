/**
 * インテリジェンス機能が脳（Obsidian / GitHub）を読み書きする口。
 * 既存の github-brain の関数をそのまま使う（書き込みは GitHub の sha 比較で、同時に書いた側を拒否してもらう）。
 * テストでは同じ形の偽物に差し替える。
 */
import { BrainAbortError, BrainWriteUnknownError, isBrainConfigured, readFresh, updateNote } from "@/memory/github-brain";

export interface IntelBrainIO {
  configured(): boolean;
  /** 最新の中身（無ければ null）。キャッシュを使わない。opts.signal（省略可）で止めると BrainAbortError */
  read(path: string, opts?: { signal?: AbortSignal }): Promise<string | null>;
  /**
   * 書き換える。update は最新の中身を受け取り、新しい中身を返す（同じなら書かない）。
   * ほかの書き込みとぶつかったら、最新を読み直して update をもう一度呼ぶ。
   * opts.signal（省略可）で止めると、新しい書き込み・再試行を始めずに BrainAbortError を出す（abortInfo で見分ける）。
   */
  update(path: string, update: (current: string | null) => string, message: string, opts?: { signal?: AbortSignal }): Promise<void>;
}

/** 止めたことによる失敗か。maybeWritten は、書き込みを送った後に止めた（反映されたか分からない）か */
export function abortInfo(err: unknown): { maybeWritten: boolean } | null {
  return err instanceof BrainAbortError ? { maybeWritten: err.maybeWritten } : null;
}
/** 書き込みを送った後の通信の失敗・5xx で、反映されたか分からない失敗か（signal を渡した update だけが出す） */
export function isWriteUnknown(err: unknown): boolean {
  return err instanceof BrainWriteUnknownError;
}
export { BrainAbortError, BrainWriteUnknownError };

export const githubBrainIO: IntelBrainIO = {
  configured: () => isBrainConfigured(),
  read: (path, opts) => readFresh(path, opts),
  update: (path, update, message, opts) => updateNote(path, update, message, opts),
};

/** 機械用の記録の置き場所（「.」で始まるので、ノート一覧・記憶の検索には出ない） */
export const INTEL_DIR = ".friday/intel";
export const INTEL_STATE_PATH = `${INTEL_DIR}/state.json`;
export const INTEL_ITEMS_PATH = `${INTEL_DIR}/items.json`;
/** フィードの観測の記録（直近の状態と履歴。Phase 3。observation-store.ts） */
export const INTEL_OBSERVATIONS_PATH = `${INTEL_DIR}/observations.json`;
/** 人が Obsidian で編集する設定 */
export const INTEL_SETTINGS_PATH = "EDITH/情報収集設定.md";
