/**
 * Gemini 接続のヘルスチェック（キャッシュ付き）とウォームアップ。
 *
 * - checkGemini: API キー / モデル名を実際に検証する。結果は数分キャッシュする。
 * - warmGemini : 入力中に呼び、TLS 接続を事前確立しておく（送信時の接続待ちを省く）。
 *   Node の fetch はアイドル接続を数秒で閉じるため、入力中に数秒おきに呼ぶ想定。
 */
import { getGeminiConfig } from "@/lib/config";
import type { FridayError } from "@/lib/errors";
import { pingGemini } from "./gemini";

const OK_TTL = 5 * 60_000;
const FAIL_TTL = 15_000;
const WARM_INTERVAL = 2_500;

let cache: { key: string; at: number; error: FridayError | null } | undefined;
let inflight: Promise<FridayError | null> | undefined;
let lastWarm = 0;

export async function checkGemini(): Promise<FridayError | null> {
  const config = getGeminiConfig();
  const key = `${config.apiKey ?? ""}::${config.model}::${config.baseUrl}`;
  const now = Date.now();
  if (cache && cache.key === key && now - cache.at < (cache.error ? FAIL_TTL : OK_TTL)) return cache.error;

  inflight ??= pingGemini(config, AbortSignal.timeout(8000)).finally(() => {
    inflight = undefined;
  });
  const error = await inflight;
  cache = { key, at: Date.now(), error };
  lastWarm = Date.now();
  return error;
}

export function warmGemini(): void {
  const config = getGeminiConfig();
  if (!config.apiKey) return;
  const now = Date.now();
  if (now - lastWarm < WARM_INTERVAL) return;
  lastWarm = now;
  void pingGemini(config, AbortSignal.timeout(5000));
}
