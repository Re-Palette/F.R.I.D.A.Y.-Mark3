/**
 * GOD'S EYE VIEW（EARTH）の人工衛星の軌道データ（サーバー専用）。CelesTrak の GP データ（OMM の JSON 形式）。
 *   取得先：https://celestrak.org/NORAD/elements/gp.php?GROUP=<グループ>&FORMAT=json（決まったグループだけ）
 *   - 取得（ここ）と位置の計算（画面の satellite.js）は分ける。位置を計算するたびに取りに行かない
 *   - 実際に取れた軌道データだけを返す。失敗したときは、最後に取れたデータを「その時の取得時刻のまま」付けるだけ
 *
 * 取りに行く間隔と、失敗したときの扱い
 *   ※ CelesTrak の公式の利用規約の原文は確認できていない。以下の待ち時間は、取りに行きすぎないための
 *     慎重寄りの推定で、公式の要件ではない
 *   - 取れたデータはグループごとに 2 時間ためておき、その間は取りに行かない
 *   - 状態は「CelesTrak 全体（全グループに効く）」と「グループごと」に分けて持つ
 *     ・429（アクセスの制限）… 全体。相手の待ち時間指定（Retry-After）は短くしない。
 *       指定が無ければ 2 時間から倍にしていき、最長 24 時間（指定があれば、指定とこの値の長いほう）
 *     ・5xx・時間切れ・接続の失敗 … 全体。一時的な失敗として 15 分 → 30 分 → 60 分 → 120 分（相手の指定が長ければそちら）。
 *       5 回続いたら長期停止：24 時間後に 1 回だけ確かめ、また失敗なら再び 24 時間
 *     ・403・401・410 などの 4xx・リダイレクト … 全体を止め、原因を確かめるまで自動では取りに行かない
 *     ・404 … 同じサーバーで 24 時間以内に別のグループが取れていれば、このグループだけ止める。
 *       判断の材料が無ければ（起動したばかりなど）全体を止める（安全側）
 *     ・データの形の異常（JSON でない・配列でない・正しい衛星が 1 件も無い）… このグループだけ止め、原因を記録する。
 *       2 つのグループで起きたら全体を止める
 *   - 同時に来た要求の扱い（このサーバーの中で）
 *     ・同じグループの取得が進んでいる間に来た要求は、その結果を待って共有する（外へは 1 回だけ）
 *     ・全体の失敗（待ち時間・長期停止）の後、期限が過ぎて最初に取りに行く 1 回だけを許し、
 *       その間に来た他のグループの要求は、その結果を待ってから判断する（全体で 1 回だけ確かめる）
 *     ・全体の状態には世代番号を付ける。止めた後に届いた「止める前に出した取得」の結果は、
 *       止めた状態を解除・短縮しない（成功ならデータだけ保存し、失敗なら強める方向にだけ反映する）
 *   - 止めた状態はこのサーバーのメモリにだけある。サーバーの再起動・入れ替わり（Vercel の起動し直し・複数台）で消えることがある
 *   - 応答の本文は画面にもログにも出さない（ログは、理由・HTTP の番号・本文の大きさと大まかな種類だけ）
 */
import { getText, SourceError, type FetchLike } from "@/integrations/intel/http";
import { parseOmmList, SAT_HALT_RECHECK_MS, SAT_PARSE_MAX, type SatellitesFail, type SatellitesOk, type SatellitesResponse, type SatFailReason, type SatFailScope, type SatGroup } from "@/lib/earth/satellites";
import { safeError } from "./quakes";

const HOSTS = ["celestrak.org"];
export const SAT_CACHE_MS = 2 * 60 * 60_000;
/** 一時的な失敗のときの待ち時間（初回。続くたびに倍） */
export const SAT_TEMP_BASE_MS = 15 * 60_000;
export const SAT_TEMP_MAX_MS = 2 * 60 * 60_000;
/** 一時的な失敗がこの回数続いたら長期停止 */
export const SAT_TEMP_LIMIT = 5;
export const SAT_LONG_STOP_MS = 24 * 60 * 60_000;
/** 429 で待ち時間の指定が無いときの待ち時間（初回。続くたびに倍） */
export const SAT_RATE_BASE_MS = 2 * 60 * 60_000;
export const SAT_RATE_MAX_MS = 24 * 60 * 60_000;
/** 404 を「このグループだけの問題」とみなす根拠：この時間内に別のグループが取れていたこと */
export const SAT_404_EVIDENCE_MS = 24 * 60 * 60_000;

