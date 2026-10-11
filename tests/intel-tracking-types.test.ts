/**
 * E.D.I.T.H. の情報収集（Phase 3 第 1 段階：型とデータの互換性）のテスト。
 *   - これまでの state.json（tracking なし）・items.json（match なし）がそのまま読める
 *   - 新しい tracking・match を保存して読み直せる（実行の印の取り外しを通っても消えない）
 *   - 読めない追跡の記録は、その 1 件だけ捨て、ほかの記録・状態ファイルの残りは消さない
 *   - 状態を推測して作らない（読めない状態は unknown・unverified・null。根拠の無い ended は読まない）
 *   npm test
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { IntelItem, IntelState, IntelTrackedEvent, IntelTracking } from "../src/integrations/intel/types";

const {
  acquireRun,
  finishRun,
  emptyState,
  parseState,
  serializeState,
  recordSuccess,
  holdUnsupportedTracking,
  inspectJsonValue,
  trackingWritable,
  unsupportedTrackingBytes,
  TrackingHoldError,
  MAX_UNSUPPORTED_TRACKING_BYTES,
  MAX_UNSUPPORTED_TRACKING_DEPTH,
} = await import("../src/integrations/intel/state");
const { normalizeItem, normalizeTracking, normalizeTrackedEvent, isoStrict, TRACKING_LIMITS } = await import("../src/integrations/intel/normalize");
const { mergeItems, parseItems, serializeItems } = await import("../src/integrations/intel/store");
const { INTEL_STATE_PATH } = await import("../src/integrations/intel/brain-io");
const { fakeBrain } = await import("./intel-fake");

const NOW = Date.UTC(2026, 9, 11, 12, 55, 0);
const iso = (ms: number) => new Date(ms).toISOString();

/** これまでの（Phase 3 より前の）形の状態ファイル */
const LEGACY_STATE = {
  version: 1,
  lock: null,
  sources: { jmatyphoon: { lastRunAt: iso(NOW), lastSuccessAt: iso(NOW), lastError: null, failures: 0, nextAllowedAt: iso(NOW + 3600_000), lastCount: 1 } },
  notified: { "jma:eq:1": iso(NOW - 60_000) },
  daily: { date: "2026-10-11", normal: 2, urgent: 0 },
  lastRunAt: iso(NOW),
};

/** これまでの形の項目（match なし） */
const LEGACY_ITEM: IntelItem = {
  id: "jma:typhoon:2628",
  source: "jmatyphoon",
  kind: "official",
  category: "weather",
  title: "台風第28号（ノロ）",
  summary: "中心は日本の東・中心気圧 1004hPa",
  url: "https://www.data.jma.go.jp/developer/xml/data/20261011064059_0_VPTW62_010000.xml",
  publishedAt: "2026-10-11T06:00:00.000Z",
  updatedAt: "2026-10-11T06:45:00.000Z",
  fetchedAt: iso(NOW),
  firstSeenAt: iso(NOW),
  place: { name: "日本の東", lat: 32, lon: 146 },
  level: "normal",
  confidence: "high",
  reasons: [],
  corroboration: [],
  clusterId: null,
  conflicts: [],
  facts: { report: "20261011064059_0_VPTW62_010000", code: "VPTW62", typhoon: 28, typhoonKey: "2628", typhoonClass: "熱帯低気圧(TD)", windMs: null },
};

/** 正しい形の追跡の記録（値は 10 月 11 日の観測にそろえる。判定の処理はまだ無いので、手で書いた記録） */
function trackedEvent(over: Partial<IntelTrackedEvent> = {}): IntelTrackedEvent {
  return {
    id: "jma:typhoon:2628",
    source: "jmatyphoon",
    stream: "VPTW62",
    seenEventIds: ["TC2635"],
    phenomenon: { code: "TD", raw: "熱帯低気圧(TD)", observedAt: "2026-10-11T06:00:00.000Z", report: "20261011064059_0_VPTW62_010000" },
    lastBulletin: {
      report: "20261011064059_0_VPTW62_010000",
      serial: "51",
      reportAt: "2026-10-11T06:45:00.000Z",
      targetAt: "2026-10-11T06:00:00.000Z",
      hasForecast: false,
      hasWindPart: false,
      headline: "",
    },
    cadence: { recentAt: ["2026-10-11T06:40:59.000Z", "2026-10-11T03:40:32.000Z", "2026-10-11T00:41:12.000Z"], expectedMs: 3 * 3600_000, basis: "observed" },
    freshness: { level: "overdue", missedSlots: 2, referenceAt: "2026-10-11T12:43:05.000Z", basis: ["09:40Z・12:40Z の発表が無い"] },
    sourceActivity: { status: "event-stalled", peers: [{ stream: "VPTW61", latestAt: "2026-10-11T12:40:36.000Z" }], basis: ["VPTW61 は 12:40Z に発表"] },
    tracking: { status: "paused", since: iso(NOW), basis: ["発表が 2 回分来ていない（終わりとは決めていない）"], endEvidence: null },
    history: [{ report: "20261011064059_0_VPTW62_010000", serial: "51", reportAt: "2026-10-11T06:45:00.000Z", phenomenon: "TD", pressureHpa: 1004 }],
    firstSeenAt: iso(NOW - 3 * 86400_000),
    lastEvaluatedAt: iso(NOW),
    ...over,
  };
}

function tracking(events: IntelTrackedEvent[], streams: IntelTracking["streams"] = {}): IntelTracking {
  return { version: 1, events: Object.fromEntries(events.map((e) => [e.id, e])), streams };
}

