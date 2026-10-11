/**
 * インテリジェンス機能が脳（Obsidian / GitHub）を読み書きする口。
 * 既存の github-brain の関数をそのまま使う（書き込みは GitHub の sha 比較で、同時に書いた側を拒否してもらう）。
 * テストでは同じ形の偽物に差し替える。
 */
import { isBrainConfigured, readFresh, updateNote } from "@/memory/github-brain";

export interface IntelBrainIO {
  configured(): boolean;
  /** 最新の中身（無ければ null）。キャッシュを使わない */
  read(path: string): Promise<string | null>;
  /**
   * 書き換える。update は最新の中身を受け取り、新しい中身を返す（同じなら書かない）。
   * ほかの書き込みとぶつかったら、最新を読み直して update をもう一度呼ぶ。
   */
  update(path: string, update: (current: string | null) => string, message: string): Promise<void>;
}

export const githubBrainIO: IntelBrainIO = {
  configured: () => isBrainConfigured(),
  read: (path) => readFresh(path),
  update: (path, update, message) => updateNote(path, update, message),
};

/** 機械用の記録の置き場所（「.」で始まるので、ノート一覧・記憶の検索には出ない） */
export const INTEL_DIR = ".friday/intel";
export const INTEL_STATE_PATH = `${INTEL_DIR}/state.json`;
export const INTEL_ITEMS_PATH = `${INTEL_DIR}/items.json`;
/** 人が Obsidian で編集する設定 */
export const INTEL_SETTINGS_PATH = "EDITH/情報収集設定.md";
