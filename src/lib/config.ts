/**
 * サーバー専用の設定。API キーはここからのみ読み込み、クライアントへは渡さない。
 * （このファイルを "use client" なコンポーネントから import しないこと）
 */
/**
 * 既定のモデル（左から順に使い、使い切り・未提供なら次へ自動で切り替える）。
 * 無料枠はモデルごとに別枠なので、Flash Lite を 2 つ並べると 1 日の上限が実質 2 倍になる。
 */
const DEFAULT_MODELS = ["gemini-3.5-flash-lite", "gemini-3.1-flash-lite"];

function num(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && value !== undefined && value !== "" ? n : fallback;
}

export type ThinkingLevel = "minimal" | "low" | "medium" | "high";

export interface GeminiConfig {
  apiKey: string | undefined;
  /** 表示用（候補の先頭） */
  model: string;
  /** 使用するモデルの候補（優先順） */
  models: string[];
  baseUrl: string;
  thinkingLevel: ThinkingLevel | undefined;
  temperature: number;
  maxOutputTokens: number;
}

/** GEMINI_MODEL はカンマ区切りで複数指定できる（例: "gemini-3.5-flash-lite,gemini-3.1-flash-lite"） */
/** 予備のモデル（GEMINI_MODEL の後ろに自動で足す）。GEMINI_BACKUP_MODELS=none で無効 */
const BACKUP_MODELS =
  process.env.GEMINI_BACKUP_MODELS?.trim().toLowerCase() === "none"
    ? []
    : (process.env.GEMINI_BACKUP_MODELS?.split(",").map((m) => m.trim()).filter(Boolean) ?? ["gemini-flash-lite-latest", "gemini-flash-latest"]);

function parseModels(value: string | undefined): { model: string; models: string[] } {
  const list = (value ?? "")
    .split(",")
    .map((m) => m.trim())
    .filter(Boolean);
  const chosen = list.length ? list : DEFAULT_MODELS;
  // 指定したモデルが混雑・使い切りのときの予備（常に最新の Flash-Lite / Flash を指す別名）。無いモデルは自動で飛ばす
  const models = [...chosen, ...BACKUP_MODELS.filter((m) => !chosen.includes(m))];
  return { model: chosen[0], models };
}

export function getGeminiConfig(): GeminiConfig {
  const level = process.env.GEMINI_THINKING_LEVEL?.trim().toLowerCase();
  return {
    apiKey: process.env.GEMINI_API_KEY?.trim() || undefined,
    ...parseModels(process.env.GEMINI_MODEL),
    // テストやプロキシ用に差し替え可能
    baseUrl: (
      process.env.GEMINI_API_BASE_URL?.trim() || "https://generativelanguage.googleapis.com/v1beta"
    ).replace(/\/+$/, ""),
    thinkingLevel:
      level === "minimal" || level === "low" || level === "medium" || level === "high"
        ? level
        : level === "off" || level === "none"
          ? undefined
          : "low",
    temperature: num(process.env.GEMINI_TEMPERATURE, 0.8),
    maxOutputTokens: num(process.env.GEMINI_MAX_OUTPUT_TOKENS, 2048),
  };
}

export interface ContextConfig {
  maxMessages: number;
  maxChars: number;
}

export function getContextConfig(): ContextConfig {
  return {
    maxMessages: Math.max(2, num(process.env.CHAT_CONTEXT_MAX_MESSAGES, 24)),
    maxChars: Math.max(2000, num(process.env.CHAT_CONTEXT_MAX_CHARS, 24000)),
  };
}

export function getTimezone(): string {
  return process.env.FRIDAY_TIMEZONE?.trim() || "Asia/Tokyo";
}

/** 設定場所の案内（Vercel 上とローカルで出し分ける） */
export function settingsHint(key: string): string {
  return process.env.VERCEL
    ? `Vercel の Settings → Environment Variables で ${key} を設定し、Redeploy してください。`
    : `.env.local の ${key} を設定し、サーバーを再起動してください。`;
}

export interface TtsConfig {
  apiKey: string | undefined;
  voiceId: string | undefined;
  model: string;
  baseUrl: string;
  /** 話す速さ（0.7〜1.2。1 が標準） */
  speed: number;
}

/** ElevenLabs（任意）。API キーと Voice ID の両方があるときだけ使う */
export function getTtsConfig(): TtsConfig {
  return {
    apiKey: process.env.ELEVENLABS_API_KEY?.trim() || undefined,
    voiceId: process.env.ELEVENLABS_VOICE_ID?.trim() || undefined,
    // 低遅延・日本語対応のモデル。音質重視なら eleven_multilingual_v2 など
    model: process.env.ELEVENLABS_MODEL?.trim() || "eleven_flash_v2_5",
    baseUrl: (process.env.ELEVENLABS_API_BASE_URL?.trim() || "https://api.elevenlabs.io").replace(/\/+$/, ""),
    speed: Math.min(1.2, Math.max(0.7, num(process.env.ELEVENLABS_SPEED, 0.95))),
  };
}

export type SearchMode = "auto" | "always" | "off";

/** Web 検索: auto（最新情報が必要な質問だけ・既定）/ always / off */
export function getSearchMode(): SearchMode {
  const v = process.env.FRIDAY_SEARCH?.trim().toLowerCase();
  return v === "always" || v === "off" ? v : "auto";
}