describe("これまでのデータがそのまま読める", () => {
  it("tracking の無い state.json：これまでの項目はそのまま、tracking は持たない", () => {
    const s = parseState(JSON.stringify(LEGACY_STATE));
    assert.equal("tracking" in s, false);
    assert.deepEqual(s, { ...LEGACY_STATE, lock: null });
    // 書き直しても形が変わらない（tracking の項目を勝手に作らない）
    assert.deepEqual(JSON.parse(serializeState(s)), LEGACY_STATE);
    assert.equal("tracking" in emptyState(), false);
  });

  it("match の無い項目：読み直しても同じ形（match の項目を勝手に作らない）", () => {
    const n = normalizeItem(LEGACY_ITEM)!;
    assert.equal("match" in n, false);
    assert.deepEqual(n, LEGACY_ITEM);
    const back = parseItems(serializeItems([n]));
    assert.deepEqual(back, [LEGACY_ITEM]);
  });

  it("facts の上限（20 項目）はこれまでどおり", () => {
    const facts = Object.fromEntries(Array.from({ length: 25 }, (_, i) => [`k${i}`, i]));
    assert.equal(Object.keys(normalizeItem({ ...LEGACY_ITEM, facts })!.facts).length, 20);
  });
});

describe("新しい tracking を保存・読み直しできる", () => {
  it("state.json に書いて読み直すと同じ", () => {
    const s: IntelState = { ...emptyState(), tracking: tracking([trackedEvent()], { VPTW62: { lastTrackedId: "jma:typhoon:2628", latestAt: "2026-10-11T06:40:59.000Z" } }) };
    const back = parseState(serializeState(s));
    assert.deepEqual(back, s);
  });

  it("実行の印を取る・外す書き込みを通っても、追跡の記録は消えない", async () => {
    const t = tracking([trackedEvent()]);
    const b = fakeBrain({ [INTEL_STATE_PATH]: serializeState({ ...emptyState(), tracking: t }) });
    const run = (await acquireRun(b.io, NOW, "run-a"))!;
    assert.deepEqual(run.state.tracking, t);
    assert.equal(await finishRun(b.io, run, (s) => recordSuccess(s, "jmatyphoon", 0, NOW), NOW + 1000), true);
    const after = parseState(b.files.get(INTEL_STATE_PATH)!.text);
    assert.deepEqual(after.tracking, t);
    assert.equal(after.sources.jmatyphoon?.lastCount, 0);
  });

  it("終了の根拠がある ended は読める", () => {
    const e = trackedEvent({ tracking: { status: "ended", since: iso(NOW), basis: ["承認済みの終了の文言"], endEvidence: "（テスト用の根拠）" } });
    assert.deepEqual(normalizeTrackedEvent(e), e);
  });
});

describe("match（照合の結果）", () => {
  it("正しい match は保存・読み直しできる", () => {
    const m = { status: "pending" as const, with: ["usgs:us7000abcd"], basis: ["発生時刻の差 12 秒", "候補が 2 件あるため保留"] };
    const n = normalizeItem({ ...LEGACY_ITEM, match: m })!;
    assert.deepEqual(n.match, m);
    assert.deepEqual(parseItems(serializeItems([n]))[0].match, m);
  });

  it("続報で上書きしても、match はその項目の値になる（保存の仕組みは変えない）", () => {
    const a = normalizeItem({ ...LEGACY_ITEM, match: { status: "confirmed", with: ["usgs:x"], basis: [] } })!;
    const b = normalizeItem({ ...LEGACY_ITEM, updatedAt: "2026-10-11T09:45:00.000Z" })!;
    const merged = mergeItems([a], [b], NOW);
    assert.equal(merged.length, 1);
    assert.equal("match" in merged[0], false);
  });

  it("読めない match は持たない（状態が違う・相手が無い・相手が自分だけ・形が違う）", () => {
    for (const bad of [{ status: "maybe", with: ["usgs:x"] }, { status: "confirmed", with: [] }, { status: "confirmed", with: [LEGACY_ITEM.id] }, { status: "pending", with: "usgs:x" }, "confirmed", null]) {
      assert.equal("match" in normalizeItem({ ...LEGACY_ITEM, match: bad })!, false, JSON.stringify(bad));
    }
  });

  it("外から来た文字は消毒し、件数を切る", () => {
    const n = normalizeItem({ ...LEGACY_ITEM, match: { status: "pending", with: [...Array.from({ length: 15 }, (_, i) => `usgs:${i}`), "usgs:0", 5], basis: ["a\u0000b", "", 7] } })!;
    assert.equal(n.match!.with.length, 10);
    assert.deepEqual(n.match!.basis, ["a b"]);
  });
});

