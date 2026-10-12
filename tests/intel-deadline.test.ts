/**
 * E.D.I.T.H. Phase 3-2：実行時間の締切（呼び出しから 20 / 40 / 55 秒）と、保存できなかったときの状態の記録。
 * 偽の時計（FakeClock）と、時計に従って時間がかかり signal で止まる偽の脳（slowBrain）だけで確かめる。通信はしない。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { IntelItem, IntelSourceId } from "../src/integrations/intel/types";
import type { IntelBrainIO } from "../src/integrations/intel/brain-io";
import type { SourceContext } from "../src/integrations/intel/sources/common";
const { runIntel } = await import("../src/integrations/intel/collect");
const { BrainAbortError, BrainWriteUnknownError, INTEL_SETTINGS_PATH, INTEL_STATE_PATH, INTEL_ITEMS_PATH } = await import("../src/integrations/intel/brain-io");
const { renderSettingsNote, defaultSettings } = await import("../src/integrations/intel/settings");
const { parseState, emptyState } = await import("../src/integrations/intel/state");
const { parseItems } = await import("../src/integrations/intel/store");
const { parseUsgs } = await import("../src/integrations/intel/sources/usgs");
const { fetchJmaQuake, JMA_EQVOL_URL, JMA_EQVOL_LONG_URL } = await import("../src/integrations/intel/sources/jma");
const { SourceError } = await import("../src/integrations/intel/http");
const { fakeBrain } = await import("./intel-fake");

const T0 = Date.parse("2026-10-11T12:00:00.000Z");
const ON = { EDITH_INTEL: "on" };
const S = 1000;
const MIN = 60 * S;
const STATE = INTEL_STATE_PATH;
const ITEMS = INTEL_ITEMS_PATH;
const SETTINGS = INTEL_SETTINGS_PATH;

/* ---------- 偽の時計 ---------- */

class FakeClock {
  t: number;
  private timers: { at: number; fn: () => void; id: number }[] = [];
  private seq = 0;
  constructor(t0: number) {
    this.t = t0;
  }
  now = () => this.t;
  setTimer = (ms: number, fn: () => void) => {
    const id = ++this.seq;
    this.timers.push({ at: this.t + Math.max(0, ms), fn, id });
    return () => {
      this.timers = this.timers.filter((x) => x.id !== id);
    };
  };
  /** 時計で ms たつまで待つ（signal で止まると AbortError） */
  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(new DOMException("aborted", "AbortError"));
      const onAbort = () => {
        cancel();
        reject(new DOMException("aborted", "AbortError"));
      };
      const cancel = this.setTimer(ms, () => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      });
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }
  private async flush() {
    for (let k = 0; k < 8; k++) await new Promise((r) => setImmediate(r));
  }
  /** p が終わるまで、待っている処理が無くなるたびに、次のタイマーまで時計を進める */
  async run<T>(p: Promise<T>): Promise<T> {
    let settled = false;
    p.then(
      () => (settled = true),
      () => (settled = true),
    );
    for (let i = 0; i < 100_000; i++) {
      await this.flush();
      if (settled) return p;
      this.timers.sort((a, b) => a.at - b.at || a.id - b.id);
      const next = this.timers.shift();
      if (!next) throw new Error("止まったまま（タイマーが無いのに終わらない）");
      this.t = Math.max(this.t, next.at);
      next.fn();
    }
    throw new Error("進みすぎ");
  }
  /** 残っているタイマーをすべて動かす（実行が終わった後に、遅れて書き込む処理が無いか確かめる） */
  async drain(ms: number) {
    const end = this.t + ms;
    for (;;) {
      await this.flush();
      this.timers.sort((a, b) => a.at - b.at || a.id - b.id);
      const next = this.timers[0];
      if (!next || next.at > end) break;
      this.timers.shift();
      this.t = next.at;
      next.fn();
    }
    this.t = end;
    await this.flush();
  }
  pending() {
    return this.timers.length;
  }
}

/* ---------- 時計に従う偽の脳（updateNote と同じ決まり：止めたら新しい書き込み・再試行をしない） ---------- */

type Op = "read" | "get" | "put";
type PutOutcome = "ok" | "conflict" | "unknown-landed" | "unknown-lost";
interface SlowOpts {
  latency?: (op: Op, path: string, n: number) => number;
  onPut?: (path: string, n: number) => PutOutcome;
  /** 止めた書き込みが GitHub 側で反映されたことにする */
  abortedPutLands?: (path: string) => boolean;
}

