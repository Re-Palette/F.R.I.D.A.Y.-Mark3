/**
 * F.R.I.D.A.Y. Core 全体で共有する型（クライアント／サーバー両用・依存なし）。
 */

/** 将来追加予定のものも含めた Agent ID。今回実装されているのは "chat" のみ。 */
export type AgentId =
  | "chat"
  | "search"
  | "writing"
  | "analysis"
  | "decision"
  | "memory"
  | "sns"
  | "automation";

export type Role = "user" | "assistant";

export interface ChatMessage {
  role: Role;
  content: string;
}

/** POST /api/chat のリクエストボディ */
export interface ChatRequestBody {
  messages: ChatMessage[];
  /** "voice": 音声会話（読み上げ向けの話し言葉で返答） */
  mode?: "text" | "voice";
}

/** POST /api/chat のレスポンス（NDJSON: 1行1イベント） */
export type StreamEvent =
  | { type: "meta"; agent: AgentId; model: string; contextMessages: number }
  | { type: "delta"; text: string }
  | { type: "done"; finishReason?: string }
  | { type: "error"; code: string; message: string; retryable: boolean };

/** GET /api/status のレスポンス */
export interface StatusResponse {
  agents: Partial<Record<AgentId, { status: "online" | "offline"; model?: string; reason?: string }>>;
  context: { maxMessages: number };
  /** 読み上げの声: ElevenLabs が使えれば "elevenlabs"、なければブラウザ標準 */
  tts: { provider: "elevenlabs" | "browser"; reason?: string };
}
