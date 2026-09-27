/**
 * F.R.I.D.A.Y. 共通エラー。
 * サーバー → クライアントへは code と日本語 message だけを渡す（内部情報やキーは出さない）。
 */
export type FridayErrorCode =
  | "MISSING_API_KEY"
  | "INVALID_API_KEY"
  | "MODEL_NOT_FOUND"
  | "RATE_LIMITED"
  | "SAFETY_BLOCKED"
  | "BAD_REQUEST"
  | "UPSTREAM_ERROR"
  | "NETWORK_ERROR"
  | "UNKNOWN";

export class FridayError extends Error {
  constructor(
    public readonly code: FridayErrorCode,
    message: string,
    public readonly status = 500,
    public readonly retryable = false,
  ) {
    super(message);
    this.name = "FridayError";
  }
}

export function toFridayError(err: unknown): FridayError {
  if (err instanceof FridayError) return err;
  if (err instanceof Error && err.name === "AbortError") {
    return new FridayError("UNKNOWN", "リクエストが中断されました。", 499);
  }
  return new FridayError(
    "UNKNOWN",
    "予期しないエラーが発生しました。もう一度試してください。",
    500,
    true,
  );
}
