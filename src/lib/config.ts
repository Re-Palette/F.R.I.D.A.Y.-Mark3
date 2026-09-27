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

export type ThinkingLevel = "low" | "medium" | "high";

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
function parseModels(value: string | undefined): { model: string; models: string[] } {
  const list = (value ?? "")
    .split(",")
    .map((m) => m.trim())
    .filter(Boolean);
  const models = list.length ? list : DEFAULT_MODELS;
  return { model: models[0], models };
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

/** 設定場所の案内（Vercel 上とローカルで出し分ける） */
export function settingsHint(key: string): string {
  return process.env.VERCEL
    ? `Vercel の Settings → Environment Variables で ${key} を設定し、Redeploy してください。`
    : `.env.local の ${key} を設定し、サーバーを再起動してください。`;
}
