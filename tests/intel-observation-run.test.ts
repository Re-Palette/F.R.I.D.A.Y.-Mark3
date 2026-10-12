/**
 * E.D.I.T.H. Phase 3-2：収集の 1 回分（runIntel）で、観測の記録を保存する。
 * 通信はしない（脳は偽物。情報源の取得も偽物で、ctx.observe に固定の観測の記録を渡す）。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { FeedObservation, IntelItem, IntelSourceId } from "../src/integrations/intel/types";
import type { IntelBrainIO } from "../src/integrations/intel/brain-io";
import type { SourceContext } from "../src/integrations/intel/sources/common";
const { runIntel } = await import("../src/integrations/intel/collect");
const { INTEL_SETTINGS_PATH, INTEL_STATE_PATH, INTEL_ITEMS_PATH, INTEL_OBSERVATIONS_PATH } = await import("../src/integrations/intel/brain-io");
const { renderSettingsNote, defaultSettings } = await import("../src/integrations/intel/settings");
const { parseState, emptyState } = await import("../src/integrations/intel/state");
const { parseItems } = await import("../src/integrations/intel/store");
const { parseObservationStore, serializeObservationStore, appendObservation, emptyObservationStore } = await import("../src/integrations/intel/observation-store");
const { parseUsgs } = await import("../src/integrations/intel/sources/usgs");
const { fakeBrain, untouchableBrain } = await import("./intel-fake");

const NOW = Date.parse("2026-10-11T12:55:00.000Z");
const ON = { EDITH_INTEL: "on" };
const STATE = INTEL_STATE_PATH;
const ITEMS = INTEL_ITEMS_PATH;
const OBS = INTEL_OBSERVATIONS_PATH;

function settingsWith(...ids: IntelSourceId[]): string {
  const s = defaultSettings();
  for (const k of Object.keys(s.sources) as IntelSourceId[]) s.sources[k] = ids.includes(k);
  return renderSettingsNote(s);
}

/** 気象庁の台風の観測の記録（取得できた回） */
function okObs(at: number): FeedObservation {
  const iso = (t: number) => new Date(t).toISOString();
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

function failedObs(at: number): FeedObservation {
  return { ...okObs(at), status: "fetch-failed", failure: { kind: "http", httpStatus: 503, message: "HTTP 503" }, feedNewestEntryAt: null, entryCount: null, typhoonEntryCount: null, streams: [] };
}

/** 取得した項目（USGS の形を使う。中身は保存の確認だけに使う） */
const someItems = (id: string): IntelItem[] =>
  parseUsgs(
    { type: "FeatureCollection", features: [{ id, geometry: { coordinates: [140, 35, 10] }, properties: { mag: 5, place: "x", time: NOW - 60_000, updated: NOW, status: "reviewed" } }] },
    NOW,
  ).map((i) => ({ ...i, source: "jmatyphoon" as const, id: `jmatyphoon:${id}` }));

/** 観測の記録を ctx.observe に渡してから、項目を返す（または例外を出す）取得の偽物 */
function observing(o: FeedObservation | null, items: IntelItem[] | Error, before?: (ctx: SourceContext) => void) {
  let calls = 0;
  const fn = async (ctx: SourceContext) => {
    calls++;
    before?.(ctx);
    if (o) ctx.observe?.(o);
    if (items instanceof Error) throw items;
    return items;
  };
  return {
    fn,
    get calls() {
      return calls;
    },
  };
}

const lockOf = (b: ReturnType<typeof fakeBrain>) => parseState(b.files.get(STATE)!.text).lock;

describe("保存の順番", () => {
  it("印を確かめた後、情報 → 観測の記録 → 状態の順に書く（印を取るのが最初）", async () => {
    const b = fakeBrain({ [INTEL_SETTINGS_PATH]: settingsWith("jmatyphoon") });
    const f = observing(okObs(NOW), someItems("a"));
    const r = await runIntel({ io: b.io, env: ON, now: () => NOW, fetchers: { jmatyphoon: f.fn } });
    assert.equal(r.status, "done");
    assert.deepEqual(b.writeLog, [STATE, ITEMS, OBS, STATE]);
    assert.deepEqual(r.observations, { saved: 1, skipped: 0, failed: 0, unknown: 0, codes: [] });
    const saved = parseObservationStore(b.files.get(OBS)!.text).store;
    assert.deepEqual(saved.sources.jmatyphoon!.latest, okObs(NOW));
    assert.equal(lockOf(b), null);
    assert.equal(parseState(b.files.get(STATE)!.text).sources.jmatyphoon?.lastCount, 1);
  });

  it("新しい項目が無い回も、観測の記録は保存する（状態の前）", async () => {
    const b = fakeBrain({ [INTEL_SETTINGS_PATH]: settingsWith("jmatyphoon") });
    const r = await runIntel({ io: b.io, env: ON, now: () => NOW, fetchers: { jmatyphoon: observing(okObs(NOW), []).fn } });
    assert.equal(r.status, "done");
    assert.deepEqual(b.writeLog, [STATE, OBS, STATE]);
    assert.equal(r.observations?.saved, 1);
  });

  it("取得に失敗した回の観測の記録（fetch-failed）も保存し、情報源の失敗はこれまでどおり記録する", async () => {
    const b = fakeBrain({ [INTEL_SETTINGS_PATH]: settingsWith("jmatyphoon") });
    const r = await runIntel({ io: b.io, env: ON, now: () => NOW, fetchers: { jmatyphoon: observing(failedObs(NOW), new Error("HTTP 503")).fn } });
    assert.equal(r.status, "done");
    assert.equal(r.sources.jmatyphoon?.ok, false);
    assert.equal(r.observations?.saved, 1);
    assert.equal(parseObservationStore(b.files.get(OBS)!.text).store.sources.jmatyphoon!.latest.status, "fetch-failed");
    assert.equal(parseState(b.files.get(STATE)!.text).sources.jmatyphoon?.failures, 1);
  });
});

describe("書かないとき", () => {
  it("印を失っていたら、情報・観測の記録・状態のどれも書かない", async () => {
    const b = fakeBrain({ [INTEL_SETTINGS_PATH]: settingsWith("jmatyphoon") });
    const f = observing(okObs(NOW), someItems("a"), () =>
      b.rawWrite(STATE, JSON.stringify({ ...emptyState(), lock: { owner: "newer", until: new Date(NOW + 180_000).toISOString() } })),
    );
    const r = await runIntel({ io: b.io, env: ON, now: () => NOW, fetchers: { jmatyphoon: f.fn } });
    assert.equal(r.status, "lost-lock");
    assert.deepEqual(b.writeLog, [STATE]); // 印を取った 1 回だけ
    assert.equal(b.files.has(ITEMS), false);
    assert.equal(b.files.has(OBS), false);
    assert.equal(r.observations, undefined);
  });

  it("EDITH_INTEL がオフなら、脳に触れず、取得も観測の記録もしない", async () => {
    const f = observing(okObs(NOW), someItems("a"));
    for (const env of [{}, { EDITH_INTEL: "off" }, { EDITH_INTEL: "" }]) {
      const r = await runIntel({ io: untouchableBrain, env, now: () => NOW, fetchers: { jmatyphoon: f.fn } });
      assert.equal(r.status, "disabled");
      assert.equal(r.observations, undefined);
    }
    assert.equal(f.calls, 0);
  });

  it("時刻が来ていない情報源は取りに行かず、観測の記録を作らない・保存しない", async () => {
    const state = { ...emptyState(), sources: { jmatyphoon: { lastRunAt: null, lastSuccessAt: null, lastError: null, failures: 0, nextAllowedAt: new Date(NOW + 60_000).toISOString(), lastCount: 0 } } };
    const b = fakeBrain({ [INTEL_SETTINGS_PATH]: settingsWith("jmatyphoon"), [STATE]: JSON.stringify(state) });
    const f = observing(okObs(NOW), someItems("a"));
    const r = await runIntel({ io: b.io, env: ON, now: () => NOW, fetchers: { jmatyphoon: f.fn } });
    assert.equal(r.status, "done");
    assert.equal(f.calls, 0);
    assert.equal(b.files.has(OBS), false);
    assert.equal(r.observations, undefined);
  });

  it("情報の保存（saveItems）に失敗した回は、観測の記録を保存しない（状態は書き、印は外す）", async () => {
    const b = fakeBrain({ [INTEL_SETTINGS_PATH]: settingsWith("jmatyphoon") });
    b.failWrites((p) => (p === ITEMS ? new Error("GitHub でエラーが発生しました（429）") : null));
    const r = await runIntel({ io: b.io, env: ON, now: () => NOW, fetchers: { jmatyphoon: observing(okObs(NOW), someItems("a")).fn } });
    assert.equal(r.status, "error");
    assert.equal(b.files.has(OBS), false);
    assert.equal(lockOf(b), null);
  });

  it("持ち時間を超えて取りに行かなかった情報源は、観測の記録を作らない", async () => {
    const b = fakeBrain({ [INTEL_SETTINGS_PATH]: settingsWith("usgs", "jmatyphoon") });
    let t = NOW;
    const typhoon = observing(okObs(NOW), someItems("a"));
    const r = await runIntel({
      io: b.io,
      env: ON,
      now: () => t,
      budgetMs: 1000,
      fetchers: { usgs: async () => ((t += 5000), []), jmatyphoon: typhoon.fn },
    });
    assert.equal(r.sources.jmatyphoon?.skipped, "時間切れのため次回");
    assert.equal(typhoon.calls, 0);
    assert.equal(r.observations, undefined);
    assert.equal(b.files.has(OBS), false);
  });
});

describe("観測の記録の保存がうまくいかなくても、収集は通常どおり終わる", () => {
  /** 通常どおり終わったか（done・情報の保存・状態の記録・印を外す） */
  function finishedNormally(b: ReturnType<typeof fakeBrain>, r: Awaited<ReturnType<typeof runIntel>>) {
    assert.equal(r.status, "done");
    assert.equal(r.sources.jmatyphoon?.ok, true);
    assert.equal(parseItems(b.files.get(ITEMS)!.text).length, 1);
    const s = parseState(b.files.get(STATE)!.text);
    assert.equal(s.lock, null);
    assert.equal(s.sources.jmatyphoon?.lastCount, 1);
    assert.equal(s.sources.jmatyphoon?.failures, 0);
  }

  it("書き込みに失敗（ok:false）しても done。理由の種類だけを残す", async () => {
    const b = fakeBrain({ [INTEL_SETTINGS_PATH]: settingsWith("jmatyphoon") });
    b.failWrites((p) => (p === OBS ? new Error("GitHub でエラーが発生しました（503） token=ghp_secret") : null));
    const r = await runIntel({ io: b.io, env: ON, now: () => NOW, fetchers: { jmatyphoon: observing(okObs(NOW), someItems("a")).fn } });
    finishedNormally(b, r);
    assert.deepEqual(r.observations, { saved: 0, skipped: 0, failed: 1, unknown: 0, codes: ["write-failed"] });
    assert.doesNotMatch(JSON.stringify(r), /ghp_secret|GitHub でエラー/);
  });

  it("観測の記録のファイルが壊れていても（JSON でない・知らない版）、収集は通常どおりで、ファイルはそのまま", async () => {
    for (const [text, code] of [
      ["{壊れ", "invalid-json"],
      ['{"version":9,"sources":{}}', "unsupported-version"],
      ["", "empty"],
    ] as const) {
      const b = fakeBrain({ [INTEL_SETTINGS_PATH]: settingsWith("jmatyphoon"), [OBS]: text });
      const r = await runIntel({ io: b.io, env: ON, now: () => NOW, fetchers: { jmatyphoon: observing(okObs(NOW), someItems("a")).fn } });
      finishedNormally(b, r);
      assert.deepEqual(r.observations, { saved: 0, skipped: 0, failed: 1, unknown: 0, codes: [code] });
      assert.equal(b.files.get(OBS)!.text, text);
    }
  });

  it("保存の途中で例外が出ても（思わぬ失敗）、done で終わる", async () => {
    const b = fakeBrain({ [INTEL_SETTINGS_PATH]: settingsWith("jmatyphoon") });
    let armed = false;
    // 取得の後は configured が例外を出す脳（観測の記録の保存だけが configured を呼ぶ）
    const io: IntelBrainIO = {
      ...b.io,
      configured: () => {
        if (armed) throw new Error("思わぬ失敗");
        return true;
      },
    };
    const r = await runIntel({ io, env: ON, now: () => NOW, fetchers: { jmatyphoon: observing(okObs(NOW), someItems("a"), () => (armed = true)).fn } });
    finishedNormally(b, r);
    assert.deepEqual(r.observations, { saved: 0, skipped: 0, failed: 1, unknown: 0, codes: ["unexpected-error"] });
  });

  it("止めても終わらない口（signal を無視する）でも、決まった時間で待つのをやめ、結果不明として状態の記録を済ませる", async () => {
    const b = fakeBrain({ [INTEL_SETTINGS_PATH]: settingsWith("jmatyphoon") });
    const io: IntelBrainIO = { ...b.io, update: (path, u, m, o) => (path === OBS ? new Promise<void>(() => {}) : b.io.update(path, u, m, o)) };
    const started = Date.now();
    const r = await runIntel({
      io,
      env: ON,
      now: () => NOW,
      observationSaveWaitMs: 30,
      observationAbortGraceMs: 30,
      fetchers: { jmatyphoon: observing(okObs(NOW), someItems("a")).fn },
    });
    finishedNormally(b, r);
    assert.deepEqual(r.observations, { saved: 0, skipped: 0, failed: 0, unknown: 1, codes: ["save-not-settled"] });
    assert.ok(Date.now() - started < 5000);
  });
});

describe("時間切れ", () => {
  it("取得が finishRun の開始締切（40 秒）を過ぎたら、情報・観測の記録は保存せず、状態の記録（finishRun）は省かない（timeout）", async () => {
    const b = fakeBrain({ [INTEL_SETTINGS_PATH]: settingsWith("jmatyphoon") });
    let t = NOW;
    // 取得に 46 秒かかった（新しい取得の締切は始める前に見るので、取得そのものは行われる）
    const f = observing(okObs(NOW), someItems("a"), () => (t += 46_000));
    const r = await runIntel({ io: b.io, env: ON, now: () => t, fetchers: { jmatyphoon: f.fn } });
    assert.equal(r.status, "timeout");
    assert.deepEqual(r.observations, { saved: 0, skipped: 1, failed: 0, unknown: 0, codes: ["time-budget-exceeded"] });
    assert.deepEqual(r.deferred, ["jmatyphoon"]);
    assert.deepEqual(b.writeLog, [STATE, STATE]); // 印を取る・状態の記録だけ（情報・観測の記録は書かない）
    assert.equal(lockOf(b), null);
    const st = parseState(b.files.get(STATE)!.text).sources.jmatyphoon!;
    assert.equal(st.lastSuccessAt, null, "保存できなかったので成功と記録しない");
    assert.equal(st.lastCount, 0);
    assert.equal(st.nextAllowedAt, new Date(NOW + 46_000 + 60 * 60_000).toISOString(), "取りに行く間隔は守る");
  });

  it("締切は設定できる（ちょうど締切なら保存し、過ぎたら飛ばす）", async () => {
    for (const [spent, saved] of [
      [1000, 1],
      [1001, 0],
    ] as const) {
      const b = fakeBrain({ [INTEL_SETTINGS_PATH]: settingsWith("jmatyphoon") });
      let t = NOW;
      const f = observing(okObs(NOW), someItems("a"), () => (t += spent));
      const r = await runIntel({ io: b.io, env: ON, now: () => t, observationDeadlineMs: 1000, fetchers: { jmatyphoon: f.fn } });
      assert.equal(r.status, "done");
      assert.equal(r.observations?.saved, saved);
      assert.equal(r.observations?.skipped, 1 - saved);
    }
  });
});

describe("実行結果の互換性", () => {
  it("観測の記録が無い回は、結果の項目はこれまでと同じ（observations を付けない）", async () => {
    const b = fakeBrain({ [INTEL_SETTINGS_PATH]: settingsWith("jmatyphoon") });
    const r = await runIntel({ io: b.io, env: ON, now: () => NOW, fetchers: { jmatyphoon: async () => someItems("a") } });
    assert.deepEqual(Object.keys(r).sort(), ["saved", "sources", "stale", "status"]);
    assert.equal(b.files.has(OBS), false);
  });

  it("observations は件数と理由の種類だけ（JSON にでき、メッセージ・中身を含まない）", async () => {
    const existing = serializeObservationStore(appendObservation(emptyObservationStore(), okObs(NOW + 60_000)).store);
    const b = fakeBrain({ [INTEL_SETTINGS_PATH]: settingsWith("jmatyphoon"), [OBS]: existing });
    const r = await runIntel({ io: b.io, env: ON, now: () => NOW, fetchers: { jmatyphoon: observing(okObs(NOW), someItems("a")).fn } });
    assert.equal(r.status, "done");
    assert.deepEqual(r.observations, { saved: 0, skipped: 0, failed: 1, unknown: 0, codes: ["out-of-order"] }); // 保存済みより古い観測
    const o = JSON.parse(JSON.stringify(r.observations));
    assert.deepEqual(Object.keys(o).sort(), ["codes", "failed", "saved", "skipped", "unknown"]);
    for (const k of ["saved", "skipped", "failed", "unknown"]) assert.equal(typeof o[k], "number");
    assert.ok(o.codes.every((c: unknown) => typeof c === "string" && /^[a-z-]+$/.test(c as string)));
    assert.equal(b.files.get(OBS)!.text, existing);
  });

  it("1 回の実行でためる観測の記録には上限がある（12 件）", async () => {
    const b = fakeBrain({ [INTEL_SETTINGS_PATH]: settingsWith("jmatyphoon") });
    const fn = async (ctx: SourceContext) => {
      for (let k = 0; k < 20; k++) ctx.observe?.(okObs(NOW - (20 - k) * 60_000));
      return [];
    };
    const r = await runIntel({ io: b.io, env: ON, now: () => NOW, fetchers: { jmatyphoon: fn } });
    assert.equal((r.observations?.saved ?? 0) + (r.observations?.failed ?? 0) + (r.observations?.skipped ?? 0) + (r.observations?.unknown ?? 0), 12);
  });
});