function slowBrain(clock: FakeClock, initial: Record<string, string>, o: SlowOpts = {}) {
  const files = new Map<string, { text: string; sha: number }>(Object.entries(initial).map(([p, t]) => [p, { text: t, sha: 1 }]));
  const events: { at: number; ev: string; path: string; n: number }[] = [];
  const writes: { at: number; path: string }[] = [];
  const counts = new Map<string, number>();
  const count = (key: string) => {
    const n = (counts.get(key) ?? 0) + 1;
    counts.set(key, n);
    return n;
  };
  const lat = (op: Op, path: string, n: number) => o.latency?.(op, path, n) ?? 100;
  const log = (ev: string, path: string, n: number) => events.push({ at: clock.t - T0, ev, path, n });
  const write = (path: string, text: string) => {
    const cur = files.get(path);
    files.set(path, { text, sha: (cur?.sha ?? 0) + 1 });
    writes.push({ at: clock.t - T0, path });
  };
  const io: IntelBrainIO = {
    configured: () => true,
    read: async (path, opts) => {
      const n = count(`read:${path}`);
      if (opts?.signal?.aborted) throw new BrainAbortError(false);
      log("read-start", path, n);
      try {
        await clock.sleep(lat("read", path, n), opts?.signal);
      } catch {
        log("read-abort", path, n);
        throw new BrainAbortError(false);
      }
      return files.get(path)?.text ?? null;
    },
    update: async (path, update, _message, opts) => {
      const signal = opts?.signal;
      const call = count(`update:${path}`);
      for (let attempt = 0; attempt < 2; attempt++) {
        if (signal?.aborted) throw new BrainAbortError(false);
        log("get-start", path, call);
        try {
          await clock.sleep(lat("get", path, call), signal);
        } catch {
          log("get-abort", path, call);
          throw new BrainAbortError(false);
        }
        const cur = files.get(path) ?? null;
        const next = update(cur?.text ?? null);
        if (cur && next === cur.text) return;
        if (signal?.aborted) throw new BrainAbortError(false);
        const n = count(`put:${path}`);
        log("put-start", path, call);
        try {
          await clock.sleep(lat("put", path, call), signal);
        } catch {
          if (o.abortedPutLands?.(path)) write(path, next);
          log("put-abort", path, call);
          throw new BrainAbortError(true);
        }
        const outcome = o.onPut?.(path, n) ?? "ok";
        const now = files.get(path) ?? null;
        if (outcome === "conflict" || (now?.sha ?? null) !== (cur?.sha ?? null)) {
          log("put-409", path, call);
          continue;
        }
        if (outcome === "unknown-landed") {
          write(path, next);
          throw new BrainWriteUnknownError(502);
        }
        if (outcome === "unknown-lost") throw new BrainWriteUnknownError(null);
        write(path, next);
        log("put-ok", path, call);
        return;
      }
      throw new Error("GitHub でエラーが発生しました（409）");
    },
  };
  return { io, files, events, writes };
}

/* ---------- 固定データ ---------- */

function settingsWith(...ids: IntelSourceId[]): string {
  const s = defaultSettings();
  for (const k of Object.keys(s.sources) as IntelSourceId[]) s.sources[k] = ids.includes(k);
  return renderSettingsNote(s);
}

const itemsFor = (source: IntelSourceId, id: string): IntelItem[] =>
  parseUsgs(
    { type: "FeatureCollection", features: [{ id, geometry: { coordinates: [140, 35, 10] }, properties: { mag: 5, place: "x", time: T0 - MIN, updated: T0, status: "reviewed" } }] },
    T0,
  ).map((i) => ({ ...i, source, id: `${source}:${id}` }));

/** 時計で ms かかってから項目を返す取得 */
const slowFetch = (clock: FakeClock, ms: number, items: IntelItem[] | Error) => {
  let calls = 0;
  const fn = async (_ctx: SourceContext) => {
    calls++;
    await clock.sleep(ms);
    if (items instanceof Error) throw items;
    return items;
  };
  return {
    fn,
    get calls() {
      return calls;
    },
  };
};

const iso = (t: number) => new Date(t).toISOString();

/* ---------- 1. 印を取る前（設定ノート・印） ---------- */

