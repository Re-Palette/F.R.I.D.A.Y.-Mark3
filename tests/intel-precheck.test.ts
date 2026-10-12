/**
 * E.D.I.T.H. 本番有効化の前の改善：印を取る前の事前の確認（state.json を読むだけ）と、印を取れなかったときの区別。
 *   - 時刻が来た情報源が無く、有効な印も無い → done（脳に書き込まない）
 *   - ほかの実行の有効な印がある → busy（取得も書き込みもしない）
 *   - 読めない・締切 → 「情報源なし」とは扱わない（failed / timeout）
 *   - 印を取れなかった：本当の競合は busy（ok）、書けない・障害は error（failed・500）
 * 偽の脳（GitHub の sha 比較と同じ決まり）と偽の取得だけで確かめる。通信はしない。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { IntelItem, IntelSourceId } from "../src/integrations/intel/types";
import type { IntelBrainIO } from "../src/integrations/intel/brain-io";
import type { IntelRunResult } from "../src/integrations/intel/collect";
const { runIntel } = await import("../src/integrations/intel/collect");
const { handleIntelCron } = await import("../src/integrations/intel/cron");
const { BrainAbortError, INTEL_SETTINGS_PATH, INTEL_STATE_PATH, INTEL_ITEMS_PATH } = await import("../src/integrations/intel/brain-io");
const { renderSettingsNote, defaultSettings } = await import("../src/integrations/intel/settings");
const { parseState, emptyState, serializeState, LOCK_TTL_MS, TrackingHoldError } = await import("../src/integrations/intel/state");
const { parseItems } = await import("../src/integrations/intel/store");
const { parseUsgs } = await import("../src/integrations/intel/sources/usgs");
const { fakeBrain, untouchableBrain } = await import("./intel-fake");

const NOW = Date.parse("2026-10-12T03:00:00.000Z");
const MIN = 60_000;
const ON = { EDITH_INTEL: "on" };
const STATE = INTEL_STATE_PATH;
const ITEMS = INTEL_ITEMS_PATH;
const SETTINGS = INTEL_SETTINGS_PATH;
const iso = (t: number) => new Date(t).toISOString();

function settingsWith(...ids: IntelSourceId[]): string {
  const s = defaultSettings();
  for (const k of Object.keys(s.sources) as IntelSourceId[]) s.sources[k] = ids.includes(k);
  return renderSettingsNote(s);
}

const itemsFor = (id: string): IntelItem[] =>
  parseUsgs(
    { type: "FeatureCollection", features: [{ id, geometry: { coordinates: [140, 35, 10] }, properties: { mag: 5, place: "x", time: NOW - MIN, updated: NOW, status: "reviewed" } }] },
    NOW,
  );

/** 取得の偽物（呼ばれた回数を数える） */
function fetcher(result: IntelItem[] | Error = itemsFor("a")) {
  let calls = 0;
  return {
    fn: async () => {
      calls++;
      if (result instanceof Error) throw result;
      return result;
    },
    get calls() {
      return calls;
    },
  };
}

/** 状態（usgs の次の時刻・最後に取れた時刻・印）を作る */
function stateText(o: { nextAllowedAt?: number; lastSuccessAt?: number; lock?: { owner: string; until: number } } = {}): string {
  const s = emptyState();
  if (o.nextAllowedAt !== undefined || o.lastSuccessAt !== undefined) {
    s.sources.usgs = {
      lastRunAt: o.lastSuccessAt ? iso(o.lastSuccessAt) : null,
      lastSuccessAt: o.lastSuccessAt ? iso(o.lastSuccessAt) : null,
      lastError: null,
      failures: 0,
      nextAllowedAt: o.nextAllowedAt !== undefined ? iso(o.nextAllowedAt) : null,
      lastCount: 0,
    };
  }
  if (o.lock) s.lock = { owner: o.lock.owner, until: iso(o.lock.until) };
  return serializeState(s);
}

