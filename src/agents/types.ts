/**
 * すべての Agent が実装する共通インターフェース。
 * Core / Router は個々の Agent の中身を知らず、この形だけに依存する。
 */
import type { AgentId, ChatMessage } from "@/core/types";
import type { CalendarAccess } from "@/integrations/google-calendar";
import type { NewsSettings } from "@/integrations/news";
import type { LongTermMemory } from "@/memory/long-term";

export interface AgentContext {
  /** 短期記憶: 上限で切り出し済みの現在の会話（最後がユーザーの最新発言） */
  messages: ChatMessage[];
  /** 長期記憶（Obsidian の脳。未設定なら何もしない実装） */
  memory: LongTermMemory;
  /** Google カレンダー（この端末で接続済みの場合だけ） */
  calendar?: CalendarAccess;
  /** ニュースの設定と、今回ニュースをまとめて伝えるか（scheduled: 決まった時間 / asked: 頼まれた） */
  news?: { settings: NewsSettings; deliver: false | "scheduled" | "asked"; canSave: boolean };
  /** 現在時刻とタイムゾーン */
  now: Date;
  timezone: string;
  /** 音声会話モード（返答は読み上げられる） */
  voice: boolean;
  signal?: AbortSignal;
}

export interface AgentOutputChunk {
  text: string;
  finishReason?: string;
  /** 実際に応答したモデル（最初のチャンクにだけ付く） */
  model?: string;
  /** Web 検索で参照したページ */
  sources?: { title: string; uri: string }[];
  /** 返答前の準備（記憶・予定・天気の取得）にかかった時間（最初の塊にだけ付く） */
  prepMs?: number;
}

export interface Agent {
  readonly id: AgentId;
  /** UI 表示用のモデル名など */
  describe(): { model: string; ready: boolean; reason?: string };
  run(ctx: AgentContext): AsyncIterable<AgentOutputChunk>;
}
