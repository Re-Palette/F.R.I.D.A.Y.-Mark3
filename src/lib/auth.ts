/**
 * 合言葉ロック（Web 公開時に他人が使えないようにする）。
 *
 * - FRIDAY_PASSCODE を設定すると、合言葉を入力した端末だけが使える（Cookie で記憶）。
 * - Vercel 上で FRIDAY_PASSCODE が未設定の場合は、安全のため誰も使えない状態にする。
 * - ローカル開発（npm run dev）で未設定なら、ロックなしで使える。
 */
export const AUTH_COOKIE = "friday_session";
export const AUTH_MAX_AGE = 60 * 60 * 24 * 180; // 180 日

export type AuthMode = "open" | "locked" | "misconfigured";

export function getAuthMode(): AuthMode {
  if (process.env.FRIDAY_PASSCODE?.trim()) return "locked";
  return process.env.VERCEL ? "misconfigured" : "open";
}

/** Cookie に保存するトークン（合言葉そのものは保存しない） */
export async function sessionToken(): Promise<string> {
  const passcode = process.env.FRIDAY_PASSCODE?.trim() ?? "";
  const data = new TextEncoder().encode(`friday-mark3:${passcode}`);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** タイミング差で推測されにくい文字列比較 */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