describe("印を取る前の締切（40 秒）", () => {
  it("設定ノートの読み込みが 40 秒を過ぎたら止めて timeout。何も書かず、取得もしない", async () => {
    const clock = new FakeClock(T0);
    const b = slowBrain(clock, { [SETTINGS]: settingsWith("usgs") }, { latency: (op, p) => (op === "read" && p === SETTINGS ? 45 * S : 100) });
    const f = slowFetch(clock, S, itemsFor("usgs", "a"));
    const r = await clock.run(runIntel({ io: b.io, env: ON, now: clock.now, setTimer: clock.setTimer, fetchers: { usgs: f.fn } }));
    assert.equal(r.status, "timeout");
    assert.equal(f.calls, 0);
    assert.deepEqual(b.writes, []);
    assert.ok(b.events.some((e) => e.ev === "read-abort" && e.path === SETTINGS && e.at === 40 * S));
  });

  it("設定ノートの作成（ノートが無いとき）が 40 秒で止まったら timeout。印は取らない", async () => {
    const clock = new FakeClock(T0);
    const b = slowBrain(clock, {}, { latency: (op, p) => (op === "put" && p === SETTINGS ? 50 * S : 100) });
    const r = await clock.run(runIntel({ io: b.io, env: ON, now: clock.now, setTimer: clock.setTimer, fetchers: {} }));
    assert.equal(r.status, "timeout");
    assert.equal(b.files.has(STATE), false);
  });

  it("印の書き込みを送る前に 40 秒が来たら timeout（印は書いていない・busy とは区別する）", async () => {
    const clock = new FakeClock(T0);
    const b = slowBrain(clock, { [SETTINGS]: settingsWith("usgs") }, { latency: (op, p) => (op === "get" && p === STATE ? 45 * S : 100) });
    const f = slowFetch(clock, S, itemsFor("usgs", "a"));
    const r = await clock.run(runIntel({ io: b.io, env: ON, now: clock.now, setTimer: clock.setTimer, fetchers: { usgs: f.fn } }));
    assert.equal(r.status, "timeout");
    assert.equal(b.files.has(STATE), false);
    assert.equal(f.calls, 0);
  });
});

/* ---------- 2. 印の書き込みの結果が分からないとき ---------- */

describe("印の書き込みの結果が分からないとき（自分の印だと確かめられたときだけ続ける）", () => {
  it("結果が分からない（5xx）が、読み直すと自分の印だった → 続ける（done）", async () => {
    const clock = new FakeClock(T0);
    const b = slowBrain(clock, { [SETTINGS]: settingsWith("usgs") }, { onPut: (p, n) => (p === STATE && n === 1 ? "unknown-landed" : "ok") });
    const f = slowFetch(clock, S, itemsFor("usgs", "a"));
    const r = await clock.run(runIntel({ io: b.io, env: ON, now: clock.now, setTimer: clock.setTimer, fetchers: { usgs: f.fn } }));
    assert.equal(r.status, "done");
    assert.equal(f.calls, 1);
    assert.equal(parseItems(b.files.get(ITEMS)!.text).length, 1);
    assert.equal(parseState(b.files.get(STATE)!.text).lock, null);
  });

  it("結果が分からず、印は書かれていなかった → lock-unknown。取得も書き込みもしない（重複実行をしない）", async () => {
    const clock = new FakeClock(T0);
    const b = slowBrain(clock, { [SETTINGS]: settingsWith("usgs") }, { onPut: (p) => (p === STATE ? "unknown-lost" : "ok") });
    const f = slowFetch(clock, S, itemsFor("usgs", "a"));
    const r = await clock.run(runIntel({ io: b.io, env: ON, now: clock.now, setTimer: clock.setTimer, fetchers: { usgs: f.fn } }));
    assert.equal(r.status, "lock-unknown");
    assert.notEqual(r.status, "timeout");
    assert.equal(f.calls, 0);
    assert.deepEqual(b.writes, []);
  });

  it("ほかの実行が印を取っていた（確かめると他人の印）→ lock-unknown。何も書かない", async () => {
    const clock = new FakeClock(T0);
    const b = slowBrain(clock, { [SETTINGS]: settingsWith("usgs") }, { onPut: (p) => (p === STATE ? "unknown-lost" : "ok") });
    const io: IntelBrainIO = {
      ...b.io,
      read: async (p, o) => {
        // 確かめる直前に、別の実行が印を取った
        if (p === STATE) b.files.set(STATE, { text: JSON.stringify({ ...emptyState(), lock: { owner: "other", until: iso(T0 + 3 * MIN) } }), sha: 9 });
        return b.io.read(p, o);
      },
    };
    const f = slowFetch(clock, S, itemsFor("usgs", "a"));
    const r = await clock.run(runIntel({ io, env: ON, now: clock.now, setTimer: clock.setTimer, fetchers: { usgs: f.fn } }));
    assert.equal(r.status, "lock-unknown");
    assert.equal(f.calls, 0);
    assert.equal(parseState(b.files.get(STATE)!.text).lock?.owner, "other");
  });

  it("印の書き込みが 40 秒で止まり（実際は書かれた）、確かめる時間が無い → lock-unknown。印は 3 分で外れ、5 分後の実行は動ける", async () => {
    const clock = new FakeClock(T0);
    const b = slowBrain(
      clock,
      { [SETTINGS]: settingsWith("usgs") },
      { latency: (op, p, n) => (op === "put" && p === STATE && n === 1 ? 60 * S : 100), abortedPutLands: (p) => p === STATE },
    );
    const f = slowFetch(clock, S, itemsFor("usgs", "a"));
    const r = await clock.run(runIntel({ io: b.io, env: ON, now: clock.now, setTimer: clock.setTimer, fetchers: { usgs: f.fn } }));
    assert.equal(r.status, "lock-unknown");
    assert.equal(f.calls, 0);
    const lock = parseState(b.files.get(STATE)!.text).lock!;
    assert.ok(lock, "印は書かれている（ただし、この実行は続けていない）");
    assert.ok(Date.parse(lock.until) <= T0 + 4 * MIN);
    // 5 分後の実行は、期限切れの印を取り直して動ける
    clock.t = T0 + 5 * MIN;
    const r2 = await clock.run(runIntel({ io: b.io, env: ON, now: clock.now, setTimer: clock.setTimer, fetchers: { usgs: f.fn } }));
    assert.equal(r2.status, "done");
    assert.equal(f.calls, 1);
    assert.equal(parseState(b.files.get(STATE)!.text).lock, null);
  });
});

