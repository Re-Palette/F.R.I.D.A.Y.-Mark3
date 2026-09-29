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
  /** F.R.I.D.A.Y. が脳に覚えたこと（返答の本文には含まれない） */
  | { type: "memory"; text: string }
  /** Google カレンダーの予定を追加・変更・削除した結果（返答の本文には含まれない） */
  | { type: "calendar"; action: "add" | "update" | "delete"; ok: boolean; title: string; when: string; error?: string }
  /** Web 検索で参照したページ */
  | { type: "sources"; sources: { title: string; uri: string }[] }
  /** 脳への書き込み（ToDo の追加・完了、進捗、リマインダー）の結果 */
  | { type: "action"; kind: "todo-add" | "todo-done" | "project-progress" | "reminder"; ok: boolean; label: string; error?: string }
  /** ニュースの設定（時間・興味のある分野）を変えた結果 */
  | { type: "news-settings"; ok: boolean; time?: string; topics?: string[]; error?: string }
  /** prepMs: 返答前の準備（記憶・予定・天気の取得）にかかった時間 */
  | { type: "done"; finishReason?: string; prepMs?: number }
  | { type: "error"; code: string; message: string; retryable: boolean };

/** GET /api/status のレスポンス */
export interface StatusResponse {
  agents: Partial<Record<AgentId, { status: "online" | "offline"; model?: string; reason?: string }>>;
  context: { maxMessages: number };
  /** 読み上げの声: ElevenLabs が使えれば "elevenlabs"、なければブラウザ標準 */
  tts: { provider: "elevenlabs" | "browser"; reason?: string };
  /** Obsidian の脳（GitHub）。未設定なら configured: false */
  brain: { configured: boolean; connected: boolean; notes?: number; reason?: string };
  /** Google カレンダー（configured: サーバー側の設定あり / connected: この端末が接続済み） */
  calendar: { configured: boolean; connected: boolean; gmail?: boolean };
  /** Web 検索（auto: 必要なときだけ / always / off） */
  search: "auto" | "always" | "off";
  /** 毎日のニュース（time: "07:00" / "off"） */
  news: { time: string; topics: string[] };
}

/** 右パネルなどに表示する予定（サーバーで表示用に整えたもの） */
export interface CalendarEventView {
  id: string;
  title: string;
  start: string;
  end: string;
  allDay: boolean;
  location?: string;
  dayLabel: string;
  timeLabel: string;
  rangeLabel: string;
}

/** GET /api/calendar/events のレスポンス */
export interface CalendarResponse {
  /** GOOGLE_CLIENT_ID / SECRET が設定されているか */
  configured: boolean;
  /** この端末が接続済みか */
  connected: boolean;
  events?: CalendarEventView[];
  reason?: string;
}