export const celestrakUrl = (group: SatGroup) => `https://celestrak.org/NORAD/elements/gp.php?GROUP=${encodeURIComponent(group)}&FORMAT=json`;

/** CelesTrak 全体の状態 */
interface HostState {
  /** この時刻までは外へ取りに行かない（0 は待ちなし） */
  until: number;
  /** true なら、原因を確かめるまで自動では取りに行かない（until は見ない） */
  halted: boolean;
  reason: SatFailReason | null;
  error: string;
  /** 一時的な失敗・429 が続いた回数（取れたら 0 に戻す） */
  tempCount: number;
  rateCount: number;
}
/** グループごとの状態 */
interface GroupState {
  /** 最後に取れたデータ（fetchedAt は実際に CelesTrak から取った時刻のまま） */
  last: SatellitesOk | null;
  lastOkAt: number | null;
  /** このグループだけ止めている（自動では取りに行かない） */
  halted: { error: string; badData: boolean } | null;
}

const freshHost = (): HostState => ({ until: 0, halted: false, reason: null, error: "", tempCount: 0, rateCount: 0 });
let host: HostState = freshHost();
/** 全体の状態の世代（全体の状態を変えるたびに 1 増やす） */
let hostGen = 0;
const setHost = (h: HostState) => {
  host = h;
  hostGen++;
};
const groups = new Map<SatGroup, GroupState>();
const groupState = (g: SatGroup): GroupState => {
  let s = groups.get(g);
  if (!s) groups.set(g, (s = { last: null, lastOkAt: null, halted: null }));
  return s;
};
/** グループごとの、進んでいる処理（同時に来た要求は、これを共有する） */
const inflight = new Map<SatGroup, Promise<SatResult>>();
/** 全体の失敗の後、期限が過ぎて確かめに行っている 1 回（終わるまで、他のグループは外へ行かない） */
let probe: Promise<void> | null = null;

/** テスト用 */
export function resetSatelliteCache(): void {
  host = freshHost();
  hostGen++;
  groups.clear();
  inflight.clear();
  probe = null;
}

export interface SatResult {
  res: SatellitesResponse;
  retryAfterSec?: number;
  cached: boolean;
}

type Log = (msg: string) => void;
const defaultLog: Log = (msg) => console.warn(msg);
type Opts = { now?: number; fetchImpl?: FetchLike; log?: Log };

/** 本文は出さず、大きさと大まかな種類だけ */
const bodyKind = (text: string) => {
  const t = text.trimStart();
  const kind = t === "" ? "empty" : t.startsWith("<") ? "html" : t.startsWith("[") ? "array" : t.startsWith("{") ? "object" : "text";
  return `${kind}, ${text.length} bytes`;
};

class BadData extends Error {
  constructor(
    message: string,
    public readonly detail: string,
  ) {
    super(message);
  }
}

export function getSatellites(group: SatGroup, opts: Opts = {}): Promise<SatResult> {
  // 同じグループの処理が進んでいれば、その結果を共有する（外への取得を重ねない）
  const running = inflight.get(group);
  if (running) return running;
  const p = run(group, opts).finally(() => {
    if (inflight.get(group) === p) inflight.delete(group);
  });
  inflight.set(group, p);
  return p;
}