describe("読めない追跡の記録の扱い", () => {
  it("tracking の形が違えば持たない。ほかの項目（印・情報源・通知）はそのまま読む", () => {
    for (const bad of ["x", 1, [], { version: 2, events: {} }, { events: {} }, null]) {
      const s = parseState(JSON.stringify({ ...LEGACY_STATE, tracking: bad }));
      assert.equal("tracking" in s, false, JSON.stringify(bad));
      assert.deepEqual(s.sources, LEGACY_STATE.sources);
      assert.deepEqual(s.notified, LEGACY_STATE.notified);
    }
  });

  it("読めない出来事は 1 件だけ捨て、読めるものは残す", () => {
    const good = trackedEvent();
    const raw = {
      version: 1,
      events: {
        [good.id]: good,
        a: { ...trackedEvent({ id: "jma:typhoon:2629" }), source: "unknown-source" },
        b: { ...trackedEvent({ id: "jma:typhoon:2630" }), tracking: { status: "finished", since: iso(NOW), basis: [], endEvidence: null } },
        c: { ...trackedEvent({ id: "jma:typhoon:2631" }), tracking: undefined },
        d: { ...trackedEvent({ id: "jma:typhoon:2632" }), firstSeenAt: "いつか" },
        e: { ...trackedEvent({ id: "jma:typhoon:2633" }), lastBulletin: { ...good.lastBulletin, report: "../../etc/passwd" } },
        f: "壊れている",
      },
      streams: {},
    };
    const t = normalizeTracking(raw)!;
    assert.deepEqual(Object.keys(t.events), [good.id]);
    assert.deepEqual(t.events[good.id], good);
  });

  it("終了の根拠が無い ended は読まない（発表の停止を終わりにしない）", () => {
    assert.equal(normalizeTrackedEvent(trackedEvent({ tracking: { status: "ended", since: iso(NOW), basis: [], endEvidence: null } })), null);
    assert.equal(normalizeTrackedEvent(trackedEvent({ tracking: { status: "ended", since: iso(NOW), basis: [], endEvidence: "  " } })), null);
  });

  it("終わっていない記録に終了の根拠があっても持たない", () => {
    const e = normalizeTrackedEvent(trackedEvent({ tracking: { status: "paused", since: iso(NOW), basis: [], endEvidence: "何か" } }))!;
    assert.equal(e.tracking.endEvidence, null);
    assert.equal(e.tracking.status, "paused");
  });

  it("決まった値でない状態は、推測で埋めずに「分からない」側にする", () => {
    const raw = {
      ...trackedEvent(),
      phenomenon: { code: "SUPER", raw: "スーパー台風", observedAt: "x", report: "20261011064059_0_VPTW62_010000" },
      lastBulletin: { report: "20261011064059_0_VPTW62_010000", serial: 51, hasForecast: "no", hasWindPart: 0 },
      cadence: { recentAt: ["2026-10-11T03:40:32Z", "壊れた時刻", "2026-10-11T06:40:59Z", "2026-10-11T06:40:59Z"], expectedMs: -5, basis: "observed" },
      freshness: { level: "very-old", missedSlots: -3, referenceAt: null, basis: "x" },
      sourceActivity: { status: "dead", peers: [{ stream: "VPTW61" }, { stream: "VP TW 61", latestAt: iso(NOW) }], basis: [] },
    };
    const e = normalizeTrackedEvent(raw)!;
    assert.equal(e.phenomenon.code, "unknown");
    assert.equal(e.phenomenon.raw, "スーパー台風");
    assert.equal(e.phenomenon.observedAt, null);
    assert.equal(e.lastBulletin.serial, null);
    assert.equal(e.lastBulletin.hasForecast, null);
    assert.equal(e.lastBulletin.hasWindPart, null);
    // 見出しが無い（確かめられない）ときは null。"" は「空だと確かめた」ときだけ
    assert.equal(e.lastBulletin.headline, null);
    assert.equal(e.lastBulletin.reportAt, null);
    assert.deepEqual(e.cadence.recentAt, ["2026-10-11T06:40:59.000Z", "2026-10-11T03:40:32.000Z"]);
    assert.equal(e.cadence.expectedMs, null);
    assert.equal(e.cadence.basis, null);
    assert.equal(e.freshness.level, "unknown");
    // 読めない回数は 0 にしない
    assert.equal(e.freshness.missedSlots, null);
    assert.deepEqual(e.freshness.basis, []);
    assert.equal(e.sourceActivity.status, "unverified");
    assert.deepEqual(e.sourceActivity.peers, []);
    // 追跡の状態そのものは読めているので、記録は残る
    assert.equal(e.tracking.status, "paused");
  });

  it("件数の上限を守り、同じ ID が重なったら新しく判定したほうを残す", () => {
    const many = Array.from({ length: TRACKING_LIMITS.events + 5 }, (_, i) => trackedEvent({ id: `jma:typhoon:ev:TC26${String(i).padStart(2, "0")}`, lastEvaluatedAt: iso(NOW - i * 60_000) }));
    const t = normalizeTracking(tracking(many))!;
    assert.equal(Object.keys(t.events).length, TRACKING_LIMITS.events);
    assert.ok(t.events["jma:typhoon:ev:TC2600"]);
    assert.ok(!t.events[`jma:typhoon:ev:TC26${TRACKING_LIMITS.events + 4}`]);

    const older = trackedEvent({ lastEvaluatedAt: iso(NOW - 3600_000), tracking: { status: "tracking", since: iso(NOW - 3600_000), basis: [], endEvidence: null } });
    const newer = trackedEvent();
    const dup = normalizeTracking({ version: 1, events: { x: older, y: newer }, streams: {} })!;
    assert.equal(dup.events[newer.id].tracking.status, "paused");

    const long = normalizeTrackedEvent(trackedEvent({ history: Array.from({ length: 20 }, (_, i) => ({ report: `r${i}`, serial: String(i), reportAt: null, phenomenon: "TD" as const, pressureHpa: null })) }))!;
    assert.equal(long.history.length, TRACKING_LIMITS.history);
  });

  it("読めない系列（streams）は捨てる", () => {
    const t = normalizeTracking({
      version: 1,
      events: {},
      streams: { VPTW62: { lastTrackedId: "jma:typhoon:2628", latestAt: "2026-10-11T06:40:59Z" }, "VP TW": { lastTrackedId: "x", latestAt: iso(NOW) }, VPTW61: { lastTrackedId: "", latestAt: iso(NOW) }, VPTW60: { lastTrackedId: "y", latestAt: "x" } },
    })!;
    assert.deepEqual(t.streams, { VPTW62: { lastTrackedId: "jma:typhoon:2628", latestAt: "2026-10-11T06:40:59.000Z" } });
  });
});

/* ---------- レビューの指摘への対応 ---------- */

/** 要素を読んだ回数を数える配列（上限に達したら読むのをやめているかを、時間ではなく回数で確かめる） */
function countingArray<T>(n: number, make: (i: number) => T): { list: T[]; reads: () => number } {
  let reads = 0;
  const list = new Array<T>(n);
  for (let i = 0; i < n; i++)
    Object.defineProperty(list, i, {
      enumerable: true,
      get() {
        reads++;
        return make(i);
      },
    });
  return { list, reads: () => reads };
}