/* ---------- 3. 新しい取得の締切（20 秒） ---------- */

describe("新しい取得の締切（20 秒）", () => {
  it("20 秒を過ぎたら、次の情報源の取得を始めない（時間切れのため次回）", async () => {
    const clock = new FakeClock(T0);
    const b = slowBrain(clock, { [SETTINGS]: settingsWith("usgs", "nhc") });
    const usgs = slowFetch(clock, 21 * S, itemsFor("usgs", "a"));
    const nhc = slowFetch(clock, S, itemsFor("nhc", "b"));
    const r = await clock.run(runIntel({ io: b.io, env: ON, now: clock.now, setTimer: clock.setTimer, fetchers: { usgs: usgs.fn, nhc: nhc.fn } }));
    assert.equal(r.status, "done");
    assert.equal(nhc.calls, 0);
    assert.equal(r.sources.nhc?.skipped, "時間切れのため次回");
    assert.equal(parseState(b.files.get(STATE)!.text).sources.nhc, undefined); // 次回すぐ取りに行ける
  });

  it("保存済みの情報の読み込みが 20 秒に間に合わなければ、取得しない（重複を見分けられないため）", async () => {
    const clock = new FakeClock(T0);
    const b = slowBrain(clock, { [SETTINGS]: settingsWith("usgs") }, { latency: (op, p) => (op === "read" && p === ITEMS ? 30 * S : 100) });
    const f = slowFetch(clock, S, itemsFor("usgs", "a"));
    const r = await clock.run(runIntel({ io: b.io, env: ON, now: clock.now, setTimer: clock.setTimer, fetchers: { usgs: f.fn } }));
    assert.equal(r.status, "done");
    assert.equal(f.calls, 0);
    assert.equal(r.sources.usgs?.skipped, "時間切れのため次回");
    assert.equal(parseState(b.files.get(STATE)!.text).lock, null);
  });
});

/* ---------- 4. finishRun の開始（40 秒）と終わり（55 秒） ---------- */

