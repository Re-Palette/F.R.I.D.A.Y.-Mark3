/**
 * E.D.I.T.H. Phase 3-2 の修正：観測の記録の保存を止める（signal）・終了処理の時間。
 * 通信はしない。GitHub の口（gh・getFile・putFile・updateNote）は、globalThis.fetch を手元の偽物に差し替えて確かめる
 * （偽物は GitHub の Contents API と同じく、sha が違えば 409 で拒否する）。
 */
import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { FeedObservation, IntelItem, IntelSourceId } from "../src/integrations/intel/types";
import type { IntelBrainIO } from "../src/integrations/intel/brain-io";
import type { SourceContext } from "../src/integrations/intel/sources/common";

process.env.BRAIN_REPO = "owner/brain";
process.env.BRAIN_GITHUB_TOKEN = "test-token";
process.env.BRAIN_GITHUB_API_BASE = "https://brain.test";

const { updateNote, BrainAbortError, BrainError, BrainWriteUnknownError } = await import("../src/memory/github-brain");
const { githubBrainIO, INTEL_SETTINGS_PATH, INTEL_STATE_PATH, INTEL_ITEMS_PATH, INTEL_OBSERVATIONS_PATH } = await import("../src/integrations/intel/brain-io");
const { recordObservation, parseObservationStore } = await import("../src/integrations/intel/observation-store");
const { runIntel, observationSaveDeadline, runDeadlines, canStartSource, PLATFORM_LIMIT_MS, SOURCE_MAX_MS, SOURCE_MAX_MS_BY_ID, SOURCE_REQUEST_TIMEOUT_MS } = await import("../src/integrations/intel/collect");
const { renderSettingsNote, defaultSettings } = await import("../src/integrations/intel/settings");
const { parseState } = await import("../src/integrations/intel/state");
const { parseItems } = await import("../src/integrations/intel/store");
const { parseUsgs } = await import("../src/integrations/intel/sources/usgs");
const { fakeBrain } = await import("./intel-fake");

const NOW = Date.parse("2026-10-11T12:55:00.000Z");
const ON = { EDITH_INTEL: "on" };

/* ---------- GitHub の Contents API の偽物（globalThis.fetch に差し替える） ---------- */

type Call = { method: string; path: string };
/** PUT の扱いを差し替える（返り値が undefined なら通常どおり） */
type PutHook = (path: string, signal: AbortSignal) => Promise<Response | undefined> | Response | undefined;

const realFetch = globalThis.fetch;
const b64 = (t: string) => Buffer.from(t, "utf8").toString("base64");

/** signal で止められるまで待ち、止められたら fetch と同じく AbortError で失敗する */
const hangUntilAborted = (signal: AbortSignal) =>
  new Promise<never>((_, reject) => {
    if (signal.aborted) reject(new DOMException("aborted", "AbortError"));
    signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
  });

function fakeGitHub(initial: Record<string, string> = {}) {
  const files = new Map<string, { text: string; sha: string }>(Object.entries(initial).map(([p, t], i) => [p, { text: t, sha: `s${i}` }]));
  const calls: Call[] = [];
  const events: string[] = [];
  let seq = 100;
  let putHook: PutHook | null = null;
  let getHook: ((path: string, signal: AbortSignal) => Promise<Response | undefined> | Response | undefined) | null = null;
  const signals: AbortSignal[] = [];
  const fn = async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    assert.equal(url.origin, "https://brain.test", "決まった偽物の宛先だけ");
    const m = /^\/repos\/owner\/brain\/contents\/(.+)$/.exec(url.pathname);
    assert.ok(m, url.pathname);
    const path = decodeURIComponent(m[1]);
    const method = init.method ?? "GET";
    const signal = init.signal as AbortSignal;
    signals.push(signal);
    calls.push({ method, path });
    if (signal?.aborted) throw new DOMException("aborted", "AbortError");
    if (method === "GET") {
      const hooked = await getHook?.(path, signal);
      if (hooked) return hooked;
      const f = files.get(path);
      return f ? Response.json({ content: b64(f.text), sha: f.sha }) : new Response("not found", { status: 404 });
    }
    const hooked = await putHook?.(path, signal);
    if (hooked) return hooked;
    const body = JSON.parse(String(init.body)) as { content: string; sha?: string };
    const cur = files.get(path);
    if ((cur?.sha ?? undefined) !== body.sha) return new Response("conflict", { status: 409 });
    files.set(path, { text: Buffer.from(body.content, "base64").toString("utf8"), sha: `s${seq++}` });
    events.push(`put:${path}`);
    return Response.json({ content: { sha: files.get(path)!.sha } }, { status: 200 });
  };
  globalThis.fetch = fn as typeof fetch;
  return {
    files,
    calls,
    events,
    signals,
    onPut(h: PutHook | null) {
      putHook = h;
    },
    onGet(h: typeof getHook) {
      getHook = h;
    },
    puts: (path?: string) => calls.filter((c) => c.method === "PUT" && (!path || c.path === path)).length,
    gets: (path?: string) => calls.filter((c) => c.method === "GET" && (!path || c.path === path)).length,
  };
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