describe("大量の入力：上限に達したら読むのをやめる", () => {
  const N = 20_000;

  it("説明の一覧（basis）：上限 6 件で打ち切る。読めない値ばかりでも見る数に上限がある", () => {
    const ok = countingArray(N, (i) => `理由${i}`);
    const e = normalizeTrackedEvent(trackedEvent({ tracking: { status: "paused", since: iso(NOW), basis: ok.list, endEvidence: null } }))!;
    assert.equal(e.tracking.basis.length, TRACKING_LIMITS.basis);
    assert.equal(ok.reads(), TRACKING_LIMITS.basis);

    const bad = countingArray(N, () => 12345 as unknown as string);
    normalizeTrackedEvent(trackedEvent({ tracking: { status: "paused", since: iso(NOW), basis: bad.list, endEvidence: null } }));
    assert.ok(bad.reads() <= TRACKING_LIMITS.basis * 10, String(bad.reads()));
  });

  it("比べた系列（peers）・履歴・発表時刻・EventID：上限で打ち切る", () => {
    const peers = countingArray(N, (i) => ({ stream: `S${i}`, latestAt: iso(NOW) }));
    const history = countingArray(N, (i) => ({ report: `r${i}`, serial: null, reportAt: null, phenomenon: "TD", pressureHpa: null }));
    const recent = countingArray(N, (i) => iso(NOW - i * 60_000));
    const ids = countingArray(N, (i) => `TC${i}`);
    const e = normalizeTrackedEvent({
      ...trackedEvent(),
      sourceActivity: { status: "active", peers: peers.list, basis: [] },
      history: history.list,
      cadence: { recentAt: recent.list, expectedMs: 3 * 3600_000, basis: "observed" },
      seenEventIds: ids.list,
    })!;
    assert.equal(e.sourceActivity.peers.length, TRACKING_LIMITS.peers);
    assert.equal(peers.reads(), TRACKING_LIMITS.peers);
    assert.equal(e.history.length, TRACKING_LIMITS.history);
    assert.equal(history.reads(), TRACKING_LIMITS.history);
    assert.equal(e.cadence.recentAt.length, TRACKING_LIMITS.recentAt);
    assert.equal(recent.reads(), TRACKING_LIMITS.recentAt);
    assert.equal(e.seenEventIds.length, TRACKING_LIMITS.eventIds);
    assert.equal(ids.reads(), TRACKING_LIMITS.eventIds);
  });

  it("出来事の数：見る数に上限があり（上限 × 10）、残すのは上限件数", () => {
    let reads = 0;
    const events: Record<string, unknown> = {};
    for (let i = 0; i < 5000; i++)
      Object.defineProperty(events, `k${i}`, {
        enumerable: true,
        get() {
          reads++;
          return trackedEvent({ id: `jma:typhoon:ev:TC${i}`, lastEvaluatedAt: iso(NOW - i * 1000) });
        },
      });
    const t = normalizeTracking({ version: 1, events, streams: {} })!;
    assert.equal(Object.keys(t.events).length, TRACKING_LIMITS.events);
    assert.ok(reads <= TRACKING_LIMITS.events * 10, String(reads));
  });

  it("照合の相手（match.with）：上限 10 件で打ち切る", () => {
    const w = countingArray(N, (i) => `usgs:${i}`);
    const n = normalizeItem({ ...LEGACY_ITEM, match: { status: "pending", with: w.list, basis: [] } })!;
    assert.equal(n.match!.with.length, 10);
    assert.equal(w.reads(), 10);
  });

  it("これまでの項目（出典・理由・食い違い）も上限で打ち切り、結果は以前とまったく同じ", () => {
    const refs = countingArray(N, (i) => ({ url: `https://example.com/${i}`, name: `n${i}` }));
    const reasons = countingArray(N, (i) => `理由${i}`);
    const n = normalizeItem({ ...LEGACY_ITEM, corroboration: refs.list, reasons: reasons.list })!;
    assert.equal(n.corroboration.length, 10);
    assert.equal(refs.reads(), 10);
    assert.equal(n.reasons.length, 6);
    assert.equal(reasons.reads(), 6);
    // 以前の処理（全部を処理してから切る）と結果が同じ：空・文字でない値・重複が混ざった入力
    const mixed = ["", "  ", 5, "a", null, "a", { x: 1 }, "b\u0000c", "d", "e", "f", "g", "h"];
    const before = (v: unknown[], max: number, len: number) => v.map((x) => String(x ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, len)).filter(Boolean).slice(0, max);
    assert.deepEqual(normalizeItem({ ...LEGACY_ITEM, reasons: mixed, conflicts: mixed })!.reasons, before(mixed, 6, 120));
    assert.deepEqual(normalizeItem({ ...LEGACY_ITEM, reasons: mixed, conflicts: mixed })!.conflicts, before(mixed, 6, 160));
    const urls = [{ url: "https://a.example" }, { url: "javascript:x" }, { url: "https://a.example" }, { url: "https://b.example", name: "B" }];
    assert.deepEqual(normalizeItem({ ...LEGACY_ITEM, corroboration: urls })!.corroboration, [
      { url: "https://a.example/", name: "" },
      { url: "https://b.example/", name: "B" },
    ]);
  });

  it("重複のある配列：最初の 1 つを残し、順番を保つ", () => {
    const e = normalizeTrackedEvent(
      trackedEvent({
        tracking: { status: "paused", since: iso(NOW), basis: ["a", "a", "b", " a ", "c"], endEvidence: null },
        sourceActivity: { status: "active", peers: [{ stream: "VPTW61", latestAt: iso(NOW) }, { stream: "VPTW61", latestAt: iso(NOW - 1000) }, { stream: "VPTW60", latestAt: iso(NOW) }], basis: [] },
        cadence: { recentAt: [iso(NOW), iso(NOW), "2026-10-11T12:55:00+00:00"], expectedMs: null, basis: null },
      }),
    )!;
    assert.deepEqual(e.tracking.basis, ["a", "b", "c"]);
    assert.deepEqual(e.sourceActivity.peers, [{ stream: "VPTW61", latestAt: iso(NOW) }, { stream: "VPTW60", latestAt: iso(NOW) }]);
    assert.deepEqual(e.cadence.recentAt, [iso(NOW)]);
    const n = normalizeItem({ ...LEGACY_ITEM, match: { status: "pending", with: ["usgs:a", "usgs:b", "usgs:a"], basis: [] } })!;
    assert.deepEqual(n.match!.with, ["usgs:a", "usgs:b"]);
  });
});

