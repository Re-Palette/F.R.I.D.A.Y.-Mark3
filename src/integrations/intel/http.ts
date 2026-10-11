/**
 * 情報源からの取得（サーバー専用）。どの情報源も、ここを通して取りに行く。
 *   - 決まった取得先（ホスト）だけ。転送（リダイレクト）先も同じホストでなければ使わない
 *   - 時間切れ（既定 10 秒）・大きさの上限（既定 2MB）
 *   - 429・403・5xx は失敗として返し、Retry-After（待ってほしい時間）を伝える
 * 取ったものはデータとしてだけ扱う（中の文章を命令として実行しない）。
 * 失敗は SourceError。種類（kind）で、HTTP エラー・時間切れ・通信・大きすぎる・転送・その他を見分けられる
 * （メッセージ・状態の番号・Retry-After は以前と同じ）。
 */
import type { IntelFetchErrorKind } from "./types";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export class SourceError extends Error {
  /** 失敗の種類（指定が無ければ、状態の番号があれば http、無ければ other） */
  public readonly kind: IntelFetchErrorKind;
  constructor(
    message: string,
    public readonly status?: number,
    public readonly retryAfterMs?: number,
    kind?: IntelFetchErrorKind,
  ) {
    super(message);
    this.name = "SourceError";
    this.kind = kind ?? (status !== undefined ? "http" : "other");
  }
}

export interface GetOptions {
  /** この取得先だけ許す（例 ["earthquake.usgs.gov"]） */
  hosts: string[];
  timeoutMs?: number;
  maxBytes?: number;
  accept?: string;
  fetchImpl?: FetchLike;
}

const USER_AGENT = "FRIDAY-EDITH/1.0 (personal assistant; public data reader)";

/** Retry-After（秒数か日時）をミリ秒に */
export function parseRetryAfter(v: string | null, now = Date.now()): number | undefined {
  if (!v) return undefined;
  const sec = Number(v);
  if (Number.isFinite(sec) && sec >= 0) return sec * 1000;
  const at = Date.parse(v);
  return Number.isFinite(at) && at > now ? at - now : undefined;
}

function hostAllowed(url: string, hosts: string[]): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && !u.username && !u.password && hosts.includes(u.hostname);
  } catch {
    return false;
  }
}

/** 決まった取得先から文字として取る。失敗は SourceError */
export async function getText(url: string, opts: GetOptions): Promise<string> {
  if (!hostAllowed(url, opts.hosts)) throw new SourceError(`許可していない取得先です: ${url.slice(0, 80)}`, undefined, undefined, "other");
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const maxBytes = opts.maxBytes ?? 2_000_000;
  let res: Response;
  try {
    res = await fetchImpl(url, {
      headers: { "User-Agent": USER_AGENT, Accept: opts.accept ?? "*/*" },
      signal: AbortSignal.timeout(timeoutMs),
      cache: "no-store",
      redirect: "follow",
    });
  } catch (err) {
    const name = (err as { name?: string })?.name;
    const timedOut = name === "TimeoutError" || name === "AbortError";
    throw new SourceError(timedOut ? `時間切れ（${Math.round(timeoutMs / 1000)} 秒）` : "接続できませんでした", undefined, undefined, timedOut ? "timeout" : "network");
  }
  if (res.url && !hostAllowed(res.url, opts.hosts)) {
    await res.body?.cancel().catch(() => {});
    throw new SourceError("許可していない取得先へ転送されました", undefined, undefined, "redirect");
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    throw new SourceError(res.status === 429 ? "アクセスの制限" : `HTTP ${res.status}`, res.status, parseRetryAfter(res.headers.get("retry-after")), "http");
  }
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel().catch(() => {});
    throw new SourceError("データが大きすぎます", undefined, undefined, "too-large");
  }
  // 少しずつ読んで、上限を超えたら打ち切る
  const reader = res.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new SourceError("データが大きすぎます", undefined, undefined, "too-large");
      }
      chunks.push(value);
    }
  } catch (err) {
    if (err instanceof SourceError) throw err;
    const name = (err as { name?: string })?.name;
    const timedOut = name === "TimeoutError" || name === "AbortError";
    throw new SourceError(timedOut ? `時間切れ（${Math.round(timeoutMs / 1000)} 秒）` : "読み込みに失敗しました", undefined, undefined, timedOut ? "timeout" : "network");
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function getJson<T>(url: string, opts: GetOptions): Promise<T> {
  const text = await getText(url, { accept: "application/json, application/geo+json", ...opts });
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new SourceError("データの形が正しくありません（JSON）", undefined, undefined, "other");
  }
}