function aborted(maybeWritten: boolean) {
  return (err: unknown) => {
    assert.ok(err instanceof BrainAbortError, String(err));
    assert.equal(err.code, "BRAIN_ABORTED");
    assert.equal(err.maybeWritten, maybeWritten);
    return true;
  };
}

/* ---------- 1. GitHub の口：止めた後は新しい書き込み・再試行を始めない ---------- */

describe("updateNote：signal で止める", () => {
  const P = "notes/x.md";

  it("書き込み（PUT）の途中で止めたら、反映されたか分からない（maybeWritten）。再試行しない", async () => {
    const gh = fakeGitHub({ [P]: "old" });
    const stop = new AbortController();
    gh.onPut((_, signal) => {
      setTimeout(() => stop.abort(), 5);
      return hangUntilAborted(signal);
    });
    await assert.rejects(updateNote(P, () => "new", "m", { signal: stop.signal }), aborted(true));
    assert.deepEqual(gh.calls, [
      { method: "GET", path: P },
      { method: "PUT", path: P },
    ]);
    assert.equal(gh.files.get(P)!.text, "old");
  });

  it("1 回目の書き込みがぶつかった（409）直後に止めたら、読み直し・2 回目の書き込みを始めない", async () => {
    const gh = fakeGitHub({ [P]: "old" });
    const stop = new AbortController();
    gh.onPut(() => {
      stop.abort(); // 409 の応答と同時に止める
      return new Response("conflict", { status: 409 });
    });
    await assert.rejects(updateNote(P, () => "new", "m", { signal: stop.signal }), aborted(false)); // 409 は反映されていない
    assert.equal(gh.puts(), 1);
    assert.equal(gh.gets(), 1);
  });

  it("読み込みの途中・書き換えの直後に止めたら、書き込みを始めない", async () => {
    const gh = fakeGitHub({ [P]: "old" });
    const stop = new AbortController();
    gh.onGet((_, signal) => {
      setTimeout(() => stop.abort(), 5);
      return hangUntilAborted(signal);
    });
    await assert.rejects(updateNote(P, () => "new", "m", { signal: stop.signal }), aborted(false));
    assert.equal(gh.puts(), 0);

    const gh2 = fakeGitHub({ [P]: "old" });
    const stop2 = new AbortController();
    await assert.rejects(
      updateNote(P, () => (stop2.abort(), "new"), "m", { signal: stop2.signal }), // 書き換えの関数の中で止める（読み込みの後・書き込みの前）
      aborted(false),
    );
    assert.equal(gh2.puts(), 0);
    assert.equal(gh2.files.get(P)!.text, "old");
  });

  it("始める前に止まっていたら、GitHub に何も送らない", async () => {
    const gh = fakeGitHub({ [P]: "old" });
    const stop = new AbortController();
    stop.abort();
    await assert.rejects(updateNote(P, () => "new", "m", { signal: stop.signal }), aborted(false));
    assert.equal(gh.calls.length, 0);
  });

  it("signal を渡さない呼び出しは、これまでどおり（ぶつかったら 1 回だけ読み直して書く・8 秒の打ち切りの signal は付く）", async () => {
    const gh = fakeGitHub({ [P]: "old" });
    let first = true;
    gh.onPut((path) => {
      if (first) {
        first = false;
        gh.files.set(path, { text: "other", sha: "s-other" }); // 別の書き込みが先に入った
        return new Response("conflict", { status: 409 });
      }
      return undefined;
    });
    await updateNote(P, (cur) => `${cur}+mine`, "m");
    assert.equal(gh.files.get(P)!.text, "other+mine");
    assert.deepEqual(
      gh.calls.map((c) => c.method),
      ["GET", "PUT", "GET", "PUT"],
    );
    for (const s of gh.signals) {
      assert.ok(s instanceof AbortSignal);
      assert.equal(s.aborted, false);
    }
  });

  it("signal を渡さない呼び出しの通信の失敗は、これまでどおり BRAIN_NETWORK（止めた扱いにしない）", async () => {
    globalThis.fetch = (async () => {
      throw new TypeError("network down");
    }) as typeof fetch;
    await assert.rejects(updateNote(P, () => "new", "m"), (err: unknown) => err instanceof BrainError && !(err instanceof BrainAbortError) && err.code === "BRAIN_NETWORK");
    // signal を渡しても、止めていなければ止めた扱いにしない
    await assert.rejects(updateNote(P, () => "new", "m", { signal: new AbortController().signal }), (err: unknown) => err instanceof BrainError && err.code === "BRAIN_NETWORK");
  });

  it("AbortSignal.any が無い Node（20.0〜20.2）でも、止められる", async () => {
    const any = AbortSignal.any;
    try {
      (AbortSignal as { any?: unknown }).any = undefined;
      const gh = fakeGitHub({ [P]: "old" });
      const stop = new AbortController();
      gh.onPut((_, signal) => {
        setTimeout(() => stop.abort(), 5);
        return hangUntilAborted(signal);
      });
      await assert.rejects(updateNote(P, () => "new", "m", { signal: stop.signal }), aborted(true));
      assert.equal(gh.puts(), 1);
    } finally {
      (AbortSignal as { any?: unknown }).any = any;
    }
  });

  it("githubBrainIO.update も signal を渡す", async () => {
    const gh = fakeGitHub({ [P]: "old" });
    const stop = new AbortController();
    stop.abort();
    await assert.rejects(githubBrainIO.update(P, () => "new", "m", { signal: stop.signal }), aborted(false));
    assert.equal(gh.calls.length, 0);
  });
});