describe("分からない値は null（空文字・0 にしない）", () => {
  const withBulletin = (lb: Record<string, unknown>) => normalizeTrackedEvent({ ...trackedEvent(), lastBulletin: { report: "20261011064059_0_VPTW62_010000", ...lb } })!;

  it("見出し：空だと確かめた（\"\"）と、確かめられない（null）を分ける", () => {
    assert.equal(withBulletin({ headline: "" }).lastBulletin.headline, "");
    assert.equal(withBulletin({}).lastBulletin.headline, null);
    assert.equal(withBulletin({ headline: 0 }).lastBulletin.headline, null);
    assert.equal(withBulletin({ headline: null }).lastBulletin.headline, null);
    assert.equal(withBulletin({ headline: "台風第28号は…" }).lastBulletin.headline, "台風第28号は…");
  });

  it("発表を逃した回数：読めなければ null。段階と食い違う記録は作らない", () => {
    const f = (level: unknown, missedSlots: unknown) => normalizeTrackedEvent({ ...trackedEvent(), freshness: { level, missedSlots, referenceAt: null, basis: [] } })!.freshness;
    const cases: [unknown, unknown, string, number | null][] = [
      ["fresh", 0, "fresh", 0],
      ["due", 1, "due", 1],
      ["overdue", 2, "overdue", 2],
      ["overdue", 3, "overdue", 3],
      ["overdue", "x", "overdue", null], // 段階は読めるが回数は分からない
      ["fresh", undefined, "fresh", null],
      ["overdue", 0, "unknown", null], // 食い違い：どちらも信じない
      ["due", 0, "unknown", null],
      ["fresh", 2, "unknown", null],
      ["unknown", 3, "unknown", null], // 判定できないなら回数も持たない
      ["overdue", -1, "overdue", null],
      ["overdue", 1.5, "overdue", null],
    ];
    for (const [level, missed, wantLevel, wantMissed] of cases) {
      const r = f(level, missed);
      assert.equal(r.level, wantLevel, `${level}/${missed}`);
      assert.equal(r.missedSlots, wantMissed, `${level}/${missed}`);
    }
  });
});

describe("オブジェクトのキーに使う名前（__proto__・constructor・prototype）", () => {
  const RESERVED = ["__proto__", "constructor", "prototype"];

  it("系列の名前として受け付けない。ふつうの系列名は受け付ける", () => {
    const raw = `{"version":1,"events":{},"streams":{${[...RESERVED, "VPTW62"].map((k) => `"${k}":{"lastTrackedId":"jma:typhoon:2628","latestAt":"2026-10-11T06:40:59Z"}`).join(",")}}}`;
    const t = normalizeTracking(JSON.parse(raw))!;
    assert.deepEqual(Object.keys(t.streams), ["VPTW62"]);
    assert.equal(Object.getPrototypeOf(t.streams), Object.prototype);
    assert.equal(({} as Record<string, unknown>).lastTrackedId, undefined);
    for (const k of RESERVED) {
      assert.equal(normalizeTrackedEvent(trackedEvent({ stream: k }))!.stream, null, k);
      const e = normalizeTrackedEvent(trackedEvent({ sourceActivity: { status: "active", peers: [{ stream: k, latestAt: iso(NOW) }], basis: [] } }))!;
      assert.deepEqual(e.sourceActivity.peers, [], k);
    }
  });

  it("出来事の ID・照合の相手・系列の最後の出来事としても受け付けない", () => {
    for (const k of RESERVED) {
      assert.equal(normalizeTrackedEvent(trackedEvent({ id: k })), null, k);
      const t = normalizeTracking({ version: 1, events: {}, streams: { VPTW62: { lastTrackedId: k, latestAt: iso(NOW) } } })!;
      assert.deepEqual(t.streams, {}, k);
      assert.equal("match" in normalizeItem({ ...LEGACY_ITEM, match: { status: "pending", with: [k], basis: [] } })!, false, k);
    }
  });
});

describe("ID は文字列だけ", () => {
  it("出来事の ID：数値・オブジェクト・配列・空・前後の空白・長すぎるものは受け付けない（切り詰めない）", () => {
    for (const bad of [12345, { a: 1 }, ["jma:typhoon:2628"], "", " jma:typhoon:2628", "jma:typhoon:2628\n", "x".repeat(161), null, true]) {
      assert.equal(normalizeTrackedEvent({ ...trackedEvent(), id: bad }), null, JSON.stringify(bad));
    }
    assert.equal(normalizeTrackedEvent(trackedEvent({ id: "x".repeat(160) }))!.id.length, 160);
    assert.equal(normalizeTrackedEvent(trackedEvent())!.id, "jma:typhoon:2628");
  });

  it("系列の最後の出来事（lastTrackedId）・EventID・照合の相手も同じ", () => {
    for (const bad of [123, {}, ["a"], ""]) {
      assert.deepEqual(normalizeTracking({ version: 1, events: {}, streams: { VPTW62: { lastTrackedId: bad, latestAt: iso(NOW) } } })!.streams, {}, JSON.stringify(bad));
    }
    assert.deepEqual(normalizeTrackedEvent({ ...trackedEvent(), seenEventIds: [123, {}, ["TC1"], "", "TC2635"] })!.seenEventIds, ["TC2635"]);
    const n = normalizeItem({ ...LEGACY_ITEM, match: { status: "pending", with: [5, {}, ["usgs:a"], "", "usgs:a"], basis: [] } })!;
    assert.deepEqual(n.match!.with, ["usgs:a"]);
  });
});

