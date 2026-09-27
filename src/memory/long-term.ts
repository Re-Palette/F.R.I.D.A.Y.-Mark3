/**
 * 長期記憶のインターフェース。
 *
 * 将来的に Memory Agent → Obsidian Vault を検索して関連ノートを返す想定。
 *   F.R.I.D.A.Y. → Memory Agent → Obsidian → 関連情報 → F.R.I.D.A.Y.
 *
 * Phase 1 では何も返さない実装（NoopLongTermMemory）のみ。
 * Chat Agent はこのインターフェースにだけ依存するため、
 * 実装を差し替えるだけで長期記憶を接続できる。
 */
import type { ChatMessage } from "@/core/types";

export interface MemoryRecord {
  /** 例: Obsidian ノートのパス */
  source: string;
  title?: string;
  content: string;
}

export interface LongTermMemory {
  readonly connected: boolean;
  /** 会話内容に関連する記憶を取得する */
  recall(query: string, history: ChatMessage[]): Promise<MemoryRecord[]>;
}

export class NoopLongTermMemory implements LongTermMemory {
  readonly connected = false;
  async recall(): Promise<MemoryRecord[]> {
    return [];
  }
}

let instance: LongTermMemory | undefined;

export function getLongTermMemory(): LongTermMemory {
  instance ??= new NoopLongTermMemory();
  return instance;
}