/* ---------- 2. 観測の記録の保存：止めたときの分類 ---------- */

const iso = (t: number) => new Date(t).toISOString();
function okObs(at: number): FeedObservation {
  return {
    source: "jmatyphoon",
    fetchedAt: iso(at),
    status: "ok",
    failure: null,
    feedLastModified: null,
    feedNewestEntryAt: iso(at - 60_000),
    entryCount: 10,
    typhoonEntryCount: 1,
    streams: [{ stream: "VPTW61", latestAt: iso(at - 3600_000), latestReport: "20261011114000_0_VPTW61_010000", recentAt: [iso(at - 3600_000)], bulletin: "already-known", itemId: null, reportAt: null, docError: null }],
  };
}

describe("recordObservation：止めたときは、分からない（aborted）と書いていない（aborted-before-write）を分ける", () => {
  const ioThrowing = (err: unknown, seen?: { signal?: AbortSignal }[]): IntelBrainIO => ({
    configured: () => true,
    read: async () => null,
    update: async (_p, _u, _m, opts) => {
      seen?.push({ signal: opts?.signal });
      throw err;
    },
  });

  it("書き込みを送った後に止めた → aborted（failed ではない）", async () => {
    const seen: { signal?: AbortSignal }[] = [];
    const stop = new AbortController();
    const r = await recordObservation(ioThrowing(new BrainAbortError(true), seen), okObs(NOW), { signal: stop.signal });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.error.code, "aborted");
    assert.equal(seen[0].signal, stop.signal); // 口に signal を渡している
  });

  it("書き込みを送る前に止めた → aborted-before-write", async () => {
    const r = await recordObservation(ioThrowing(new BrainAbortError(false)), okObs(NOW), { signal: new AbortController().signal });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.error.code, "aborted-before-write");
  });

  it("始める前に止まっていたら、口を呼ばずに aborted-before-write", async () => {
    const seen: { signal?: AbortSignal }[] = [];
    const stop = new AbortController();
    stop.abort();
    const r = await recordObservation(ioThrowing(new Error("呼ばれない"), seen), okObs(NOW), { signal: stop.signal });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.error.code, "aborted-before-write");
    assert.equal(seen.length, 0);
  });

  it("止めた後の見分けのつかない失敗は、分からない（aborted）側に倒す。止めていなければ write-failed のまま", async () => {
    const stop = new AbortController();
    stop.abort();
    const io: IntelBrainIO = {
      configured: () => true,
      read: async () => null,
      update: async () => {
        throw new Error("なにかの失敗");
      },
    };
    const live = new AbortController();
    const r1 = await recordObservation(io, okObs(NOW), { signal: live.signal });
    if (!r1.ok) assert.equal(r1.error.code, "write-failed");
    // 呼び出しの途中で止まった場合
    const midway = new AbortController();
    const io2: IntelBrainIO = { ...io, update: async () => (midway.abort(), Promise.reject(new Error("なにかの失敗"))) };
    const r2 = await recordObservation(io2, okObs(NOW), { signal: midway.signal });
    if (!r2.ok) assert.equal(r2.error.code, "aborted");
  });

  it("signal を渡さない呼び出しは、これまでどおり（口に signal を渡さない）", async () => {
    const b = fakeBrain();
    const seen: unknown[] = [];
    const io: IntelBrainIO = { ...b.io, update: (p, u, m, o) => (seen.push(o), b.io.update(p, u, m, o)) };
    const r = await recordObservation(io, okObs(NOW));
    assert.equal(r.ok, true);
    assert.deepEqual(seen, [undefined]);
  });
});