describe("照合の結果：confirmed は相手 1 件だけ", () => {
  const m = (match: unknown) => normalizeItem({ ...LEGACY_ITEM, match })!.match;

  it("confirmed：相手がちょうど 1 件のときだけ（同じ相手の重複は 1 件とみなす）", () => {
    assert.deepEqual(m({ status: "confirmed", with: ["usgs:a"], basis: ["時刻の差 3 秒"] }), { status: "confirmed", with: ["usgs:a"], basis: ["時刻の差 3 秒"] });
    assert.deepEqual(m({ status: "confirmed", with: ["usgs:a", "usgs:a"], basis: [] })?.with, ["usgs:a"]);
    for (const bad of [["usgs:a", "usgs:b"], [], [LEGACY_ITEM.id], ["usgs:a", LEGACY_ITEM.id], ["usgs:a", 5], Array.from({ length: 11 }, () => "usgs:a")]) {
      assert.equal(m({ status: "confirmed", with: bad, basis: [] }), undefined, JSON.stringify(bad));
    }
  });

  it("pending：候補は複数でよい（自分・読めない値・重複は除く）。候補が無ければ持たない", () => {
    assert.deepEqual(m({ status: "pending", with: ["usgs:a", "usgs:b", LEGACY_ITEM.id, 7, "usgs:a"], basis: [] })?.with, ["usgs:a", "usgs:b"]);
    assert.equal(m({ status: "pending", with: [LEGACY_ITEM.id, 7], basis: [] }), undefined);
  });
});

describe("追跡の記録の時刻は ISO 形式の文字列だけ", () => {
  it("ISO 形式の日時だけを受け付け、UTC にそろえる", () => {
    assert.equal(isoStrict("2026-10-11T06:40:59Z"), "2026-10-11T06:40:59.000Z");
    assert.equal(isoStrict("2026-10-11T15:45:00+09:00"), "2026-10-11T06:45:00.000Z");
    assert.equal(isoStrict("2026-10-11T06:40Z"), "2026-10-11T06:40:00.000Z");
    for (const bad of [0, 1760000000000, "1760000000000", "2026-10-11", "2026-10-11T06:40:59", "2026-02-30T00:00:00Z", "2026-13-01T00:00:00Z", "2026-10-11T25:00:00Z", "いつか", "", null, {}, ["2026-10-11T06:40:59Z"]]) {
      assert.equal(isoStrict(bad), null, JSON.stringify(bad));
    }
  });

  it("必須の時刻が読めなければ記録を捨て、任意の時刻は null にする", () => {
    assert.equal(normalizeTrackedEvent({ ...trackedEvent(), firstSeenAt: NOW }), null);
    assert.equal(normalizeTrackedEvent({ ...trackedEvent(), lastEvaluatedAt: String(NOW) }), null);
    assert.equal(normalizeTrackedEvent({ ...trackedEvent(), tracking: { status: "paused", since: "2026-10-11", basis: [], endEvidence: null } }), null);
    const e = normalizeTrackedEvent({ ...trackedEvent(), phenomenon: { ...trackedEvent().phenomenon, observedAt: NOW }, lastBulletin: { ...trackedEvent().lastBulletin, reportAt: "2026-10-11T06:45:00" } })!;
    assert.equal(e.phenomenon.observedAt, null);
    assert.equal(e.lastBulletin.reportAt, null);
    const t = normalizeTracking({ version: 1, events: {}, streams: { VPTW62: { lastTrackedId: "jma:typhoon:2628", latestAt: NOW } } })!;
    assert.deepEqual(t.streams, {});
  });

  it("これまでの項目（IntelItem）の時刻の扱いは変えない（USGS の数値の時刻はこれまでどおり）", () => {
    const n = normalizeItem({ ...LEGACY_ITEM, publishedAt: Date.UTC(2026, 9, 11, 6, 0, 0) })!;
    assert.equal(n.publishedAt, "2026-10-11T06:00:00.000Z");
  });
});