describe("finishRun：40 秒までに始め、55 秒で止める（再試行を含む）", () => {
  it("情報の保存が 40 秒で止まっても、finishRun は 40 秒に始まる。成功は先送り、印は外す（timeout）", async () => {
    const clock = new FakeClock(T0);
    const b = slowBrain(clock, { [SETTINGS]: settingsWith("usgs") }, { latency: (op, p) => (op === "get" && p === ITEMS ? 30 * S : 100) });
    const f = slowFetch(clock, 19 * S, itemsFor("usgs", "a"));
    const r = await clock.run(runIntel({ io: b.io, env: ON, now: clock.now, setTimer: clock.setTimer, fetchers: { usgs: f.fn } }));
    assert.equal(r.status, "timeout");
    assert.deepEqual(r.deferred, ["usgs"]);
    assert.equal(b.files.has(ITEMS), false);
    const finishStart = b.events.find((e) => e.path === STATE && e.n === 2 && e.ev === "get-start")!;
    assert.ok(finishStart.at <= 40 * S, `${finishStart.at}`);
    const s = parseState(b.files.get(STATE)!.text);
    assert.equal(s.lock, null);
    assert.equal(s.sources.usgs?.lastSuccessAt, null);
  });

  it("finishRun がぶつかって再試行しても、55 秒で止める（2 回目の書き込みを始めない）。その後に書き込みは残らない", async () => {
    const clock = new FakeClock(T0);
    const b = slowBrain(
      clock,
      { [SETTINGS]: settingsWith("usgs") },
      {
        latency: (op, p, n) => (p === ITEMS && op === "get" ? 30 * S : p === STATE && n === 2 && op === "get" ? 10 * S : 100),
        onPut: (p, n) => (p === STATE && n === 2 ? "conflict" : "ok"),
      },
    );
    const f = slowFetch(clock, 19 * S, itemsFor("usgs", "a"));
    const r = await clock.run(runIntel({ io: b.io, env: ON, now: clock.now, setTimer: clock.setTimer, fetchers: { usgs: f.fn } }));
    assert.equal(r.status, "timeout");
    assert.match(r.error ?? "", /状態の記録/);
    const finish = b.events.filter((e) => e.path === STATE && e.n === 2);
    assert.ok(finish[0].at <= 40 * S);
    assert.equal(finish.filter((e) => e.ev === "put-start").length, 1, "再試行の書き込みは始めない");
    assert.ok(finish.every((e) => e.at <= 55 * S), JSON.stringify(finish));
    // 実行が終わった後に、時計を 10 分進めても、遅れて書き込む処理は無い
    const before = b.writes.length;
    await clock.drain(10 * MIN);
    assert.equal(b.writes.length, before);
    assert.equal(clock.pending(), 0);
    // 印は書かれたまま（期限で外れる）。state は壊れていない
    const s = parseState(b.files.get(STATE)!.text);
    assert.ok(s.lock);
  });

  it("ふつうの実行では、締切のタイマーはすべて片付く（終わった後に残る処理が無い）", async () => {
    const clock = new FakeClock(T0);
    const b = slowBrain(clock, { [SETTINGS]: settingsWith("usgs") });
    const r = await clock.run(runIntel({ io: b.io, env: ON, now: clock.now, setTimer: clock.setTimer, fetchers: { usgs: slowFetch(clock, S, itemsFor("usgs", "a")).fn } }));
    assert.equal(r.status, "done");
    assert.equal(clock.pending(), 0);
  });
});

/* ---------- 5. 保存できなかったときの状態の記録 ---------- */