/* ---------- 3. 収集の 1 回分：止めた後は、保存の処理が終わってから finishRun ---------- */

function settingsWith(...ids: IntelSourceId[]): string {
  const s = defaultSettings();
  for (const k of Object.keys(s.sources) as IntelSourceId[]) s.sources[k] = ids.includes(k);
  return renderSettingsNote(s);
}

const someItems = (id: string): IntelItem[] =>
  parseUsgs(
    { type: "FeatureCollection", features: [{ id, geometry: { coordinates: [140, 35, 10] }, properties: { mag: 5, place: "x", time: NOW - 60_000, updated: NOW, status: "reviewed" } }] },
    NOW,
  ).map((i) => ({ ...i, source: "jmatyphoon" as const, id: `jmatyphoon:${id}` }));

const observing = (o: FeedObservation, items: IntelItem[]) => async (ctx: SourceContext) => {
  ctx.observe?.(o);
  return items;
};

describe("runIntel（本物の GitHub の口＋偽の GitHub）：観測の記録の保存を止める", () => {
  let gh: ReturnType<typeof fakeGitHub>;
  beforeEach(() => {
    gh = fakeGitHub({ [INTEL_SETTINGS_PATH]: settingsWith("jmatyphoon") });
  });

  it("書き込みの途中で止めたら unknown。観測の記録の書き込みは 1 回だけで、止まってから状態の書き込み（finishRun）を始める", async () => {
    let obsSettledAt = -1;
    gh.onPut((path, signal) => {
      if (path !== INTEL_OBSERVATIONS_PATH) return undefined;
      return hangUntilAborted(signal).catch((e) => {
        obsSettledAt = gh.calls.length; // 止まった時点までの呼び出しの数
        throw e;
      });
    });
    const r = await runIntel({ io: githubBrainIO, env: ON, now: () => NOW, observationSaveWaitMs: 20, fetchers: { jmatyphoon: observing(okObs(NOW), someItems("a")) } });
    assert.equal(r.status, "done");
    assert.deepEqual(r.observations, { saved: 0, skipped: 0, failed: 0, unknown: 1, codes: ["aborted"] });
    assert.equal(gh.puts(INTEL_OBSERVATIONS_PATH), 1); // 再試行しない
    assert.equal(gh.files.has(INTEL_OBSERVATIONS_PATH), false);
    // 呼び出しの順番：…観測の記録の PUT → （止まる）→ 状態の GET・PUT（finishRun）
    const order = gh.calls.map((c) => `${c.method}:${c.path}`);
    const obsPut = order.indexOf(`PUT:${INTEL_OBSERVATIONS_PATH}`);
    const lastStateGet = order.lastIndexOf(`GET:${INTEL_STATE_PATH}`);
    assert.ok(obsPut >= 0 && obsPut < lastStateGet, order.join(" "));
    assert.ok(obsSettledAt >= 0 && obsSettledAt <= lastStateGet, "止まる前に finishRun を始めていない");
    // 情報源の状態・次の時刻・印は正しく記録されている
    const s = parseState(gh.files.get(INTEL_STATE_PATH)!.text);
    assert.equal(s.lock, null);
    assert.equal(s.sources.jmatyphoon?.lastCount, 1);
    assert.equal(s.sources.jmatyphoon?.failures, 0);
    assert.equal(s.sources.jmatyphoon?.nextAllowedAt, new Date(NOW + 60 * 60_000).toISOString());
    assert.equal(parseItems(gh.files.get(INTEL_ITEMS_PATH)!.text).length, 1);
  });

  it("読み込みの途中で止めたら skipped（書いていない）。観測の記録への書き込みは 0 回", async () => {
    gh.onGet((path, signal) => (path === INTEL_OBSERVATIONS_PATH ? hangUntilAborted(signal) : undefined));
    const r = await runIntel({ io: githubBrainIO, env: ON, now: () => NOW, observationSaveWaitMs: 20, fetchers: { jmatyphoon: observing(okObs(NOW), someItems("a")) } });
    assert.equal(r.status, "done");
    assert.deepEqual(r.observations, { saved: 0, skipped: 1, failed: 0, unknown: 0, codes: ["aborted-before-write"] });
    assert.equal(gh.puts(INTEL_OBSERVATIONS_PATH), 0);
    assert.equal(parseState(gh.files.get(INTEL_STATE_PATH)!.text).lock, null);
  });

  it("ぶつかった（409）直後に止めたら、読み直さない・2 回目の書き込みをしない", async () => {
    let n = 0;
    gh.onPut((path) => {
      if (path !== INTEL_OBSERVATIONS_PATH) return undefined;
      n++;
      // 待つ上限を過ぎてから 409 を返す（止めた後に応答が来る）
      return new Promise<Response>((resolve) => setTimeout(() => resolve(new Response("conflict", { status: 409 })), 60));
    });
    const r = await runIntel({ io: githubBrainIO, env: ON, now: () => NOW, observationSaveWaitMs: 20, observationAbortGraceMs: 500, fetchers: { jmatyphoon: observing(okObs(NOW), someItems("a")) } });
    assert.equal(r.status, "done");
    assert.equal(n, 1);
    assert.equal(gh.gets(INTEL_OBSERVATIONS_PATH), 1);
    // 偽物の PUT は signal を無視して 409 を返すが、updateNote は止まっているので再試行しない（反映されていないので skipped）
    assert.deepEqual(r.observations, { saved: 0, skipped: 1, failed: 0, unknown: 0, codes: ["aborted-before-write"] });
  });

  it("止めなければ、これまでどおり保存する（観測の記録 → 状態の順）", async () => {
    const r = await runIntel({ io: githubBrainIO, env: ON, now: () => NOW, fetchers: { jmatyphoon: observing(okObs(NOW), someItems("a")) } });
    assert.equal(r.status, "done");
    assert.deepEqual(r.observations, { saved: 1, skipped: 0, failed: 0, unknown: 0, codes: [] });
    assert.deepEqual(parseObservationStore(gh.files.get(INTEL_OBSERVATIONS_PATH)!.text).store.sources.jmatyphoon!.latest, okObs(NOW));
    assert.deepEqual(gh.events, [`put:${INTEL_STATE_PATH}`, `put:${INTEL_ITEMS_PATH}`, `put:${INTEL_OBSERVATIONS_PATH}`, `put:${INTEL_STATE_PATH}`]);
  });
});