describe("知らない版（新しい版）の追跡の記録を消さない", () => {
  const V2 = { version: 2, events: { future: { anything: [1, 2, 3] } }, extra: "新しい項目" };
  const stateWith = (t: unknown) => JSON.stringify({ ...LEGACY_STATE, tracking: t });

  it("今の版としては読まず、預かって、書くときにそのまま書き戻す", () => {
    const s = parseState(stateWith(V2));
    assert.equal(s.tracking, undefined);
    assert.deepEqual(s.unsupportedTracking, { status: "kept", version: 2, value: V2 });
    assert.equal(trackingWritable(s), false);
    const written = JSON.parse(serializeState(s));
    assert.deepEqual(written.tracking, V2);
    assert.equal("unsupportedTracking" in written, false);
    assert.deepEqual(written.sources, LEGACY_STATE.sources);
  });

  it("実行の印を取る・結果を書く書き込みを通っても、消えない", async () => {
    const b = fakeBrain({ [INTEL_STATE_PATH]: stateWith(V2) });
    const run = (await acquireRun(b.io, NOW, "run-a"))!;
    assert.deepEqual(JSON.parse(b.files.get(INTEL_STATE_PATH)!.text).tracking, V2);
    assert.equal(await finishRun(b.io, run, (st) => recordSuccess(st, "jmatyphoon", 0, NOW), NOW + 1000), true);
    const file = JSON.parse(b.files.get(INTEL_STATE_PATH)!.text);
    assert.deepEqual(file.tracking, V2);
    assert.equal(file.lock, null);
    assert.equal(file.sources.jmatyphoon.lastCount, 0);
  });

  it("今の版の tracking があっても、知らない版を書き戻す（今の版では上書きしない）", () => {
    const s = { ...parseState(stateWith(V2)), tracking: tracking([trackedEvent()]) };
    assert.deepEqual(JSON.parse(serializeState(s)).tracking, V2);
  });

  it("将来の処理が finishRun の中で今の版の tracking を作っても、知らない版は消えない", async () => {
    const b = fakeBrain({ [INTEL_STATE_PATH]: stateWith(V2) });
    const run = (await acquireRun(b.io, NOW, "run-a"))!;
    assert.equal(trackingWritable(run.state), false);
    const wrote = await finishRun(b.io, run, (st) => ({ ...recordSuccess(st, "usgs", 4, NOW), tracking: tracking([trackedEvent()]) }), NOW + 1000);
    assert.equal(wrote, true);
    const file = JSON.parse(b.files.get(INTEL_STATE_PATH)!.text);
    assert.deepEqual(file.tracking, V2);
    // ほかの項目は、これまでどおり書かれる
    assert.equal(file.sources.usgs.lastCount, 4);
    assert.deepEqual(file.notified, LEGACY_STATE.notified);
    assert.equal(file.lock, null);
  });

  it("壊れた記録（版が無い・数でない・1 以下・整数でない）は、知らない版として扱わない", () => {
    for (const v of [undefined, "2", 1.5, 0, -1, null]) {
      const s = parseState(stateWith({ version: v, events: {} }));
      assert.equal(s.unsupportedTracking, undefined, String(v));
      assert.equal(trackingWritable(s), true, String(v));
      assert.equal("tracking" in JSON.parse(serializeState(s)), false, String(v));
    }
  });

  it("知らない版が無いふつうの状態は、これまでどおり書ける", () => {
    assert.equal(trackingWritable(emptyState()), true);
    const s: IntelState = { ...emptyState(), tracking: tracking([trackedEvent()]) };
    assert.equal(trackingWritable(s), true);
    assert.deepEqual(parseState(serializeState(s)), s);
  });
});

