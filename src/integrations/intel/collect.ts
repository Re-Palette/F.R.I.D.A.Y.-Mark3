/**
 * E.D.I.T.H. の情報収集の 1 回分（定期実行 /api/cron/intel から呼ぶ）。
 *
 *   0. EDITH_INTEL=on でなければ何もしない（脳にも外にも触れない）
 *   1. 設定ノートを読む（無ければ既定値で作る。あるノートは上書きしない）。「全体」が OFF なら終わる
 *   2. 実行中の印を取る（取れなければ、ほかの実行が動いているので終わる）
 *   3. 時刻が来た情報源だけ取りに行く（1 つ失敗しても、ほかは続ける。全体の持ち時間を超えたら次回へ）
 *   4. 保存の前に、まだ自分が印を持っているか確かめる（失っていたら何も書かない）
 *   5. 集めた情報を保存し、情報源ごとの結果（成功・失敗・次の時刻）を状態に書いて印を外す
 *
 * ここでは情報を集めて保存するだけ。メール・予定・ファイル操作などの機能は読み込まない・呼ばない。
 * 取った文章はデータとして保存するだけで、命令として扱わない。
 */
import { githubBrainIO, type IntelBrainIO } from "./brain-io";
import { SourceError, type FetchLike } from "./http";
import { activeSources, ensureSettingsNote, intelAllowedByEnv, readIntelSettings } from "./settings";
import { readItems, saveItems } from "./store";
import { acquireRun, finishRun, isDue, isStale, recordFailure, recordSuccess, sourceStatus, stillOwner, type IntelRun } from "./state";
import { uniqueById, type SourceFetcher } from "./sources/common";
import { fetchUsgs } from "./sources/usgs";
import { fetchNhc } from "./sources/nhc";
import { fetchJmaQuake, fetchJmaTyphoon } from "./sources/jma";
import type { IntelItem, IntelSourceId, IntelState } from "./types";

export const FETCHERS: Partial<Record<IntelSourceId, SourceFetcher>> = {
  usgs: fetchUsgs,
  nhc: fetchNhc,
  jma: fetchJmaQuake,
  jmatyphoon: fetchJmaTyphoon,
};

/** 1 回の実行の持ち時間（Vercel の 60 秒の打ち切りより十分前に終える） */
const RUN_BUDGET_MS = 35_000;

export type IntelRunStatus = "disabled" | "not-configured" | "off" | "busy" | "lost-lock" | "done" | "error";

export interface IntelRunResult {
  status: IntelRunStatus;
  sources: Partial<Record<IntelSourceId, { ok: boolean; count?: number; error?: string; skipped?: string }>>;
  saved: number;
  stale: IntelSourceId[];
  error?: string;
}

export interface RunOptions {
  io?: IntelBrainIO;
  now?: () => number;
  fetchImpl?: FetchLike;
  env?: Record<string, string | undefined>;
  fetchers?: Partial<Record<IntelSourceId, SourceFetcher>>;
  budgetMs?: number;
}

type Outcome = { id: IntelSourceId; ok: true; count: number; at: number } | { id: IntelSourceId; ok: false; error: SourceError | Error; at: number };

function applyOutcomes(s: IntelState, outcomes: Outcome[]): IntelState {
  let next = s;
  for (const o of outcomes) {
    next = o.ok
      ? recordSuccess(next, o.id, o.count, o.at)
      : recordFailure(
          next,
          o.id,
          { message: o.error.message, status: o.error instanceof SourceError ? o.error.status : undefined, retryAfterMs: o.error instanceof SourceError ? o.error.retryAfterMs : undefined },
          o.at,
        );
  }
  return next;
}

export async function runIntel(opts: RunOptions = {}): Promise<IntelRunResult> {
  const io = opts.io ?? githubBrainIO;
  const now = opts.now ?? Date.now;
  const env = opts.env ?? process.env;
  const fetchers = opts.fetchers ?? FETCHERS;
  const budget = opts.budgetMs ?? RUN_BUDGET_MS;
  const result: IntelRunResult = { status: "done", sources: {}, saved: 0, stale: [] };

  if (!intelAllowedByEnv(env)) return { ...result, status: "disabled" };
  if (!io.configured()) return { ...result, status: "not-configured" };

  const settings = await readIntelSettings(io);
  if (!settings.fromBrain) await ensureSettingsNote(io);
  if (!settings.enabled) return { ...result, status: "off" };

  const started = now();
  const run: IntelRun | null = await acquireRun(io, started);
  if (!run) return { ...result, status: "busy" };

  const outcomes: Outcome[] = [];
  try {
    const due = activeSources(settings, env).filter((id) => fetchers[id] && isDue(run.state, id, now()));
    const existing = due.length ? await readItems(io) : [];
    const known = new Set(existing.map((i) => i.id));
    const knownReports = new Set(existing.map((i) => i.facts.report).filter((r): r is string => typeof r === "string"));
    const collected: IntelItem[] = [];

    for (const id of due) {
      if (now() - started > budget) {
        result.sources[id] = { ok: false, skipped: "時間切れのため次回" };
        continue;
      }
      const st = sourceStatus(run.state, id);
      try {
        const items = await fetchers[id]!({
          now: now(),
          fetchImpl: opts.fetchImpl,
          known,
          knownReports,
          lastSuccessAt: st.lastSuccessAt ? Date.parse(st.lastSuccessAt) : null,
        });
        collected.push(...items);
        outcomes.push({ id, ok: true, count: items.length, at: now() });
        result.sources[id] = { ok: true, count: items.length };
      } catch (err) {
        const e = err instanceof Error ? err : new Error("取得に失敗しました");
        outcomes.push({ id, ok: false, error: e, at: now() });
        result.sources[id] = { ok: false, error: e.message.slice(0, 120) };
      }
    }

    // 保存の前に、まだ自分が印を持っているか（途中で期限が切れ、別の実行が動いていたら書かない）
    if (!(await stillOwner(io, run, now()))) return { ...result, status: "lost-lock" };
    const incoming = uniqueById(collected);
    if (incoming.length) {
      await saveItems(io, incoming, now());
      result.saved = incoming.length;
    }
    const wrote = await finishRun(io, run, (s) => applyOutcomes(s, outcomes), now());
    if (!wrote) return { ...result, status: "lost-lock" };
    const final = applyOutcomes(run.state, outcomes);
    result.stale = activeSources(settings, env).filter((id) => isStale(final, id, now()));
    return result;
  } catch (err) {
    // 途中で止まった：わかっている結果だけ記録して印を外す（書けなければ、印は期限で自然に切れる）
    await finishRun(io, run, (s) => applyOutcomes(s, outcomes), now()).catch(() => false);
    return { ...result, status: "error", error: err instanceof Error ? err.message.slice(0, 200) : "失敗しました" };
  }
}
