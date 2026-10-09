/**
 * AIProvider — F.R.I.D.A.Y. が使う AI モデルの共通の形。
 *
 *   FRIDAY Core（人格・記憶・会話の流れ・Tool＝隠しタグ）
 *        │  同じ system prompt・同じ会話・同じ隠しタグの決まり
 *        ├── GeminiProvider   （オンライン。サーバーで動く。API キーはサーバーだけ）
 *        └── LMStudioProvider （オフライン。PC の LM Studio。OpenAI 互換 API）
 *
 * モデルごとに Core を作り分けない。Provider は「system prompt と会話を受け取り、文字を少しずつ返す」ことだけをする。
 * 記憶はモデルに持たせない（毎回 Core が system prompt と会話に入れて渡す）ので、途中でモデルが替わっても続きを話せる。
 * Tool（予定・ToDo・記憶・文書など）は、返答の中の隠しタグを Core が読み取って実行するので、どのモデルでも同じ。
 */

export type AIProviderId = "gemini" | "lmstudio" | "ollama";

export interface AIMessage {
  role: "user" | "assistant";
  content: string;
}

export interface AIRequest {
  system: string;
  messages: AIMessage[];
  signal?: AbortSignal;
  maxTokens?: number;
  temperature?: number;
}

export interface AIChunk {
  text: string;
  finishReason?: string;
  /** 実際に応答したモデル（最初のチャンクにだけ付く） */
  model?: string;
  sources?: { title: string; uri: string }[];
}

export interface AIProvider {
  readonly id: AIProviderId;
  /** 画面に出す名前（例: "Gemini" / "LOCAL AI"） */
  readonly label: string;
  /** いま使えるか（実際に問い合わせて確かめる） */
  check(signal?: AbortSignal): Promise<boolean>;
  stream(req: AIRequest): AsyncIterable<AIChunk>;
}

/** Gemini が使えない（ネットが無い・枠切れ・キーが無いなど）ときに、ローカル AI に切り替えてよいエラーか */
export function shouldFallback(code: string | undefined): boolean {
  return (
    code === "NETWORK_ERROR" ||
    code === "UPSTREAM_ERROR" ||
    code === "RATE_LIMITED" ||
    code === "MISSING_API_KEY" ||
    code === "INVALID_API_KEY" ||
    code === "MODEL_NOT_FOUND" ||
    code === "UNKNOWN"
  );
}