/* ---------- 4. 時間：呼び出しから数える・締切の計算 ---------- */

describe("締切（呼び出しから数える。既定 20 / 40 / 55 秒）", () => {
  it("締切の既定値と関係：finishRun の開始締切 < 全体の締切 < 打ち切り。どの情報源も、始めてよいと判断したら 40 秒以内に終わる", async () => {
    const d = runDeadlines();
    assert.deepEqual(d, { sourceStartMs: 20_000, finishStartMs: 40_000, runEndMs: 55_000 });
    assert.ok(d.finishStartMs < d.runEndMs && d.runEndMs < PLATFORM_LIMIT_MS);
    assert.deepEqual(runDeadlines({ sourceStartMs: 1, runEndMs: 3 }), { sourceStartMs: 1, finishStartMs: 40_000, runEndMs: 3 });
    // 情報源ごとの取得の最長（http.ts の 1 回 10 秒 × 順番に行う取得の回数）
    assert.deepEqual(SOURCE_MAX_MS_BY_ID, { usgs: 10_000, nhc: 10_000, jma: 30_000, jmatyphoon: 20_000 });
    assert.equal(SOURCE_MAX_MS, 30_000);
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    assert.match(readFileSync(join(process.cwd(), "src/integrations/intel/http.ts"), "utf8"), new RegExp(`opts\\.timeoutMs \\?\\? ${SOURCE_REQUEST_TIMEOUT_MS.toLocaleString("en").replace(/,/g, "_")};`));
    // 始めてよいと判断したら、必ず「経過＋最長 ≤ 40 秒」かつ「経過 < 20 秒」
    for (const id of ["usgs", "nhc", "jma", "jmatyphoon", "gdelt"] as const) {
      for (let t = 0; t <= 45_000; t += 250) {
        const ok = canStartSource(t, id, d);
        const max: number = (SOURCE_MAX_MS_BY_ID as Partial<Record<string, number>>)[id] ?? SOURCE_MAX_MS;
        assert.equal(ok, t < d.sourceStartMs && t + max <= d.finishStartMs, `${id} ${t}`);
      }
    }
    assert.equal(canStartSource(10_000, "jma", d), true);
    assert.equal(canStartSource(10_001, "jma", d), false);
    assert.equal(canStartSource(19_999, "jmatyphoon", d), true);
    assert.equal(canStartSource(20_000, "usgs", d), false);
  });

  it("観測の記録の締切：既定は 31 秒（40 − 待つ 8 − 止めた後 1）。上限は 45 秒。0 より小さくならない", () => {
    assert.equal(observationSaveDeadline(), 31_000);
    assert.equal(observationSaveDeadline({ finishStartMs: 100_000 }), 45_000); // 上限
    assert.equal(observationSaveDeadline({ capMs: 20_000 }), 20_000);
    assert.equal(observationSaveDeadline({ waitMs: 2_000, graceMs: 0 }), 38_000);
    assert.equal(observationSaveDeadline({ finishStartMs: 5_000 }), 0);
  });

  it("設定ノートの読み込み（印の前）にかかった時間も数える：19 秒なら取得・保存、25 秒なら取得しない、41 秒なら印を取らずに timeout", async () => {
    for (const [spent, expect] of [
      [19_000, "saved"],
      [25_000, "no-fetch"],
      [41_000, "timeout"],
    ] as const) {
      const b = fakeBrain({ [INTEL_SETTINGS_PATH]: settingsWith("jmatyphoon") });
      let t = NOW;
      const io: IntelBrainIO = {
        ...b.io,
        read: async (p, o) => {
          if (p === INTEL_SETTINGS_PATH) t += spent; // 設定ノートの読み込みに時間がかかった
          return b.io.read(p, o);
        },
      };
      let fetched = false;
      const r = await runIntel({
        io,
        env: ON,
        now: () => t,
        fetchers: { jmatyphoon: async (ctx) => ((fetched = true), ctx.observe?.(okObs(NOW)), someItems("a")) },
      });
      if (expect === "saved") {
        assert.equal(r.status, "done");
        assert.equal(fetched, true);
        assert.equal(r.observations?.saved, 1);
        assert.equal(parseState(b.files.get(INTEL_STATE_PATH)!.text).lock, null);
      } else if (expect === "no-fetch") {
        assert.equal(r.status, "done");
        assert.equal(fetched, false, "20 秒を過ぎたら新しい取得を始めない");
        assert.equal(r.sources.jmatyphoon?.skipped, "時間切れのため次回");
        assert.equal(parseState(b.files.get(INTEL_STATE_PATH)!.text).lock, null);
      } else {
        assert.equal(r.status, "timeout");
        assert.equal(fetched, false);
        assert.equal(b.files.has(INTEL_STATE_PATH), false, "印を取っていない（何も書いていない）");
      }
    }
  });
});

