/**
 * サーバー専用の設定。API キーはここからのみ読み込み、クライアントへは渡さない。
 * （このファイルを "use client" なコンポーネントから import しないこと）
 */
const DEFAULT_MODEL = "gemini-flash-latest";

function num(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && value !== undefined && value !== "" ? n : fallback;
}

export type ThinkingLevel = "low" | "medium" | "high";

export interface GeminiConfig {
  apiKey: string | undefined;
  model: string;
  baseUrl: string;
  thinkingLevel: ThinkingLevel | undefined;
  temperature: number;
  maxOutputTokens: number;
}

export function getGeminiConfig(): GeminiConfig {
  const level = process.env.GEMINI_THINKING_LEVEL?.trim().toLowerCase();
  return {
    apiKey: process.env.GEMINI_API_KEY?.trim() || undefined,
    model: process.env.GEMINI_MODEL?.trim() || DEFAULT_MODEL,
    // テストやプロキシ用に差し替え可能
    baseUrl: (
      process.env.GEMINI_API_BASE_URL?.trim() || "https://generativelanguage.googleapis.com/v1beta"
    ).replace(/\/+$/, ""),
    thinkingLevel:
      level === "low" || level === "medium" || level === "high"
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