describe("知らない版の記録の大きさ・深さの上限（保てないときは state.json を書かない）", () => {
  const stateWith = (t: unknown) => JSON.stringify({ ...LEGACY_STATE, tracking: t });
  const blob = (n: number, ch = "x") => ({ version: 2, blob: ch.repeat(n) });

  it("大きさは state.json の中に書かれる形（字下げ 1・項目名を含む）で測る。上限ちょうどは預かり、1 バイト超えたら預からない", () => {
    const base = unsupportedTrackingBytes(blob(0));
    const exact = blob(MAX_UNSUPPORTED_TRACKING_BYTES - base);
    assert.equal(unsupportedTrackingBytes(exact), MAX_UNSUPPORTED_TRACKING_BYTES);
    assert.equal(holdUnsupportedTracking(exact).status, "kept");
    assert.equal(parseState(stateWith(exact)).unsupportedTracking?.status, "kept");
    const over = blob(MAX_UNSUPPORTED_TRACKING_BYTES - base + 1);
    assert.equal(unsupportedTrackingBytes(over), MAX_UNSUPPORTED_TRACKING_BYTES + 1);
    assert.deepEqual(holdUnsupportedTracking(over), { status: "rejected", version: 2, reason: "too-large" });
    assert.deepEqual(parseState(stateWith(over)).unsupportedTracking, { status: "rejected", version: 2, reason: "too-large" });
  });

  it("預かった記録は、実際に書いた state.json の中でも上限以内", () => {
    const base = unsupportedTrackingBytes(blob(0));
    const s = parseState(stateWith(blob(MAX_UNSUPPORTED_TRACKING_BYTES - base)));
    const withIt = Buffer.byteLength(serializeState(s), "utf8");
    const without = Buffer.byteLength(serializeState({ ...s, unsupportedTracking: undefined }), "utf8");
    // 増えた分 = 「,\n "tracking": …」の分。項目名・字下げを含めて測っているので、上限を超えない
    assert.ok(withIt - without <= MAX_UNSUPPORTED_TRACKING_BYTES, String(withIt - without));
  });

  it("字下げで大きくなる分も数える（字下げなしでは上限内でも、保存の形で超えれば預からない）", () => {
    const v = { version: 2, list: Array.from({ length: 20_000 }, (_, i) => [i]) };
    assert.ok(Buffer.byteLength(JSON.stringify(v), "utf8") < MAX_UNSUPPORTED_TRACKING_BYTES);
    assert.ok(unsupportedTrackingBytes(v) > MAX_UNSUPPORTED_TRACKING_BYTES);
    assert.deepEqual(holdUnsupportedTracking(v), { status: "rejected", version: 2, reason: "too-large" });
  });

  it("大きさは文字数ではなく UTF-8 のバイト数で測る", () => {
    const base = unsupportedTrackingBytes(blob(0));
    const chars = Math.floor((MAX_UNSUPPORTED_TRACKING_BYTES - base) / 3) + 1; // 「あ」は 3 バイト
    const v = blob(chars, "あ");
    assert.ok(JSON.stringify({ tracking: v }, null, 1).length <= MAX_UNSUPPORTED_TRACKING_BYTES); // 文字数なら上限内
    assert.deepEqual(holdUnsupportedTracking(v), { status: "rejected", version: 2, reason: "too-large" });
  });

  it(`深さ：${MAX_UNSUPPORTED_TRACKING_DEPTH} 段までは預かり、1 段超えたら預からない（tracking 自体が 1 段目）`, () => {
    const nest = (depth: number) => {
      let v: unknown = "x";
      for (let i = 1; i < depth; i++) v = i % 2 ? [v] : { k: v };
      return { version: 2, d: v };
    };
    assert.equal(holdUnsupportedTracking(nest(MAX_UNSUPPORTED_TRACKING_DEPTH)).status, "kept");
    assert.deepEqual(holdUnsupportedTracking(nest(MAX_UNSUPPORTED_TRACKING_DEPTH + 1)), { status: "rejected", version: 2, reason: "too-deep" });
    assert.equal(parseState(stateWith(nest(MAX_UNSUPPORTED_TRACKING_DEPTH))).unsupportedTracking?.status, "kept");
    assert.equal(inspectJsonValue({ a: [] }, 2), "ok");
    assert.equal(inspectJsonValue({ a: [[]] }, 2), "too-deep");
    assert.equal(inspectJsonValue("値そのものは段に数えない", 0), "ok");
  });

  it("とても深い入れ子（10 万段）でも例外を出さず、預からない。ほかの項目は読める", () => {
    const deep = `${"[".repeat(100_000)}0${"]".repeat(100_000)}`;
    const raw = `${JSON.stringify(LEGACY_STATE).slice(0, -1)},"tracking":{"version":2,"deep":${deep}}}`;
    const s = parseState(raw);
    assert.deepEqual(s.unsupportedTracking, { status: "rejected", version: 2, reason: "too-deep" });
    assert.deepEqual(s.sources, LEGACY_STATE.sources);
    assert.deepEqual(s.notified, LEGACY_STATE.notified);
    assert.deepEqual(s.daily, LEGACY_STATE.daily);
    // JavaScript で作ったとても深い値・自分自身を指す値も、再帰を使わないので止まらない
    let v: unknown = 0;
    for (let i = 0; i < 200_000; i++) v = [v];
    assert.equal(inspectJsonValue(v, MAX_UNSUPPORTED_TRACKING_DEPTH), "too-deep");
    const loop: Record<string, unknown> = { version: 2 };
    loop.self = loop;
    assert.deepEqual(holdUnsupportedTracking(loop), { status: "rejected", version: 2, reason: "too-deep" });
  });

  it("書き戻すと中身が変わる値（JSON では null になる Infinity など）・書けない値は預からない", () => {
    const fromFile = parseState(`${JSON.stringify(LEGACY_STATE).slice(0, -1)},"tracking":{"version":2,"n":1e400}}`);
    assert.deepEqual(fromFile.unsupportedTracking, { status: "rejected", version: 2, reason: "not-serializable" });
    const sparse = [1, , 3]; // eslint-disable-line no-sparse-arrays
    for (const bad of [NaN, Infinity, 10n, () => 1, undefined, Symbol("s"), new Date(0), sparse, { toJSON: () => "x" }]) {
      assert.deepEqual(holdUnsupportedTracking({ version: 2, bad }), { status: "rejected", version: 2, reason: "not-serializable" }, String(typeof bad));
    }
  });

  it("預かれないときは、空の tracking にせず state.json を書かない（ファイルはそのまま。印も取らない）", async () => {
    const original = stateWith(blob(MAX_UNSUPPORTED_TRACKING_BYTES));
    const s = parseState(original);
    assert.equal(trackingWritable(s), false);
    assert.throws(() => serializeState(s), TrackingHoldError);
    const b = fakeBrain({ [INTEL_STATE_PATH]: original });
    assert.equal(await acquireRun(b.io, NOW, "run-a"), null);
    assert.equal(b.files.get(INTEL_STATE_PATH)!.text, original);
    assert.equal(b.writes, 0);
  });

  it("実行の途中で預かれない記録に変わっても、finishRun は書かない（ファイルはそのまま）", async () => {
    const b = fakeBrain({ [INTEL_STATE_PATH]: JSON.stringify(LEGACY_STATE) });
    const run = (await acquireRun(b.io, NOW, "run-a"))!;
    // 別の（新しい版の）実行が、印はそのままに大きすぎる記録を書いた
    const replaced = JSON.stringify({ ...JSON.parse(b.files.get(INTEL_STATE_PATH)!.text), tracking: blob(MAX_UNSUPPORTED_TRACKING_BYTES) });
    b.rawWrite(INTEL_STATE_PATH, replaced);
    await assert.rejects(finishRun(b.io, run, (st) => recordSuccess(st, "usgs", 1, NOW), NOW + 1000), TrackingHoldError);
    assert.equal(b.files.get(INTEL_STATE_PATH)!.text, replaced);
  });
});

describe("壊れた tracking があっても、印・情報源の状態・通知の記録は消えない", () => {
  it("実行の印を取る・結果を書く書き込みを通しても残る", async () => {
    const b = fakeBrain({ [INTEL_STATE_PATH]: JSON.stringify({ ...LEGACY_STATE, tracking: { version: 1, events: "壊れている", streams: 5 } }) });
    const run = (await acquireRun(b.io, NOW, "run-a"))!;
    assert.ok(run);
    assert.equal(await finishRun(b.io, run, (st) => recordSuccess(st, "usgs", 2, NOW), NOW + 1000), true);
    const s = parseState(b.files.get(INTEL_STATE_PATH)!.text);
    assert.equal(s.lock, null);
    assert.equal(s.sources.jmatyphoon?.lastCount, 1);
    assert.equal(s.sources.usgs?.lastCount, 2);
    assert.deepEqual(s.notified, LEGACY_STATE.notified);
    assert.deepEqual(s.daily, LEGACY_STATE.daily);
  });
});