describe("情報を保存できなかったとき：成功は先送り、失敗・429・Retry-After は記録、0 件の成功は成功", () => {
  it("締切で保存を止めた回", async () => {
    const clock = new FakeClock(T0);
    const b = slowBrain(clock, { [SETTINGS]: settingsWith("usgs", "nhc", "jma") }, { latency: (op, p) => (op === "get" && p === ITEMS ? 40 * S : 100) });
    const r = await clock.run(
      runIntel({
        io: b.io,
        env: ON,
        now: clock.now,
        setTimer: clock.setTimer,
        fetchers: {
          usgs: slowFetch(clock, S, itemsFor("usgs", "a")).fn,
          nhc: slowFetch(clock, S, new SourceError("アクセスの制限", 429, 2 * 60 * MIN)).fn,
          jma: slowFetch(clock, S, []).fn,
        },
      }),
    );
    assert.equal(r.status, "timeout");
    assert.deepEqual(r.deferred, ["usgs"]);
    const s = parseState(b.files.get(STATE)!.text);
    const at = (id: IntelSourceId) => Date.parse(s.sources[id]!.lastRunAt!);
    // 項目があった成功：成功と記録しない（lastSuccessAt・lastCount はそのまま）。間隔（10 分）は守る
    assert.equal(s.sources.usgs?.lastSuccessAt, null);
    assert.equal(s.sources.usgs?.lastCount, 0);
    assert.equal(s.sources.usgs?.failures, 0);
    assert.equal(s.sources.usgs?.nextAllowedAt, iso(at("usgs") + 10 * MIN));
    // 失敗：429 と Retry-After（2 時間）を記録
    assert.equal(s.sources.nhc?.failures, 1);
    assert.match(s.sources.nhc?.lastError ?? "", /429/);
    assert.ok(Date.parse(s.sources.nhc!.nextAllowedAt!) - at("nhc") >= 2 * 60 * MIN);
    // 0 件の成功：成功として記録
    assert.equal(s.sources.jma?.lastSuccessAt, s.sources.jma?.lastRunAt);
    assert.equal(s.sources.jma?.lastCount, 0);
  });

  it("情報の保存が例外（GitHub の障害）でも、成功を記録しない（error。以前は成功として記録していた）", async () => {
    const b = fakeBrain({ [SETTINGS]: settingsWith("usgs", "nhc") });
    b.failWrites((p) => (p === ITEMS ? new Error("GitHub でエラーが発生しました（503）") : null));
    const r = await runIntel({
      io: b.io,
      env: ON,
      now: () => T0,
      fetchers: { usgs: async () => itemsFor("usgs", "a"), nhc: async () => Promise.reject(new SourceError("アクセスの制限", 429, 3 * 60 * MIN)) },
    });
    assert.equal(r.status, "error");
    assert.deepEqual(r.deferred, ["usgs"]);
    const s = parseState(b.files.get(STATE)!.text);
    assert.equal(s.lock, null);
    assert.equal(s.sources.usgs?.lastSuccessAt, null);
    assert.equal(s.sources.usgs?.nextAllowedAt, iso(T0 + 10 * MIN));
    assert.equal(s.sources.nhc?.failures, 1);
    assert.ok(Date.parse(s.sources.nhc!.nextAllowedAt!) - T0 >= 3 * 60 * MIN);
  });

  it("前に失敗していた情報源は、先送りでも失敗の記録（回数・エラー）を消さない", async () => {
    const prev = { lastRunAt: iso(T0 - 20 * MIN), lastSuccessAt: iso(T0 - 60 * MIN), lastError: "503 HTTP 503", failures: 2, nextAllowedAt: iso(T0 - MIN), lastCount: 3 };
    const b = fakeBrain({ [SETTINGS]: settingsWith("usgs"), [STATE]: JSON.stringify({ ...emptyState(), sources: { usgs: prev } }) });
    b.failWrites((p) => (p === ITEMS ? new Error("GitHub でエラーが発生しました（503）") : null));
    await runIntel({ io: b.io, env: ON, now: () => T0, fetchers: { usgs: async () => itemsFor("usgs", "a") } });
    const st = parseState(b.files.get(STATE)!.text).sources.usgs!;
    assert.equal(st.lastSuccessAt, prev.lastSuccessAt);
    assert.equal(st.failures, 2);
    assert.equal(st.lastError, prev.lastError);
    assert.equal(st.lastCount, 3);
    assert.equal(st.lastRunAt, iso(T0));
    assert.equal(st.nextAllowedAt, iso(T0 + 10 * MIN));
  });
});

/* ---------- 6. 気象庁の地震：保存できなかった次の回に、長期フィードで取りこぼしを補う ---------- */

describe("気象庁の地震の取りこぼしの補い（保存に失敗した次の回）", () => {
  const EMPTY_FEED = '<?xml version="1.0" encoding="utf-8"?><feed xmlns="http://www.w3.org/2005/Atom"><title>x</title></feed>';
  const recordingFetch = () => {
    const urls: string[] = [];
    const fn = async (url: string) => {
      urls.push(url);
      return new Response(EMPTY_FEED, { status: 200, headers: { "content-type": "application/xml" } });
    };
    return { fn: fn as unknown as typeof fetch, urls };
  };

  for (const failSave of [true, false]) {
    it(failSave ? "保存に失敗した → 次の回（10 分後）は長期フィードも読む" : "（比べるため）保存できた → 次の回（10 分後）は高頻度フィードだけ", async () => {
      // 前の回は 5 分前に成功していた
      const prev = { lastRunAt: iso(T0 - 5 * MIN), lastSuccessAt: iso(T0 - 5 * MIN), lastError: null, failures: 0, nextAllowedAt: iso(T0), lastCount: 1 };
      const b = fakeBrain({ [SETTINGS]: settingsWith("jma"), [STATE]: JSON.stringify({ ...emptyState(), sources: { jma: prev } }) });
      if (failSave) b.failWrites((p) => (p === ITEMS ? new Error("GitHub でエラーが発生しました（503）") : null));
      // 1 回目：地震の項目が 1 件取れた（保存の成否を変える）
      await runIntel({ io: b.io, env: ON, now: () => T0, fetchers: { jma: async () => itemsFor("jma", "q1") } });
      b.failWrites(null);
      // 2 回目：10 分後に、本物の気象庁の取得（偽の fetch）で動かす
      const f = recordingFetch();
      const r = await runIntel({ io: b.io, env: ON, now: () => T0 + 10 * MIN, fetchImpl: f.fn, fetchers: { jma: fetchJmaQuake } });
      assert.equal(r.sources.jma?.ok, true);
      assert.ok(f.urls.includes(JMA_EQVOL_URL));
      assert.equal(f.urls.includes(JMA_EQVOL_LONG_URL), failSave, f.urls.join(" "));
    });
  }
});

