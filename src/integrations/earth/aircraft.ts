/**
 * GOD'S EYE VIEW（EARTH）の飛行機（サーバー専用）。OpenSky Network の /api/states/all を、見ている範囲だけ取る。
 *   取得先：https://opensky-network.org/api/states/all?lamin=..&lomin=..&lamax=..&lomax=..
 *   - 環境変数 OPENSKY_CLIENT_ID・OPENSKY_CLIENT_SECRET があれば、OAuth2（client credentials）で取る（1 日の枠が多い）。
 *     無ければ匿名で取る（1 日の枠が少ないので、ためておく時間を長くする）。秘密の値は画面に返さない
 *   - 範囲は 0.5 度刻みにそろえ、同じ範囲は ためておいた結果を返す（認証あり 60 秒・匿名 120 秒）
 *   - 429（枠を使い切った）は、相手が言う待ち時間（X-Rate-Limit-Retry-After-Seconds）より前には取りに行かない
 *   - 実際に取れた報告だけを返す。失敗したときは作ったデータを返さない
 *   ※ OpenSky の利用条件は非商用。公式の原文の最終確認が必要
 */
import { getText, SourceError, type FetchLike } from "@/integrations/intel/http";
import { AIRCRAFT_MAX_AREA, bboxArea, bboxKey, parseOpenSky, roundBBox, type AircraftResponse, type BBox } from "@/lib/earth/aircraft";

const API = "https://opensky-network.org/api/states/all";
const TOKEN_URL = "https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token";
const HOSTS = ["opensky-network.org"];
export const AIRCRAFT_CACHE_AUTH_MS = 60_000;
export const AIRCRAFT_CACHE_ANON_MS = 120_000;
const FAIL_WAIT_MS = 60_000;
const RATE_WAIT_DEFAULT_MS = 10 * 60_000;
const MAX_CACHE_ENTRIES = 50;

type Ok = Extract<AircraftResponse, { ok: true }>;
const cache = new Map<string, { at: number; res: Ok }>();
let blockedUntil = 0;
let blockedError = "";
let token: { value: string; until: number } | null = null;

/** テスト用 */
export function resetAircraftCache(): void {
  cache.clear();
  blockedUntil = 0;
  blockedError = "";
  token = null;
}

export interface AircraftResult {
  res: AircraftResponse;
  retryAfterSec?: number;
  cached: boolean;
}

interface Creds {
  id: string;
  secret: string;
}

export function openskyCreds(env: Record<string, string | undefined> = process.env): Creds | null {
  const id = env.OPENSKY_CLIENT_ID?.trim();
  const secret = env.OPENSKY_CLIENT_SECRET?.trim();
  return id && secret ? { id, secret } : null;
}

async function getToken(creds: Creds, now: number, fetchImpl: FetchLike): Promise<string> {
  if (token && now < token.until) return token.value;
  const res = await fetchImpl(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: creds.id, client_secret: creds.secret }).toString(),
    signal: AbortSignal.timeout(10_000),
    redirect: "manual",
  });
  if (!res.ok) throw new SourceError(`認証に失敗しました（HTTP ${res.status}）`, res.status, undefined, "http");
  const j = (await res.json().catch(() => null)) as { access_token?: unknown; expires_in?: unknown } | null;
  if (!j || typeof j.access_token !== "string" || !j.access_token) throw new SourceError("認証の応答の形が想定と違います", undefined, undefined, "other");
  const life = typeof j.expires_in === "number" && j.expires_in > 60 ? j.expires_in : 1800;
  token = { value: j.access_token, until: now + (life - 60) * 1000 };
  return token.value;
}

export async function getAircraft(bbox: BBox, opts: { now?: number; fetchImpl?: FetchLike; env?: Record<string, string | undefined> } = {}): Promise<AircraftResult> {
  const now = opts.now ?? Date.now();
  const b = roundBBox(bbox);
  if (bboxArea(b) > AIRCRAFT_MAX_AREA) return { res: { ok: false, error: "範囲が広すぎます（もっと寄ると表示します）" }, cached: true };
  const creds = openskyCreds(opts.env);
  const keep = creds ? AIRCRAFT_CACHE_AUTH_MS : AIRCRAFT_CACHE_ANON_MS;
  const key = bboxKey(b);
  const hit = cache.get(key);
  if (hit && now - hit.at < keep) return { res: hit.res, cached: true };
  if (now < blockedUntil) return { res: { ok: false, error: blockedError }, retryAfterSec: Math.ceil((blockedUntil - now) / 1000), cached: true };

  const baseFetch: FetchLike = opts.fetchImpl ?? fetch;
  let retryHeader: number | null = null;
  try {
    const auth = creds ? await getToken(creds, now, baseFetch) : null;
    const fetchImpl = (async (input: string, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      if (auth) headers.set("Authorization", `Bearer ${auth}`);
      const res = await baseFetch(input, { ...init, headers, redirect: "manual" });
      const r = Number(res.headers.get("x-rate-limit-retry-after-seconds"));
      if (Number.isFinite(r) && r > 0) retryHeader = r;
      return res;
    }) as FetchLike;
    const url = `${API}?lamin=${b.lamin}&lomin=${b.lomin}&lamax=${b.lamax}&lomax=${b.lomax}`;
    const text = await getText(url, { hosts: HOSTS, fetchImpl, maxBytes: 3_000_000, timeoutMs: 12_000, accept: "application/json" });
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new SourceError("OpenSky の応答を読めませんでした", undefined, undefined, "other");
    }
    const items = parseOpenSky(json);
    const res: Ok = { ok: true, source: "OpenSky", fetchedAt: new Date(now).toISOString(), bbox: b, items };
    if (cache.size >= MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value as string);
    cache.set(key, { at: now, res });
    return { res, cached: false };
  } catch (err) {
    const se = err instanceof SourceError ? err : null;
    let wait = FAIL_WAIT_MS;
    let error = "OpenSky のデータを読めませんでした";
    if (se?.status === 429) {
      wait = Math.max(FAIL_WAIT_MS, retryHeader !== null ? retryHeader * 1000 : (se.retryAfterMs ?? RATE_WAIT_DEFAULT_MS));
      error = "OpenSky の 1 日の取得の枠を使い切りました（枠が戻るまで待っています）";
    } else if (se?.status === 401 || se?.status === 403) {
      token = null;
      wait = 10 * 60_000;
      error = creds ? "OpenSky の認証に失敗しました（ID・シークレットを確認してください）" : `OpenSky が HTTP ${se.status} を返しました`;
    } else if (se?.kind === "timeout") error = "OpenSky が時間内に応答しませんでした";
    else if (se?.kind === "network") error = "OpenSky に接続できませんでした";
    else if (se?.status) error = `OpenSky がエラーを返しました（HTTP ${se.status}）`;
    blockedUntil = now + wait;
    blockedError = error;
    return { res: { ok: false, error }, retryAfterSec: Math.ceil(wait / 1000), cached: false };
  }
}