/* ---------- 5. 書き込みを送った後の通信の失敗・5xx は「分からない」（signal を渡した呼び出しだけ） ---------- */

describe("updateNote：書き込みの後の失敗の見分け", () => {
  const P = "notes/y.md";
  const failingPut = (gh: ReturnType<typeof fakeGitHub>, how: "network" | number) =>
    gh.onPut(() => {
      if (how === "network") throw new TypeError("connection reset");
      return new Response("err", { status: how });
    });

  it("signal を渡した呼び出し：書き込みの後に通信が切れた・5xx → BrainWriteUnknownError（再試行しない）", async () => {
    for (const how of ["network", 500, 502, 503] as const) {
      const gh = fakeGitHub({ [P]: "old" });
      failingPut(gh, how);
      await assert.rejects(updateNote(P, () => "new", "m", { signal: new AbortController().signal }), (err: unknown) => {
        assert.ok(err instanceof BrainWriteUnknownError, String(err));
        assert.equal(err.code, "BRAIN_WRITE_UNKNOWN");
        assert.equal(err.status, how === "network" ? null : how);
        return true;
      });
      assert.equal(gh.puts(), 1);
    }
  });

  it("signal を渡した呼び出しでも、書いていないと分かる失敗はそのまま（読み込みの通信の失敗・4xx）", async () => {
    const gh = fakeGitHub({ [P]: "old" });
    gh.onGet(() => {
      throw new TypeError("down");
    });
    await assert.rejects(updateNote(P, () => "new", "m", { signal: new AbortController().signal }), (err: unknown) => err instanceof BrainError && err.code === "BRAIN_NETWORK");
    assert.equal(gh.puts(), 0);
    const gh2 = fakeGitHub({ [P]: "old" });
    failingPut(gh2, 403);
    await assert.rejects(updateNote(P, () => "new", "m", { signal: new AbortController().signal }), (err: unknown) => err instanceof BrainError && err.code === "BRAIN_FORBIDDEN");
  });

  it("signal を渡さない呼び出しは、これまでどおり（通信の失敗は BRAIN_NETWORK、5xx は BRAIN_UPSTREAM）", async () => {
    const gh = fakeGitHub({ [P]: "old" });
    failingPut(gh, "network");
    await assert.rejects(updateNote(P, () => "new", "m"), (err: unknown) => err instanceof BrainError && !(err instanceof BrainWriteUnknownError) && err.code === "BRAIN_NETWORK");
    const gh2 = fakeGitHub({ [P]: "old" });
    failingPut(gh2, 503);
    await assert.rejects(updateNote(P, () => "new", "m"), (err: unknown) => err instanceof BrainError && !(err instanceof BrainWriteUnknownError) && err.code === "BRAIN_UPSTREAM");
  });

  it("recordObservation：BrainWriteUnknownError は write-unknown", async () => {
    const io: IntelBrainIO = {
      configured: () => true,
      read: async () => null,
      update: async () => {
        throw new BrainWriteUnknownError(502);
      },
    };
    const r = await recordObservation(io, okObs(NOW), { signal: new AbortController().signal });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.error.code, "write-unknown");
  });

  it("runIntel：観測の記録の書き込みが 5xx・通信の失敗なら unknown（failed にしない）。収集は通常どおり", async () => {
    for (const how of [502, "network"] as const) {
      const gh = fakeGitHub({ [INTEL_SETTINGS_PATH]: settingsWith("jmatyphoon") });
      gh.onPut((path) => {
        if (path !== INTEL_OBSERVATIONS_PATH) return undefined;
        if (how === "network") throw new TypeError("connection reset");
        return new Response("bad gateway", { status: how });
      });
      const r = await runIntel({ io: githubBrainIO, env: ON, now: () => NOW, fetchers: { jmatyphoon: observing(okObs(NOW), someItems("a")) } });
      assert.equal(r.status, "done");
      assert.deepEqual(r.observations, { saved: 0, skipped: 0, failed: 0, unknown: 1, codes: ["write-unknown"] });
      assert.equal(gh.puts(INTEL_OBSERVATIONS_PATH), 1);
      const st = parseState(gh.files.get(INTEL_STATE_PATH)!.text);
      assert.equal(st.lock, null);
      assert.equal(st.sources.jmatyphoon?.lastCount, 1);
    }
  });
});

