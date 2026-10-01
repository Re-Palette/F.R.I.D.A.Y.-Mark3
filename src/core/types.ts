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

/** 会話に添える画像（カメラで写した 1 枚）。data は base64（"data:…;base64," は含まない） */
export interface ChatImage {
  mimeType: "image/jpeg" | "image/png" | "image/webp";
  data: string;
}

export interface ChatMessage {
  role: Role;
  content: string;
  /** 最新のユーザー発言にだけ付く（カメラの映像を見せて聞くとき） */
  image?: ChatImage;
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
  /** 文書を脳に保存した結果（content は画面に出す本文） */
  | { type: "document"; ok: boolean; title: string; path?: string; content?: string; updated?: boolean; error?: string }
  /** ニュースの設定（時間・興味のある分野）を変えた結果 */
  | { type: "news-settings"; ok: boolean; time?: string; topics?: string[]; error?: string }
  /** prepMs: 返答前の準備（記憶・予定・天気の取得）にかかった時間 */
  /** Web ページを開く・F.R.I.D.A.Y. が開いたタブを閉じる（実行は画面側） */
  | { type: "browser"; action: "open"; ok: boolean; url?: string; label: string; error?: string }
  | { type: "browser"; action: "close"; target: "last" | "all" }
  /** 3D ホログラムを作る（subject）・消す（null）。設計は画面が /api/hologram に頼む */
  | { type: "hologram"; subject: string | null }
  /** Spotify を操作した結果（再生・一時停止・次の曲・音量など） */
  | { type: "music"; ok: boolean; label: string; error?: string }
  /** Gmail に返信・メールの下書きを保存した結果（送信はしない） */
  | { type: "mail-draft"; ok: boolean; to: string; subject: string; error?: string }
  /** いま何をしているか（外部の情報を集めている／検索している／考えている） */
  | { type: "stage"; stage: "connect" | "think" | "search" }
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
  calendar: { configured: boolean; connected: boolean; gmail?: boolean; gmailDraft?: boolean };
  /** Spotify（configured: サーバー側の設定あり / connected: この端末が接続済み） */
  spotify?: { configured: boolean; connected: boolean };
  /** ホログラムに使う既存の 3D モデル集（Poly Pizza の API キーがあるか） */
  hologram?: { library: boolean };
  /** Web 検索（auto: 必要なときだけ / always / off） */
  search: "auto" | "always" | "off";
  /** 読み上げの速さ（SETTINGS。ブラウザの声の換算にも使う） */
  voiceSpeed: number;
  /** 自動日記（CRON_SECRET が設定されているか） */
  automation: { diary: boolean };
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