/* ---------- 7. 結果の区別 ---------- */

describe("実行結果の区別", () => {
  it("timeout と lock-unknown は別の状態で、どちらも error ではない（API は 200・ログに状態名が出る）", async () => {
    const statuses = new Set<string>();
    for (const opts of [
      { latency: (op: Op, p: string) => (op === "read" && p === SETTINGS ? 45 * S : 100) },
      { onPut: (p: string) => (p === STATE ? ("unknown-lost" as const) : ("ok" as const)) },
    ]) {
      const clock = new FakeClock(T0);
      const b = slowBrain(clock, { [SETTINGS]: settingsWith("usgs") }, opts);
      const r = await clock.run(runIntel({ io: b.io, env: ON, now: clock.now, setTimer: clock.setTimer, fetchers: {} }));
      statuses.add(r.status);
      assert.ok(r.error && !/token|ghp_/i.test(r.error));
    }
    assert.deepEqual([...statuses].sort(), ["lock-unknown", "timeout"]);
  });
});

/* ---------- 8. 情報源ごとの取得の最長（H1）：始めた取得が finishRun の開始締切（40 秒）を超えない ---------- */

describe("情報源ごとの取得の最長を見て、取得を始めるか決める（H1）", () => {
  /** 取得を始めた時刻（呼び出しから）を記録しながら、時計で ms かかる取得 */
  const timed = (clock: FakeClock, starts: Record<string, number>, id: IntelSourceId, ms: number, items: IntelItem[] = []) => async () => {
    starts[id] = clock.t - T0;
    await clock.sleep(ms);
    return items;
  };
  const MAX: Record<string, number> = { usgs: 10 * S, nhc: 10 * S, jma: 30 * S, jmatyphoon: 20 * S };

  it("H1 の再現：usgs が 11 秒かかった後、残り 29 秒では気象庁の地震（最長 30 秒）を始めない。finishRun は 40 秒までに始まる", async () => {
    const clock = new FakeClock(T0);
    const b = slowBrain(clock, { [SETTINGS]: settingsWith("usgs", "jma") });
    const starts: Record<string, number> = {};
    const r = await clock.run(
      runIntel({
        io: b.io,
        env: ON,
        now: clock.now,
        setTimer: clock.setTimer,
        fetchers: { usgs: timed(clock, starts, "usgs", 11 * S, itemsFor("usgs", "a")), jma: timed(clock, starts, "jma", 30 * S, itemsFor("jma", "q")) },
      }),
    );
    assert.equal(starts.jma, undefined, "残り時間に収まらない取得は始めない");
    assert.equal(r.sources.jma?.skipped, "時間切れのため次回");
    assert.equal(r.status, "done");
    const finishStart = b.events.find((e) => e.path === STATE && e.n === 2 && e.ev === "get-start")!;
    assert.ok(finishStart.at <= 40 * S, `finishRun の開始 ${finishStart.at}`);
    // 始めた取得は、どれも「始めた時刻＋最長」が 40 秒以内
    for (const [id, at] of Object.entries(starts)) assert.ok(at + MAX[id] <= 40 * S, `${id} ${at}`);
  });

  it("残り時間が 30 秒以上なら、気象庁の地震（最長 30 秒）を始め、30 秒かかっても finishRun は 40 秒までに始まる", async () => {
    const clock = new FakeClock(T0);
    const b = slowBrain(clock, { [SETTINGS]: settingsWith("jma", "jmatyphoon") });
    const starts: Record<string, number> = {};
    const r = await clock.run(
      runIntel({
        io: b.io,
        env: ON,
        now: clock.now,
        setTimer: clock.setTimer,
        fetchers: { jma: timed(clock, starts, "jma", 30 * S, itemsFor("jma", "q")), jmatyphoon: timed(clock, starts, "jmatyphoon", 20 * S) },
      }),
    );
    assert.ok(starts.jma !== undefined && starts.jma <= 10 * S);
    assert.equal(starts.jmatyphoon, undefined, "地震の後（30 秒すぎ）は台風を始めない");
    const finishStart = b.events.find((e) => e.path === STATE && e.n === 2 && e.ev === "get-start")!;
    assert.ok(finishStart.at <= 40 * S, `finishRun の開始 ${finishStart.at}`);
    assert.equal(r.status, "done");
    assert.equal(parseItems(b.files.get(ITEMS)!.text).length, 1);
  });

  it("すべての情報源が最長までかかっても、始めた取得は 40 秒を超えず、finishRun は 40 秒までに始まる", async () => {
    const subsets: IntelSourceId[][] = [
      ["usgs", "nhc", "jma", "jmatyphoon"],
      ["usgs", "jma", "jmatyphoon"],
      ["usgs", "jma"],
      ["nhc", "jma"],
      ["jma", "jmatyphoon"],
      ["usgs", "jmatyphoon"],
    ];
    for (const ids of subsets)
    for (const lead of [0, 2 * S, 9 * S, 11 * S, 19 * S]) {
      const clock = new FakeClock(T0);
      // lead：取得の前に時間がかかった（保存済みの情報の読み込みが遅い）
      const b = slowBrain(clock, { [SETTINGS]: settingsWith(...ids) }, { latency: (op, p) => (op === "read" && p === ITEMS ? Math.max(100, lead) : 100) });
      const starts: Record<string, number> = {};
      await clock.run(
        runIntel({
          io: b.io,
          env: ON,
          now: clock.now,
          setTimer: clock.setTimer,
          fetchers: {
            usgs: timed(clock, starts, "usgs", MAX.usgs),
            nhc: timed(clock, starts, "nhc", MAX.nhc),
            jma: timed(clock, starts, "jma", MAX.jma),
            jmatyphoon: timed(clock, starts, "jmatyphoon", MAX.jmatyphoon),
          },
        }),
      );
      for (const [id, at] of Object.entries(starts)) {
        assert.ok(at < 20 * S, `${ids} ${lead}: ${id} は 20 秒より前に始める（${at}）`);
        assert.ok(at + MAX[id] <= 40 * S, `${ids} ${lead}: ${id} ${at}+${MAX[id]}`);
      }
      const finishStart = b.events.find((e) => e.path === STATE && e.n === 2 && e.ev === "get-start")!;
      assert.ok(finishStart.at <= 40 * S, `${ids} ${lead}: finishRun の開始 ${finishStart.at}`);
    }
  });

  it("気象庁の地震を始めなかった回：地震の状態は変えず（次の回に取りこぼしを補える）、ほかの情報源は通常どおり記録する", async () => {
    const old = { lastRunAt: iso(T0 - 30 * MIN), lastSuccessAt: iso(T0 - 30 * MIN), lastError: null, failures: 0, nextAllowedAt: iso(T0 - 20 * MIN), lastCount: 2 };
    const clock = new FakeClock(T0);
    const b = slowBrain(clock, {
      [SETTINGS]: settingsWith("usgs", "jma"),
      [STATE]: JSON.stringify({ ...emptyState(), sources: { jma: old } }),
    });
    const starts: Record<string, number> = {};
    const r = await clock.run(
      runIntel({
        io: b.io,
        env: ON,
        now: clock.now,
        setTimer: clock.setTimer,
        fetchers: { usgs: timed(clock, starts, "usgs", 11 * S, itemsFor("usgs", "a")), jma: timed(clock, starts, "jma", 30 * S) },
      }),
    );
    assert.equal(r.status, "done");
    assert.equal(starts.jma, undefined);
    const s = parseState(b.files.get(STATE)!.text);
    assert.deepEqual(s.sources.jma, old, "始めなかった地震の状態は変えない");
    assert.equal(s.sources.usgs?.lastCount, 1);
    assert.ok(s.sources.usgs?.lastSuccessAt);
    assert.equal(s.lock, null);
    // 次の回（5 分後・遅れなし）：地震は取りに行く時刻のまま。本物の気象庁の取得で、長期フィード（取りこぼしの補い）も読む
    const urls: string[] = [];
    const fetchImpl = (async (url: string) => {
      urls.push(url);
      return new Response('<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"></feed>', { status: 200 });
    }) as unknown as typeof fetch;
    clock.t = T0 + 5 * MIN;
    const r2 = await clock.run(runIntel({ io: b.io, env: ON, now: clock.now, setTimer: clock.setTimer, fetchImpl, fetchers: { jma: fetchJmaQuake } }));
    assert.equal(r2.sources.jma?.ok, true);
    assert.ok(urls.includes(JMA_EQVOL_URL) && urls.includes(JMA_EQVOL_LONG_URL), urls.join(" "));
  });
});