/* ---------- 6. 止めても終わらない口：残りの保存は始めない（始めた処理は裏で続くことがある） ---------- */

describe("save-not-settled の後", () => {
  it("残りの観測の記録は保存を始めず skipped。始めた処理は runIntel が終わった後に書き込むことがある", async () => {
    const b = fakeBrain({ [INTEL_SETTINGS_PATH]: settingsWith("jmatyphoon") });
    let obsCalls = 0;
    const hold: { release?: () => Promise<void> } = {};
    // signal を無視して終わらない口（GitHub の口ではない。将来の口・偽物を想定）
    const io: IntelBrainIO = {
      ...b.io,
      update: (p, u, m, o) => {
        if (p !== INTEL_OBSERVATIONS_PATH) return b.io.update(p, u, m, o);
        obsCalls++;
        return new Promise<void>((resolve) => {
          hold.release = () => b.io.update(p, u, m).then(resolve);
        });
      },
    };
    const three = async (ctx: SourceContext) => {
      for (const k of [3, 2, 1]) ctx.observe?.(okObs(NOW - k * 60_000));
      return someItems("a");
    };
    const r = await runIntel({ io, env: ON, now: () => NOW, observationSaveWaitMs: 20, observationAbortGraceMs: 20, fetchers: { jmatyphoon: three } });
    assert.equal(r.status, "done");
    assert.deepEqual(r.observations, { saved: 0, skipped: 2, failed: 0, unknown: 1, codes: ["save-not-settled"] });
    assert.equal(obsCalls, 1, "2 件目以降は保存を始めない");
    // 収集は通常どおり終わっている（印は外れ、観測の記録はまだ無い）
    assert.equal(parseState(b.files.get(INTEL_STATE_PATH)!.text).lock, null);
    assert.equal(b.files.has(INTEL_OBSERVATIONS_PATH), false);
    // 始めた処理は、runIntel が終わった後（印を外した後）でも書き込めてしまう：この口では防げないことを明示する
    assert.ok(hold.release);
    await hold.release();
    assert.equal(b.files.has(INTEL_OBSERVATIONS_PATH), true);
  });
});

/* ---------- 7. 実行の打ち切りの値（route.ts と collect.ts の 2 か所） ---------- */

describe("実行の打ち切りの値", () => {
  it("route.ts の maxDuration（秒）と collect.ts の PLATFORM_LIMIT_MS（ミリ秒）が同じ", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const text = readFileSync(join(process.cwd(), "src/app/api/cron/intel/route.ts"), "utf8");
    const m = /export const maxDuration = (\d+);/.exec(text);
    assert.ok(m, "maxDuration がその場に書いた数で書かれている");
    assert.equal(Number(m![1]) * 1000, PLATFORM_LIMIT_MS);
  });
});