/** GitHub の呼び出しを数える（read ＝ GET 1 回、update ＝ GET＋変わったときだけ PUT。PUT はコミット 1 回） */
function counted(io: IntelBrainIO) {
  const reads: string[] = [];
  const updates: string[] = [];
  const wrapped: IntelBrainIO = {
    configured: () => io.configured(),
    read: (p, o) => (reads.push(p), io.read(p, o)),
    update: (p, u, m, o) => (updates.push(p), io.update(p, u, m, o)),
  };
  return { io: wrapped, reads, updates };
}

/** ハンドラーを通した応答（HTTP の状態の番号・ok・health・status） */
async function respond(run: () => Promise<IntelRunResult>) {
  const env = { CRON_SECRET: "s" };
  const quiet = { info() {}, warn() {}, error() {} };
  const r = await handleIntelCron(new Request("https://friday.test/api/cron/intel", { headers: { authorization: "Bearer s" } }), { env, run, log: quiet });
  const j = (await r.json()) as { ok: boolean; health: string; status: string };
  return { http: r.status, ok: j.ok, health: j.health, status: j.status };
}

/* ---------- 1. 何もしない回は書き込まない ---------- */

describe("事前の確認：時刻が来た情報源が無く、有効な印も無い → done。脳に書き込まない", () => {
  it("次の時刻がまだ → done・書き込み 0・印を取らない・取得しない。GitHub の呼び出しは読み込み 2 回だけ", async () => {
    const before = stateText({ nextAllowedAt: NOW + 5 * MIN, lastSuccessAt: NOW - 5 * MIN });
    const b = fakeBrain({ [SETTINGS]: settingsWith("usgs"), [STATE]: before });
    const c = counted(b.io);
    const f = fetcher();
    const r = await runIntel({ io: c.io, env: ON, now: () => NOW, fetchers: { usgs: f.fn } });
    assert.equal(r.status, "done");
    assert.deepEqual(r.sources, {});
    assert.equal(r.saved, 0);
    assert.equal(f.calls, 0);
    assert.equal(b.writes, 0);
    assert.deepEqual(c.updates, []);
    assert.deepEqual(c.reads, [SETTINGS, STATE]);
    assert.equal(b.files.get(STATE)!.text, before, "state.json は変わらない");
    assert.equal(b.files.has(ITEMS), false);
  });

  it("何もしない回でも、古い情報源（stale）は読んだ状態から返す", async () => {
    const b = fakeBrain({ [SETTINGS]: settingsWith("usgs"), [STATE]: stateText({ nextAllowedAt: NOW + 5 * MIN, lastSuccessAt: NOW - 3 * 60 * MIN }) });
    const r = await runIntel({ io: b.io, env: ON, now: () => NOW, fetchers: { usgs: fetcher().fn } });
    assert.equal(r.status, "done");
    assert.deepEqual(r.stale, ["usgs"]);
    assert.equal(b.writes, 0);
  });

  it("全体は ON でも、情報源がすべて OFF → done・書き込み 0", async () => {
    const b = fakeBrain({ [SETTINGS]: settingsWith() });
    const f = fetcher();
    const r = await runIntel({ io: b.io, env: ON, now: () => NOW, fetchers: { usgs: f.fn } });
    assert.equal(r.status, "done");
    assert.equal(f.calls, 0);
    assert.equal(b.writes, 0);
    assert.equal(b.files.has(STATE), false);
  });

  it("期限切れの印が残っていても、時刻が来た情報源が無ければ done・書き込み 0（印はそのまま。次に取る回に取り直す）", async () => {
    const before = stateText({ nextAllowedAt: NOW + 5 * MIN, lock: { owner: "old", until: NOW - MIN } });
    const b = fakeBrain({ [SETTINGS]: settingsWith("usgs"), [STATE]: before });
    const r = await runIntel({ io: b.io, env: ON, now: () => NOW, fetchers: { usgs: fetcher().fn } });
    assert.equal(r.status, "done");
    assert.equal(b.writes, 0);
    assert.equal(b.files.get(STATE)!.text, before);
  });
});

/* ---------- 2. ほかの実行の有効な印 ---------- */

