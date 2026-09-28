/**
 * 長期記憶のインターフェース。
 *
 *   F.R.I.D.A.Y. → 長期記憶 → Obsidian の脳（GitHub） → 関連ノート → F.R.I.D.A.Y.
 *
 * 脳（BRAIN_REPO / BRAIN_GITHUB_TOKEN）が設定されていれば ObsidianMemory、なければ何もしない実装を使う。
 * Chat Agent はこのインターフェースにだけ依存する。
 */
import type { ChatMessage } from "@/core/types";
import { isBrainConfigured } from "./github-brain";
import { ObsidianMemory } from "./obsidian";

export interface MemoryRecord {
  /** 例: Obsidian ノートのパス */
  source: string;
  title?: string;
  content: string;
}

export interface SaveTurnInput {
  user: string;
  assistant: string;
  /** F.R.I.D.A.Y. が覚えるべきと判断したこと */
  memories: string[];
  voice: boolean;
}

export interface LongTermMemory {
  readonly connected: boolean;
  /** 直近の読み書きが成功しているか（false なら「覚えた」と表示しない） */
  readonly healthy?: boolean;
  /** 会話内容に関連する記憶を取得する */
  recall(query: string, history: ChatMessage[]): Promise<MemoryRecord[]>;
  /** 1 往復分の会話と、覚えるべきことを保存する */
  save?(turn: SaveTurnInput): Promise<void>;
}

export class NoopLongTermMemory implements LongTermMemory {
  readonly connected = false;
  async recall(): Promise<MemoryRecord[]> {
    return [];
  }
}

const noop = new NoopLongTermMemory();
let obsidian: ObsidianMemory | undefined;

export function getLongTermMemory(): LongTermMemory {
  if (!isBrainConfigured()) return noop;
  obsidian ??= new ObsidianMemory();
  return obsidian;
}
