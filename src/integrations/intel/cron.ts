/**
 * /api/cron/intel の中身（route.ts の GET から呼ぶ。テストでは run・env・log を差し替える）。
 *
 * 返す内容（ok と HTTP の状態の番号は health から決める。health が failed なら ok:false・500）：
 *   合言葉が違う・無い … 401 { ok:false, error }
 *   health が failed   … 500 { ok:false, ...結果, health:"failed" }（error と、万一の知らない状態）
 *   それ以外           … 200 { ok:true,  ...結果, health:"ok" | "degraded" }
 *   予期しない例外      … 500 { ok:false, status:"error", sources:{}, saved:0, stale:[], error:"…", health:"failed" }
 *                        （例外のメッセージ・スタックは返さない）
 * 実行側（GitHub Actions）は health を見て、degraded・failed をジョブの失敗にする。
 */
import { runIntel, type IntelRunResult, type IntelRunStatus } from "./collect";
import { safeEqual } from "@/lib/auth";

/** 実行の結果の健康状態。ok＝正常（何もしなかった回を含む）・degraded＝要注意（時間切れ・印の異常）・failed＝失敗 */
export type IntelHealth = "ok" | "degraded" | "failed";

/** 状態 → 健康状態。状態が増えて、ここに書き足していなければ型チェックで分かる（Record は全部の状態を要する） */
const HEALTH_BY_STATUS: Record<IntelRunStatus, IntelHealth> = {
  done: "ok",
  busy: "ok",
  disabled: "ok",
  "not-configured": "ok",
  off: "ok",
  timeout: "degraded",
  "lock-unknown": "degraded",
  "lost-lock": "degraded",
  error: "failed",
};

/** 実行の結果の状態から、健康状態を決める（知らない値は failed） */
export function intelHealth(status: IntelRunStatus): IntelHealth {
  return Object.prototype.hasOwnProperty.call(HEALTH_BY_STATUS, status) ? HEALTH_BY_STATUS[status] : "failed";
}

export interface IntelCronDeps {
  run?: () => Promise<IntelRunResult>;
  env?: Record<string, string | undefined>;
  log?: Pick<Console, "info" | "warn" | "error">;
}

/** 予期しない例外のときに返す、決まった形の結果（メッセージ・スタックは含めない） */
const UNEXPECTED: IntelRunResult = { status: "error", sources: {}, saved: 0, stale: [], error: "予期しない例外で止まりました（詳しくはサーバーのログ）" };

export async function handleIntelCron(req: Request, deps: IntelCronDeps = {}): Promise<Response> {
  const env = deps.env ?? process.env;
  const log = deps.log ?? console;
  const run = deps.run ?? (() => runIntel());

  const secret = env.CRON_SECRET?.trim();
  if (!secret || !safeEqual(req.headers.get("authorization") ?? "", `Bearer ${secret}`)) {
    return Response.json({ ok: false, error: secret ? "unauthorized" : "CRON_SECRET が設定されていません" }, { status: 401 });
  }

  let result: IntelRunResult;
  try {
    result = await run();
  } catch (err) {
    // ログには種類と短いメッセージだけ（応答には出さない）
    log.error(`[edith-intel] failed: 予期しない例外（${err instanceof Error ? `${err.name}: ${err.message.slice(0, 200)}` : "不明"}）`);
    result = UNEXPECTED;
  }

  const health = intelHealth(result.status);
  const line = `[edith-intel] ${result.status}${result.error ? `: ${result.error}` : ""}`;
  if (health === "failed") log.error(line);
  else if (health === "degraded") log.warn(line);
  else if (result.status !== "done") log.info(line);

  return Response.json(
    { ok: health !== "failed", ...result, health },
    { status: health === "failed" ? 500 : 200, headers: { "Cache-Control": "no-store" } },
  );
}