describe("事前の確認：ほかの実行の有効な印がある → busy。取得も書き込みもしない", () => {
  for (const due of [true, false]) {
    it(`時刻が来た情報源が${due ? "ある" : "無い"}とき`, async () => {
      const before = stateText({ nextAllowedAt: due ? NOW - MIN : NOW + 5 * MIN, lock: { owner: "other", until: NOW + 2 * MIN } });
      const b = fakeBrain({ [SETTINGS]: settingsWith("usgs"), [STATE]: before });
      const c = counted(b.io);
      const f = fetcher();
      const r = await runIntel({ io: c.io, env: ON, now: () => NOW, fetchers: { usgs: f.fn } });
      assert.equal(r.status, "busy");
      assert.equal(f.calls, 0);
      assert.equal(b.writes, 0);
      assert.deepEqual(c.updates, []);
      assert.equal(b.files.get(STATE)!.text, before);
    });
  }
});

/* ---------- 3. 期限切れ・壊れた印・壊れた状態は、これまでどおり取り直す ---------- */

describe("事前の確認の後は、これまでどおり印を取る（sha 比較・持ち主の確認・期限切れの処理はそのまま）", () => {
  for (const [label, until] of [
    ["期限切れの印", NOW - MIN],
    ["遠い未来の（壊れた）期限の印", Date.parse("9999-01-01T00:00:00Z")],
  ] as const) {
    it(`${label}があり、時刻が来た情報源がある → 印を取り直して実行し、印を外す`, async () => {
      const b = fakeBrain({ [SETTINGS]: settingsWith("usgs"), [STATE]: stateText({ nextAllowedAt: NOW - MIN, lock: { owner: "old", until } }) });
      const c = counted(b.io);
      const f = fetcher();
      const r = await runIntel({ io: c.io, env: ON, now: () => NOW, fetchers: { usgs: f.fn } });
      assert.equal(r.status, "done");
      assert.equal(f.calls, 1);
      assert.equal(parseState(b.files.get(STATE)!.text).lock, null);
      assert.equal(parseItems(b.files.get(ITEMS)!.text).length, 1);
      // 状態の読み込み（事前の確認・持ち主の確認）と、印を取る・外すの 2 回の書き込み、情報の保存
      assert.deepEqual(c.reads, [SETTINGS, STATE, ITEMS, STATE]);
      assert.deepEqual(b.writeLog, [STATE, ITEMS, STATE]);
    });
  }

  it("state.json が無い（初めての実行）→ 取りに行く", async () => {
    const b = fakeBrain({ [SETTINGS]: settingsWith("usgs") });
    const f = fetcher();
    const r = await runIntel({ io: b.io, env: ON, now: () => NOW, fetchers: { usgs: f.fn } });
    assert.equal(r.status, "done");
    assert.equal(f.calls, 1);
    assert.equal(parseState(b.files.get(STATE)!.text).lock, null);
  });

  it("壊れた state.json → これまでどおり空の状態として扱い、取りに行く", async () => {
    const b = fakeBrain({ [SETTINGS]: settingsWith("usgs"), [STATE]: "{壊れた" });
    const f = fetcher();
    const r = await runIntel({ io: b.io, env: ON, now: () => NOW, fetchers: { usgs: f.fn } });
    assert.equal(r.status, "done");
    assert.equal(f.calls, 1);
    assert.equal(parseState(b.files.get(STATE)!.text).sources.usgs?.lastSuccessAt, iso(NOW));
  });
});

/* ---------- 4. 事前の確認と、印を取るまでの間に状態が変わる ---------- */