async function run(group: SatGroup, opts: Opts): Promise<SatResult> {
  const now = opts.now ?? Date.now();
  const log = opts.log ?? defaultLog;
  const g = groupState(group);

  const fail = (error: string, reason: SatFailReason, scope: SatFailScope, retryAt: number | null, cached: boolean): SatResult => {
    const res: SatellitesFail = { ok: false, error, reason, scope, retryAt: retryAt === null ? null : new Date(retryAt).toISOString(), last: g.last };
    const wait = retryAt === null ? SAT_HALT_RECHECK_MS : retryAt - now;
    return { res, retryAfterSec: Math.max(1, Math.ceil(wait / 1000)), cached };
  };
  /** いまの全体の状態での失敗の応答（取りに行かない） */
  const hostFail = (cached: boolean) => (host.halted ? fail(host.error, "halted", "all", null, cached) : fail(host.error, host.reason ?? "temporary", "all", host.until, cached));

  /** 別のグループの確かめに相乗りして待ったときの、待ち始めた時点の全体の世代 */
  let waitedGen: number | null = null;
  for (;;) {
    // 1. 2 時間以内に取れたデータがあれば、それを返す（外へは行かない）
    if (g.last && g.lastOkAt !== null && now - g.lastOkAt < SAT_CACHE_MS) return { res: g.last, cached: true };
    // 2. 全体を止めている・待っている間は、外へ取りに行かない
    if (host.halted || now < host.until) return hostFail(true);
    // 3. このグループだけ止めている
    if (g.halted) return fail(g.halted.error, "halted", "group", null, true);
    // 4. 全体の失敗の後で、別のグループが確かめに行っている間は、その結果を待ってから判断し直す
    if (host.reason !== null && probe) {
      waitedGen = hostGen;
      await probe;
      continue;
    }
    // 5. 相乗りした確かめが、全体の状態を変えずに終わった（404・データの形の異常など、グループだけの失敗）
    //    → この要求からは新しく外へ取りに行かない（全体で 1 回だけ）。全体のいまの理由と次の確認時刻を返す
    if (waitedGen !== null && waitedGen === hostGen && host.reason !== null) return hostFail(true);
    break;
  }

  // 6. 取りに行く。全体の失敗の後なら、これが全体で 1 回だけの確かめ
  const gen = hostGen;
  const task = fetchOnce();
  if (host.reason !== null) {
    const mine: Promise<void> = task.then(
      () => {},
      () => {},
    );
    probe = mine;
    void mine.finally(() => {
      if (probe === mine) probe = null;
    });
  }
  return task;

  async function fetchOnce(): Promise<SatResult> {
    // リダイレクトには付いていかず、気づけるようにする
    let redirectStatus: number | null = null;
    const baseFetch: FetchLike = opts.fetchImpl ?? fetch;
    const fetchImpl = (async (input: string, init?: RequestInit) => {
      const res = await baseFetch(input, { ...init, redirect: "manual" });
      if ((res.status >= 300 && res.status < 400) || res.redirected) redirectStatus = res.status;
      return res;
    }) as FetchLike;

    try {
      const text = await getText(celestrakUrl(group), { hosts: HOSTS, fetchImpl, maxBytes: 2_000_000, timeoutMs: 15_000, accept: "application/json" });
      if (redirectStatus !== null) throw new SourceError("リダイレクト", redirectStatus, undefined, "redirect");
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        throw new BadData("JSON として読めませんでした", bodyKind(text));
      }
      if (!Array.isArray(json)) throw new BadData("軌道データの一覧ではありませんでした", bodyKind(text));
      const elements = parseOmmList(json, SAT_PARSE_MAX);
      if (json.length > 0 && elements.length === 0) throw new BadData("正しい軌道データが 1 件もありませんでした", bodyKind(text));
      // 取れた（0 件も正常。画面は NO DATA）。取得時刻を巻き戻さない
      const res: SatellitesOk = { ok: true, source: "CelesTrak", group, fetchedAt: new Date(now).toISOString(), elements };
      if (g.lastOkAt === null || now >= g.lastOkAt) {
        g.last = res;
        g.lastOkAt = now;
      }
      // 取りに行った後に全体の状態が変わっていれば（止めた・待ちにしたなど）、それを解除しない
      if (gen === hostGen) {
        if (host.reason !== null || host.tempCount || host.rateCount) setHost(freshHost());
      } else {
        log(`[earth/celestrak] late success ignored for host state: group=${group}`);
      }
      return { res, cached: false };
    } catch (err) {
      return onFailure(err);
    }
  }

  /** 全体の待ち時間を反映する（強める方向にだけ。止めている状態は解除しない） */
  function timed(reason: SatFailReason, wait: number, error: string, counts: { tempCount?: number; rateCount?: number }): SatResult {
    if (host.halted) return hostFail(false);
    const until = now + wait;
    if (gen === hostGen) {
      setHost({ ...host, until: Math.max(host.until, until), reason, error, ...counts });
    } else if (until > host.until) {
      // 取りに行った後に状態が変わっていた：回数は数えず、待ち時間だけ長いほうにする
      setHost({ ...host, until, reason, error });
    }
    return hostFail(false);
  }

  function onFailure(err: unknown): SatResult {
    // データの形の異常：このグループだけ止める。2 グループで起きたら全体を止める
    if (err instanceof BadData || (err instanceof SourceError && err.kind === "too-large")) {
      const what = err instanceof BadData ? err.message : "データが大きすぎました";
      const error = `CelesTrak の応答が想定した形ではありません（${what}）`;
      g.halted = { error, badData: true };
      log(`[earth/celestrak] group halted: bad data group=${group} (${err instanceof BadData ? err.detail : "too large"})`);
      const bad = [...groups.values()].filter((s) => s.halted?.badData).length;
      if (bad >= 2) return haltAll("CelesTrak の応答が複数のグループで想定した形ではありません", "bad data in 2+ groups");
      return fail(error, "halted", "group", null, false);
    }
    const se = err instanceof SourceError ? err : null;
    const status = se?.status;
    // リダイレクト（301 など）：全体を止める
    if (se && (se.kind === "redirect" || (status !== undefined && status >= 300 && status < 400))) {
      return haltAll(`CelesTrak から予期しないリダイレクトがありました${status ? `（HTTP ${status}）` : ""}`, `redirect ${status ?? "?"}`);
    }
    // 429：相手の待ち時間指定を短くしない
    if (status === 429) {
      const backoff = Math.min(SAT_RATE_BASE_MS * 2 ** host.rateCount, SAT_RATE_MAX_MS);
      const wait = Math.max(backoff, se?.retryAfterMs ?? 0);
      log(`[earth/celestrak] rate limited: HTTP 429 retry-after=${se?.retryAfterMs ?? "none"}ms wait=${wait}ms`);
      return timed("rate-limited", wait, safeError(se, "CelesTrak"), { rateCount: host.rateCount + 1 });
    }
    // 404：別のグループが最近取れていれば、このグループだけ。判断の材料が無ければ全体（安全側）
    if (status === 404) {
      const evidence = [...groups.entries()].some(([k, s]) => k !== group && s.lastOkAt !== null && now - s.lastOkAt < SAT_404_EVIDENCE_MS);
      if (evidence) {
        const error = "CelesTrak がこのグループのデータを見つけられませんでした（HTTP 404）";
        g.halted = { error, badData: false };
        log(`[earth/celestrak] group halted: HTTP 404 group=${group}`);
        return fail(error, "halted", "group", null, false);
      }
      return haltAll("CelesTrak が HTTP 404 を返しました（原因を判別できないため、全体の取得を止めています）", "HTTP 404 (no evidence)");
    }
    // 5xx・時間切れ・接続の失敗：一時的な失敗。少しずつ間を空ける。続いたら長期停止
    if ((status !== undefined && status >= 500) || se?.kind === "timeout" || se?.kind === "network") {
      const error = safeError(se, "CelesTrak");
      const count = host.reason === "long-stop" ? SAT_TEMP_LIMIT : host.tempCount + 1;
      if (count >= SAT_TEMP_LIMIT) {
        const wait = Math.max(SAT_LONG_STOP_MS, se?.retryAfterMs ?? 0);
        log(`[earth/celestrak] long stop: ${se?.kind ?? "?"} ${status ?? ""} after ${count} failures, wait=${wait}ms`);
        return timed("long-stop", wait, `${error}（失敗が続いたため、長く間を空けています）`, { tempCount: count });
      }
      const wait = Math.max(Math.min(SAT_TEMP_BASE_MS * 2 ** (count - 1), SAT_TEMP_MAX_MS), se?.retryAfterMs ?? 0);
      log(`[earth/celestrak] temporary failure #${count}: ${se?.kind ?? "?"} ${status ?? ""} wait=${wait}ms`);
      return timed("temporary", wait, error, { tempCount: count });
    }
    // 403・401・410 など、その他の 4xx・分からない失敗：全体を止める
    const error = status !== undefined ? `CelesTrak が HTTP ${status} を返しました（原因を確かめるまで取得を止めています）` : "CelesTrak のデータを読めませんでした（原因を確かめるまで取得を止めています）";
    return haltAll(error, status !== undefined ? `HTTP ${status}` : `error ${se?.kind ?? "unknown"}`);
  }

  /** 全体を止める（どの世代の結果でも、止める方向にはいつでも反映する） */
  function haltAll(error: string, cause: string): SatResult {
    setHost({ ...host, halted: true, until: 0, reason: "halted", error });
    log(`[earth/celestrak] halted (all groups): ${cause}`);
    return fail(error, "halted", "all", null, false);
  }
}