describe("事前の確認と印を取るまでの間に、状態が変わった", () => {
  /** 事前の確認（state.json の 1 回目の読み込み）の直後に、ほかの実行が書いたことにする */
  function changeAfterPrecheck(b: ReturnType<typeof fakeBrain>, text: string): IntelBrainIO {
    let n = 0;
    return {
      ...b.io,
      read: async (p, o) => {
        const r = await b.io.read(p, o);
        if (p === STATE && ++n === 1) b.rawWrite(STATE, text);
        return r;
      },
    };
  }

  it("ほかの実行が先に印を取った → busy。取得も書き込みもしない（印は奪わない）", async () => {
    const b = fakeBrain({ [SETTINGS]: settingsWith("usgs"), [STATE]: stateText({ nextAllowedAt: NOW - MIN }) });
    const other = stateText({ nextAllowedAt: NOW - MIN, lock: { owner: "other", until: NOW + LOCK_TTL_MS } });
    const f = fetcher();
    const r = await runIntel({ io: changeAfterPrecheck(b, other), env: ON, now: () => NOW, fetchers: { usgs: f.fn } });
    assert.equal(r.status, "busy");
    assert.equal(f.calls, 0);
    assert.equal(b.writes, 0);
    assert.equal(parseState(b.files.get(STATE)!.text).lock?.owner, "other");
  });

  it("ほかの実行が取り終えた（もう時刻が来ていない）→ 印を取った後の最新の状態で決め直し、取りに行かない。印は外す", async () => {
    const b = fakeBrain({ [SETTINGS]: settingsWith("usgs"), [STATE]: stateText({ nextAllowedAt: NOW - MIN }) });
    const done = stateText({ nextAllowedAt: NOW + 10 * MIN, lastSuccessAt: NOW });
    const f = fetcher();
    const r = await runIntel({ io: changeAfterPrecheck(b, done), env: ON, now: () => NOW, fetchers: { usgs: f.fn } });
    assert.equal(r.status, "done");
    assert.equal(f.calls, 0, "重複して取りに行かない");
    assert.equal(b.files.has(ITEMS), false);
    const s = parseState(b.files.get(STATE)!.text);
    assert.equal(s.lock, null);
    assert.equal(s.sources.usgs?.nextAllowedAt, iso(NOW + 10 * MIN), "ほかの実行の記録を消さない");
  });

  it("印を書く直前にほかの実行が印を取った（GitHub の 409 → 読み直すと他人の印）→ busy（ok・200）", async () => {
    const b = fakeBrain({ [SETTINGS]: settingsWith("usgs"), [STATE]: stateText({ nextAllowedAt: NOW - MIN }) });
    b.interrupt((p) => {
      if (p === STATE) b.rawWrite(STATE, stateText({ nextAllowedAt: NOW - MIN, lock: { owner: "other", until: NOW + LOCK_TTL_MS } }));
    });
    const f = fetcher();
    const res = await respond(() => runIntel({ io: b.io, env: ON, now: () => NOW, fetchers: { usgs: f.fn } }));
    assert.deepEqual(res, { http: 200, ok: true, health: "ok", status: "busy" });
    assert.equal(f.calls, 0);
    assert.equal(b.writes, 0);
  });
});

/* ---------- 5. 読めない・締切は「情報源なし」と扱わない ---------- */

describe("事前の確認で state.json を読めない・締切 → done にしない", () => {
  function failingStateRead(b: ReturnType<typeof fakeBrain>, err: Error): IntelBrainIO {
    return { ...b.io, read: async (p, o) => (p === STATE ? Promise.reject(err) : b.io.read(p, o)) };
  }

  it("通信の失敗など → 例外（ハンドラーは 500・ok:false・health:\"failed\"）。何も書かない", async () => {
    const b = fakeBrain({ [SETTINGS]: settingsWith("usgs"), [STATE]: stateText({ nextAllowedAt: NOW + 5 * MIN }) });
    const io = failingStateRead(b, new Error("GitHub に接続できませんでした。"));
    await assert.rejects(runIntel({ io, env: ON, now: () => NOW, fetchers: { usgs: fetcher().fn } }));
    const res = await respond(() => runIntel({ io, env: ON, now: () => NOW, fetchers: { usgs: fetcher().fn } }));
    assert.deepEqual(res, { http: 500, ok: false, health: "failed", status: "error" });
    assert.equal(b.writes, 0);
  });

  it("締切で止めた → timeout（200・health:\"degraded\"）。何も書かない・取りに行かない", async () => {
    const b = fakeBrain({ [SETTINGS]: settingsWith("usgs"), [STATE]: stateText({ nextAllowedAt: NOW + 5 * MIN }) });
    const f = fetcher();
    const io = failingStateRead(b, new BrainAbortError(false));
    const r = await runIntel({ io, env: ON, now: () => NOW, fetchers: { usgs: f.fn } });
    assert.equal(r.status, "timeout");
    const res = await respond(() => runIntel({ io, env: ON, now: () => NOW, fetchers: { usgs: f.fn } }));
    assert.deepEqual(res, { http: 200, ok: true, health: "degraded", status: "timeout" });
    assert.equal(f.calls, 0);
    assert.equal(b.writes, 0);
  });

  it("設定ノートを読めない → 例外（500・failed）。state.json も読まない", async () => {
    const b = fakeBrain({ [STATE]: stateText({ nextAllowedAt: NOW + 5 * MIN }) });
    const c = counted({ ...b.io, read: async (p, o) => (p === SETTINGS ? Promise.reject(new Error("GitHub でエラーが発生しました（503）。")) : b.io.read(p, o)) });
    const res = await respond(() => runIntel({ io: c.io, env: ON, now: () => NOW, fetchers: { usgs: fetcher().fn } }));
    assert.deepEqual(res, { http: 500, ok: false, health: "failed", status: "error" });
    assert.deepEqual(c.reads, [SETTINGS]);
    assert.equal(b.writes, 0);
  });
});

/* ---------- 6. 印を取れなかった：本当の競合と、異常を区別する ---------- */

describe("印を取れなかった：書けない・障害は error（busy にしない）", () => {
  const cases: [string, Error][] = [
    ["書き込み権限が無い（403）", new Error("脳（GitHub）のトークンに書き込み権限がありません。")],
    ["制限（429）・そのほかの障害", new Error("GitHub でエラーが発生しました（429）。")],
    ["ぶつかり続けた（409 が 2 回）", new Error("GitHub でエラーが発生しました（409）。")],
    ["書き込みの前の通信の失敗", new Error("GitHub に接続できませんでした。")],
  ];
  for (const [label, err] of cases) {
    it(`${label} → error（500・ok:false・health:"failed"）。取得しない・何も書かない`, async () => {
      const b = fakeBrain({ [SETTINGS]: settingsWith("usgs"), [STATE]: stateText({ nextAllowedAt: NOW - MIN }) });
      const before = b.files.get(STATE)!.text;
      b.failWrites((p) => (p === STATE ? err : null));
      const f = fetcher();
      const r = await runIntel({ io: b.io, env: ON, now: () => NOW, fetchers: { usgs: f.fn } });
      assert.equal(r.status, "error");
      assert.match(r.error ?? "", /印を取れませんでした/);
      assert.doesNotMatch(r.error ?? "", /ghp_|token=/i);
      const res = await respond(() => runIntel({ io: b.io, env: ON, now: () => NOW, fetchers: { usgs: f.fn } }));
      assert.deepEqual(res, { http: 500, ok: false, health: "failed", status: "error" });
      assert.equal(f.calls, 0);
      assert.equal(b.writes, 0);
      assert.equal(b.files.get(STATE)!.text, before);
    });
  }

  it("知らない版の追跡の記録を保てない（TrackingHoldError）→ error。state.json は書き換えない", async () => {
    const huge = { version: 999, blob: "x".repeat(300_000) };
    const before = JSON.stringify({ ...JSON.parse(stateText({ nextAllowedAt: NOW - MIN })), tracking: huge });
    const b = fakeBrain({ [SETTINGS]: settingsWith("usgs"), [STATE]: before });
    assert.throws(() => serializeState(parseState(before)), TrackingHoldError);
    const f = fetcher();
    const res = await respond(() => runIntel({ io: b.io, env: ON, now: () => NOW, fetchers: { usgs: f.fn } }));
    assert.deepEqual(res, { http: 500, ok: false, health: "failed", status: "error" });
    assert.equal(f.calls, 0);
    assert.equal(b.writes, 0);
    assert.equal(b.files.get(STATE)!.text, before);
  });
});

/* ---------- 7. 取得の結果・再実行 ---------- */

describe("取得の結果と再実行（重複保存をしない）", () => {
  it("情報源が 0 件を返した → done。items.json は書かず、成功は記録する（次の時刻を進める）", async () => {
    const b = fakeBrain({ [SETTINGS]: settingsWith("usgs") });
    const r = await runIntel({ io: b.io, env: ON, now: () => NOW, fetchers: { usgs: fetcher([]).fn } });
    assert.equal(r.status, "done");
    assert.equal(r.saved, 0);
    assert.equal(b.files.has(ITEMS), false);
    const s = parseState(b.files.get(STATE)!.text);
    assert.equal(s.sources.usgs?.lastSuccessAt, iso(NOW));
    assert.equal(s.lock, null);
  });

  it("同じ情報を次の回にもう一度取った → items.json を書き直さない（1 件のまま）", async () => {
    const b = fakeBrain({ [SETTINGS]: settingsWith("usgs") });
    const items = itemsFor("same");
    await runIntel({ io: b.io, env: ON, now: () => NOW, fetchers: { usgs: fetcher(items).fn } });
    const later = NOW + 11 * MIN;
    const r = await runIntel({ io: b.io, env: ON, now: () => later, fetchers: { usgs: fetcher(items).fn } });
    assert.equal(r.status, "done");
    assert.equal(b.writeLog.filter((p) => p === ITEMS).length, 1);
    assert.equal(parseItems(b.files.get(ITEMS)!.text).length, 1);
  });
});

/* ---------- 8. EDITH_INTEL と、結果ごとの応答 ---------- */

describe("EDITH_INTEL と応答（HTTP・ok・health。Actions は ok なら成功、degraded・failed なら失敗）", () => {
  it("EDITH_INTEL が on・true・1 以外（未設定・空・off・0・yes）→ disabled。脳にも外にも触れない（200・ok）", async () => {
    const f = fetcher();
    for (const env of [{}, { EDITH_INTEL: "" }, { EDITH_INTEL: "off" }, { EDITH_INTEL: "0" }, { EDITH_INTEL: "yes" }]) {
      const res = await respond(() => runIntel({ io: untouchableBrain, env, now: () => NOW, fetchers: { usgs: f.fn } }));
      assert.deepEqual(res, { http: 200, ok: true, health: "ok", status: "disabled" });
    }
    assert.equal(f.calls, 0);
  });

  it("EDITH_INTEL が on・ON・true・1 → 動く", async () => {
    for (const v of ["on", "ON", "true", "1"]) {
      const b = fakeBrain({ [SETTINGS]: settingsWith("usgs") });
      const f = fetcher();
      const r = await runIntel({ io: b.io, env: { EDITH_INTEL: v }, now: () => NOW, fetchers: { usgs: f.fn } });
      assert.equal(r.status, "done", v);
      assert.equal(f.calls, 1, v);
    }
  });

  it("done（何もしない回・取った回）・busy は 200・ok:true・health:\"ok\"", async () => {
    const idle = fakeBrain({ [SETTINGS]: settingsWith("usgs"), [STATE]: stateText({ nextAllowedAt: NOW + 5 * MIN }) });
    assert.deepEqual(await respond(() => runIntel({ io: idle.io, env: ON, now: () => NOW, fetchers: { usgs: fetcher().fn } })), { http: 200, ok: true, health: "ok", status: "done" });
    const work = fakeBrain({ [SETTINGS]: settingsWith("usgs") });
    assert.deepEqual(await respond(() => runIntel({ io: work.io, env: ON, now: () => NOW, fetchers: { usgs: fetcher().fn } })), { http: 200, ok: true, health: "ok", status: "done" });
    const busy = fakeBrain({ [SETTINGS]: settingsWith("usgs"), [STATE]: stateText({ lock: { owner: "other", until: NOW + MIN } }) });
    assert.deepEqual(await respond(() => runIntel({ io: busy.io, env: ON, now: () => NOW, fetchers: { usgs: fetcher().fn } })), { http: 200, ok: true, health: "ok", status: "busy" });
  });
});
