/**
 * E.D.I.T.H. Phase 3-1：観測の記録の保存（.friday/intel/observations.json）。
 * 通信はしない（脳は偽物。観測の記録は固定データ）。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { FeedObservation as Obs, IntelObservationStore } from "../src/integrations/intel/types";
import type { IntelBrainIO as BrainIO } from "../src/integrations/intel/brain-io";
const store = await import("../src/integrations/intel/observation-store");
const { INTEL_OBSERVATIONS_PATH } = await import("../src/integrations/intel/brain-io");
const { fakeBrain } = await import("./intel-fake");

const { OBSERVATION_STORE_LIMITS: LIMITS, ObservationStoreError } = store;
const PATH = INTEL_OBSERVATIONS_PATH;
const T0 = Date.parse("2026-10-01T00:00:00.000Z");
const HOUR = 3_600_000;
const at = (h: number) => new Date(T0 + h * HOUR).toISOString();

/** 気象庁の台風の観測（取得できた回）。h は取得の時刻（T0 から何時間後か） */
function okObs(h: number, streams = 2, recent = 2): Obs {
  return {
    source: "jmatyphoon",
    fetchedAt: at(h),
    status: "ok",
    failure: null,
    feedLastModified: null,
    feedNewestEntryAt: at(h - 0.2),
    entryCount: 40,
    typhoonEntryCount: 2 * streams,
    streams: Array.from({ length: streams }, (_, i) => ({
      stream: `VPTW6${i}`,
      latestAt: at(h - 1),
      latestReport: `20261001000000_0_VPTW6${i}_010000`,
      recentAt: Array.from({ length: recent }, (_, k) => at(h - 1 - 3 * k)),
      bulletin: i === 0 ? ("new-read" as const) : ("already-known" as const),
      itemId: i === 0 ? "jma:typhoon:2629" : null,
      reportAt: i === 0 ? at(h - 0.9) : null,
      docError: null,
    })),
  };
}

/** 別の情報源（系列の名前は気象庁の形でなくてよい）として同じ観測を作る */
function asUsgs(o: Obs): Obs {
  return { ...o, source: "usgs", streams: o.streams.map((st) => ({ ...st, stream: st.stream.replace("VPTW", "S") })) };
}

function failedObs(h: number): Obs {
  return {
    source: "jmatyphoon",
    fetchedAt: at(h),
    status: "fetch-failed",
    failure: { kind: "http", httpStatus: 503, message: "HTTP 503" },
    feedLastModified: null,
    feedNewestEntryAt: null,
    entryCount: null,
    typhoonEntryCount: null,
    streams: [],
  };
}

/** n 件の観測を順に足した記録（純粋な関数だけで作る） */
function built(n: number, make: (h: number) => Obs = (h) => okObs(h)): IntelObservationStore {
  let s = store.emptyObservationStore();
  for (let i = 0; i < n; i++) s = store.appendObservation(s, make(i)).store;
  return s;
}

/** エラーの code（と path）を確かめる */
function isErr(code: string, path?: string | RegExp) {
  return (err: unknown) => {
    assert.ok(err instanceof ObservationStoreError, String(err));
    assert.equal(err.code, code, err.message);
    if (typeof path === "string") assert.equal(err.path, path);
    else if (path) assert.match(err.path ?? "", path);
    return true;
  };
}

/** 書き込みが起きず、ファイルが元のままか */
async function refusesToWrite(initial: string, code: string, path?: string | RegExp) {
  const b = fakeBrain({ [PATH]: initial });
  const r = await store.recordObservation(b.io, okObs(500));
  assert.equal(r.ok, false);
  if (!r.ok) isErr(code, path)(r.error);
  assert.equal(b.writes, 0);
  assert.equal(b.files.get(PATH)!.text, initial);
  const read = await store.readObservationStore(b.io);
  assert.equal(read.ok, false);
  if (!read.ok) assert.equal(read.error.code, code);
}

describe("新しい記録の作成と、ふつうの読み書き", () => {
  it("ファイルが無い（null）ときだけ、新しく作る", async () => {
    const b = fakeBrain();
    const r0 = await store.readObservationStore(b.io);
    assert.deepEqual(r0, { ok: true, exists: false, store: { version: 1, sources: {} } });
    assert.equal(b.writes, 0); // 読むだけでは作らない
    const r = await store.recordObservation(b.io, okObs(0));
    assert.equal(r.ok, true);
    if (r.ok) assert.deepEqual({ created: r.created, changed: r.changed, dropped: r.dropped }, { created: true, changed: true, dropped: 0 });
    assert.equal(b.writes, 1);
    const saved = JSON.parse(b.files.get(PATH)!.text);
    assert.equal(saved.version, 1);
    assert.deepEqual(saved.sources.jmatyphoon.latest, okObs(0));
    assert.equal(saved.sources.jmatyphoon.history.length, 1);
  });

  it("保存して読み直すと同じ。足すたびに直近を置き換え、履歴は新しい順", async () => {
    const b = fakeBrain();
    for (const h of [0, 1, 2]) assert.equal((await store.recordObservation(b.io, h === 1 ? failedObs(h) : okObs(h))).ok, true);
    const r = await store.readObservationStore(b.io);
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.exists, true);
    const rec = r.store.sources.jmatyphoon!;
    assert.deepEqual(rec.latest, okObs(2));
    assert.deepEqual(rec.history.map((e) => e.fetchedAt), [at(2), at(1), at(0)]);
    assert.deepEqual(rec.history[1], { fetchedAt: at(1), status: "fetch-failed", feedNewestEntryAt: null, failure: { kind: "http", httpStatus: 503 }, streams: [] });
    // 書いた文字列を読み直して書くと、まったく同じ
    assert.equal(store.serializeObservationStore(r.store), b.files.get(PATH)!.text);
  });

  it("履歴は最小限（直近の時刻の一覧・項目の id・失敗のメッセージ・件数・URL を持たない）", () => {
    const s = built(3, (h) => (h === 1 ? failedObs(h) : okObs(h)));
    const text = JSON.stringify(s.sources.jmatyphoon!.history);
    assert.doesNotMatch(text, /recentAt|itemId|message|entryCount|docError|https?:/);
    assert.deepEqual(Object.keys(s.sources.jmatyphoon!.history[0]), ["fetchedAt", "status", "feedNewestEntryAt", "failure", "streams"]);
    assert.deepEqual(Object.keys(s.sources.jmatyphoon!.history[0].streams[0]), ["stream", "latestAt", "latestReport", "bulletin", "reportAt"]);
  });

  it("同じ観測をもう一度足しても書かない。古い・同じ時刻で中身が違う観測は受け付けない", async () => {
    const b = fakeBrain();
    await store.recordObservation(b.io, okObs(5));
    const text = b.files.get(PATH)!.text;
    const again = await store.recordObservation(b.io, okObs(5));
    assert.equal(again.ok, true);
    if (again.ok) assert.equal(again.changed, false);
    assert.equal(b.writes, 1);
    for (const o of [okObs(4), { ...okObs(5), entryCount: 41 }]) {
      const r = await store.recordObservation(b.io, o);
      assert.equal(r.ok, false);
      if (!r.ok) isErr("out-of-order")(r.error);
    }
    assert.equal(b.writes, 1);
    assert.equal(b.files.get(PATH)!.text, text);
  });

  it("形の違う観測は足さない（どこが違うか分かる）", async () => {
    const b = fakeBrain();
    const bad = [
      [{ ...okObs(0), status: "gone" }, "observation.status"],
      [{ ...okObs(0), fetchedAt: "2026-10-01 00:00" }, "observation.fetchedAt"],
      [{ ...okObs(0), entryCount: 0, typhoonEntryCount: null }, "observation.entryCount"],
      [{ ...failedObs(0), entryCount: 0 }, "observation.entryCount"], // 失敗の回に 0 件（分からないは null）
      [{ ...okObs(0), streams: [{ ...okObs(0).streams[0], stream: "VPWW53" }] }, "observation.streams[0].stream"],
      [{ ...okObs(0), streams: [okObs(0).streams[0], okObs(0).streams[0]] }, "observation.streams[1].stream"],
      [{ ...okObs(0), streams: [{ ...okObs(0).streams[1], reportAt: at(0) }] }, "observation.streams[0].reportAt"], // 読んでいないのに発表時刻
      [{ ...okObs(0), extra: 1 }, "observation.<不正な項目名>"],
      [{ ...failedObs(0), failure: { kind: "timeout", httpStatus: 503, message: "x" } }, "observation.failure.httpStatus"],
    ] as const;
    for (const [o, path] of bad) {
      const r = await store.recordObservation(b.io, o as unknown as Obs);
      assert.equal(r.ok, false, path);
      if (!r.ok) isErr("invalid-observation", path)(r.error);
    }
    assert.equal(b.writes, 0);
    assert.equal(b.files.has(PATH), false);
  });

  it("脳につながっていなければ、読まない・書かない", async () => {
    const io: BrainIO = { configured: () => false, read: async () => assert.fail("読んではいけない"), update: async () => assert.fail("書いてはいけない") };
    const r = await store.readObservationStore(io);
    const w = await store.recordObservation(io, okObs(0));
    assert.equal(r.ok || w.ok, false);
    if (!r.ok) assert.equal(r.error.code, "not-configured");
  });
});

describe("壊れたファイル・知らない版は、上書きしない", () => {
  const valid = () => store.serializeObservationStore(built(3));

  it("中身が空（\"\"・空白だけ）なら、空の記録として扱わず、書かない", async () => {
    await refusesToWrite("", "empty");
    await refusesToWrite("  \n ", "empty");
  });

  it("JSON でなければ書かない", async () => {
    await refusesToWrite("{", "invalid-json");
    await refusesToWrite(valid().slice(0, -5), "invalid-json");
  });

  it("形が違えば書かない（どこが違うか path で分かる）", async () => {
    const v = JSON.parse(valid());
    await refusesToWrite("[]", "invalid-structure", "$");
    await refusesToWrite(JSON.stringify({ ...v, extra: true }), "invalid-structure", "<不正な項目名>");
    await refusesToWrite(JSON.stringify({ version: 1 }), "invalid-structure", "sources");
    await refusesToWrite(JSON.stringify({ version: 1, sources: { nope: v.sources.jmatyphoon } }), "invalid-structure", "sources.<不正な情報源名>");
    await refusesToWrite(JSON.stringify({ version: 1, sources: { usgs: v.sources.jmatyphoon } }), "invalid-structure", "sources.usgs.latest.source");
    await refusesToWrite(JSON.stringify({ version: 1, sources: JSON.parse('{"__proto__":{}}') }), "invalid-structure", "sources.<不正な情報源名>");
  });

  it("版が違えば書かない（無い・文字・0・小数）", async () => {
    const v = JSON.parse(valid());
    for (const version of [undefined, "1", 0, 1.5, null]) await refusesToWrite(JSON.stringify({ ...v, version }), "invalid-structure", "version");
  });

  it("知らない版（新しい版）は、中身に関係なく読まず・変えず・上書きしない", async () => {
    for (const body of [{ version: 2, sources: {} }, { version: 7, whatever: [1, 2, 3], sources: "形が違っても" }]) await refusesToWrite(JSON.stringify(body), "unsupported-version", "version");
    // 中身が深くても、知らない版として扱う（深さで先に止めない）
    let deep: unknown = 1;
    for (let i = 0; i < 50; i++) deep = [deep];
    await refusesToWrite(JSON.stringify({ version: 3, deep }), "unsupported-version");
  });

  it("履歴の 1 件が読めなければ、削らずに書かない（どの項目か分かる）", async () => {
    const v = JSON.parse(valid());
    const h = v.sources.jmatyphoon.history;
    const cases: [(x: typeof v) => void, string][] = [
      [(x) => (x.sources.jmatyphoon.history[2].streams[0].bulletin = "gone"), "sources.jmatyphoon.history[2].streams[0].bulletin"],
      [(x) => (x.sources.jmatyphoon.history[1].fetchedAt = "昨日"), "sources.jmatyphoon.history[1].fetchedAt"],
      [(x) => (x.sources.jmatyphoon.history[1].recentAt = []), "sources.jmatyphoon.history[1].<不正な項目名>"], // 持たない項目（名前は出さない）
      [(x) => (x.sources.jmatyphoon.history[1].streams[0].latestReport = "https://example.com/x"), "sources.jmatyphoon.history[1].streams[0].latestReport"],
      [(x) => (x.sources.jmatyphoon.history = [h[0], h[2], h[1]]), "sources.jmatyphoon.history[2].fetchedAt"], // 新しい順でない
      [(x) => (x.sources.jmatyphoon.history = [h[1], h[2]]), "sources.jmatyphoon.history[0]"], // 先頭が直近と違う
      [(x) => (x.sources.jmatyphoon.history = []), "sources.jmatyphoon.history"],
      [(x) => (x.sources.jmatyphoon.latest.failure = { kind: "http", httpStatus: 503, message: "x" }), "sources.jmatyphoon.latest.failure"],
    ];
    for (const [edit, path] of cases) {
      const x = structuredClone(v);
      edit(x);
      await refusesToWrite(JSON.stringify(x), "invalid-structure", path);
    }
  });

  it("入れ子が深すぎる・大きすぎるものは、読まずに書かない", async () => {
    const v = JSON.parse(valid());
    let deep: unknown = 1;
    for (let i = 0; i < LIMITS.depth; i++) deep = [deep];
    v.sources.jmatyphoon.latest.streams[0].recentAt = deep;
    await refusesToWrite(JSON.stringify(v), "too-deep");
    await refusesToWrite(" ".repeat(LIMITS.readBytes + 1), "empty");
    await refusesToWrite(`{"version":1,"sources":{}}${" ".repeat(LIMITS.readBytes)}`, "too-large");
  });

  it("別の実行が書き込みの直前に壊れた中身を書いても、それを上書きしない", async () => {
    const b = fakeBrain({ [PATH]: valid() });
    b.interrupt(() => b.rawWrite(PATH, "{壊れた"));
    const r = await store.recordObservation(b.io, okObs(10));
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.error.code, "invalid-json");
    assert.equal(b.files.get(PATH)!.text, "{壊れた");
    assert.equal(b.writes, 0);
  });
});

describe("エラーに、ファイルにある名前・値・長い文字・制御文字を出さない（M1）", () => {
  const { OBSERVATION_STORE_ERROR_LIMITS: ELIM } = store;
  const valid = () => JSON.parse(store.serializeObservationStore(built(2)));

  /** 書かずに止まり、エラーが上限内・制御文字なし・秘密の文字を含まないか */
  async function safeError(initial: string, code: string, path: string, secrets: string[]) {
    const b = fakeBrain({ [PATH]: initial });
    const r = await store.recordObservation(b.io, okObs(500));
    const read = await store.readObservationStore(b.io);
    assert.equal(b.writes, 0);
    assert.equal(b.files.get(PATH)!.text, initial);
    for (const res of [r, read]) {
      assert.equal(res.ok, false);
      if (res.ok) continue;
      const e = res.error;
      assert.equal(e.code, code);
      assert.equal(e.path, path);
      assert.ok(e.message.length <= ELIM.message, `${e.message.length}`);
      assert.ok((e.path ?? "").length <= ELIM.path);
      assert.doesNotMatch(e.message, /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/);
      for (const s of secrets) {
        assert.ok(!e.message.includes(s), "メッセージに名前が出ている");
        assert.ok(!(e.path ?? "").includes(s), "path に名前が出ている");
      }
    }
  }

  it("とても長い知らない項目名（10 万字）は、固定の文言に置き換え、メッセージは上限内", async () => {
    const long = "x".repeat(100_000);
    const v = valid();
    v[long] = 1;
    await safeError(JSON.stringify(v), "invalid-structure", "<不正な項目名>", [long.slice(0, 50)]);
    const w = valid();
    w.sources.jmatyphoon.latest.streams[0][long] = 1;
    await safeError(JSON.stringify(w), "invalid-structure", "sources.jmatyphoon.latest.streams[0].<不正な項目名>", [long.slice(0, 50)]);
  });

  it("改行・制御文字・秘密らしい文字を含む名前（項目名・情報源名）も出さない（ログの偽装をさせない）", async () => {
    const token = "ghp_" + "A1b2C3d4E5".repeat(4).slice(0, 36);
    const forged = `x\n[INFO] 偽のログ\r\u0000\u2028${token}\u202e`;
    const v = valid();
    v[forged] = 1;
    await safeError(JSON.stringify(v), "invalid-structure", "<不正な項目名>", [token, "偽のログ"]);
    const w = valid();
    w.sources = { [forged]: w.sources.jmatyphoon };
    await safeError(JSON.stringify(w), "invalid-structure", "sources.<不正な情報源名>", [token, "偽のログ"]);
    // 形の整った名前でも、知らない名前は出さない（トークンの形をした項目名など）
    const x = valid();
    x[token] = 1;
    await safeError(JSON.stringify(x), "invalid-structure", "<不正な項目名>", [token]);
  });

  it("追加しようとした観測の知らない項目名も出さない", () => {
    const token = "ghp_" + "Z".repeat(36);
    assert.throws(
      () => store.appendObservation(store.emptyObservationStore(), { ...okObs(0), [`${token}\n`]: 1 }),
      (err: unknown) => {
        isErr("invalid-observation", "observation.<不正な項目名>")(err);
        assert.ok(!(err as Error).message.includes(token));
        return true;
      },
    );
  });

  it("エラーの path・詳細・メッセージは、直接作っても上限内で、制御文字を含まない", () => {
    const e = new ObservationStoreError("invalid-structure", `a\n${"p".repeat(10_000)}`, `d\u0000\u2028${"d".repeat(10_000)}`);
    assert.ok(e.path!.length <= store.OBSERVATION_STORE_ERROR_LIMITS.path);
    assert.ok(e.message.length <= store.OBSERVATION_STORE_ERROR_LIMITS.message);
    assert.doesNotMatch(`${e.path}${e.message}`, /[\u0000-\u001f\u2028\u2029]/);
  });
});

describe("JSON にすると値が変わる・消えるものは、写す前に止める（L1）", () => {
  /** 書かずに止まるか（以前は null に変わったり、項目が消えたりして通るものがあった） */
  async function rejected(o: unknown) {
    const b = fakeBrain();
    assert.throws(() => store.appendObservation(store.emptyObservationStore(), o), isErr("invalid-observation", "observation"));
    const r = await store.recordObservation(b.io, o as Obs);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.error.code, "invalid-observation");
    assert.equal(b.writes, 0);
    assert.equal(b.files.has(PATH), false);
  }

  it("NaN・Infinity・-Infinity（以前は null として通る組み合わせがあった）", async () => {
    await rejected({ ...failedObs(0), entryCount: NaN }); // 失敗の回の件数：null に変わると通っていた
    await rejected({ ...failedObs(0), failure: { kind: "timeout", httpStatus: Infinity, message: "時間切れ" } }); // 同上
    await rejected({ ...okObs(0), entryCount: -Infinity });
    await rejected({ ...okObs(0), streams: [{ ...okObs(0).streams[0], docError: null, latestAt: NaN }] });
  });

  it("undefined・関数・Date・BigInt・穴のある配列・toJSON を持つ値は、黙って変えず・消さずに止める", async () => {
    await rejected({ ...okObs(0), feedLastModified: undefined }); // 項目が消えるはずだった
    await rejected({ ...okObs(0), extra: () => 1 }); // 関数（項目が消えるはずだった）
    await rejected({ ...okObs(0), fetchedAt: new Date(T0) }); // Date（文字になって通るはずだった）
    await rejected({ ...okObs(0), entryCount: BigInt(1) });
    const holes: unknown[] = [];
    holes[1] = okObs(0).streams[0];
    await rejected({ ...okObs(0), streams: holes });
    await rejected({ ...okObs(0), streams: [{ ...okObs(0).streams[0], toJSON: () => ({}) }] });
    await rejected(undefined);
  });

  it("保存する記録そのものに NaN などがあれば、書く前に止める（not-serializable）", () => {
    const s = built(2);
    (s.sources.jmatyphoon!.latest as { entryCount: number | null }).entryCount = NaN;
    assert.throws(() => store.serializeObservationStore(s), isErr("not-serializable", "$"));
    assert.throws(() => store.appendObservation(s, okObs(5)), isErr("not-serializable", "$"));
    const t = built(2);
    (t.sources.jmatyphoon!.history[0] as { failure: unknown }).failure = undefined;
    assert.throws(() => store.serializeObservationStore(t), isErr("not-serializable", "$"));
  });

  it("ふつうの観測・記録（null・空の配列・Object.create(null) で作った値）は、これまでどおり通る", () => {
    const o = Object.assign(Object.create(null), okObs(0)) as Obs;
    const r = store.appendObservation(store.emptyObservationStore(), o);
    assert.equal(r.changed, true);
    assert.equal(r.store.sources.jmatyphoon!.history.length, 1);
    assert.equal(store.appendObservation(r.store, failedObs(1)).store.sources.jmatyphoon!.history.length, 2);
  });
});

describe("件数・大きさの上限（消してよいのは古い履歴だけ）", () => {
  it("168 件まではそのまま。169 件目を足すと、一番古い 1 件だけを捨てる", () => {
    const s167 = built(167);
    const r168 = store.appendObservation(s167, okObs(167));
    assert.equal(r168.store.sources.jmatyphoon!.history.length, 168);
    assert.equal(r168.dropped, 0);
    const r169 = store.appendObservation(r168.store, okObs(168));
    const h = r169.store.sources.jmatyphoon!.history;
    assert.equal(h.length, 168);
    assert.equal(r169.dropped, 1);
    assert.equal(h[0].fetchedAt, at(168));
    assert.equal(h[167].fetchedAt, at(1)); // 一番古い at(0) だけが消えた
    assert.deepEqual(r169.store.sources.jmatyphoon!.latest, okObs(168));
    // 元の記録は変わらない（純粋な関数）
    assert.equal(r168.store.sources.jmatyphoon!.history.length, 168);
  });

  it("保存されている履歴が 169 件なら、形が違うものとして書かない（勝手に削らない）", async () => {
    const v = JSON.parse(store.serializeObservationStore(built(168)));
    v.sources.jmatyphoon.history.push({ ...v.sources.jmatyphoon.history[167], fetchedAt: at(-1) });
    await refusesToWrite(JSON.stringify(v), "invalid-structure", "sources.jmatyphoon.history");
  });

  it("読み込み：200,000 バイトちょうどは読み、1 バイト超えたら書かない", async () => {
    const text = store.serializeObservationStore(built(5));
    const exact = text + " ".repeat(LIMITS.bytes - Buffer.byteLength(text));
    assert.equal(Buffer.byteLength(exact), LIMITS.bytes);
    assert.equal(store.parseObservationStore(exact).exists, true);
    await refusesToWrite(exact + " ", "too-large");
  });

  it("書く前に実際の大きさを測り、200,000 バイトを超える記録は書かない", () => {
    const big = built(168, (h) => okObs(h, 6));
    const usgs = { ...big.sources.jmatyphoon! };
    // 別の情報源にも同じだけの履歴（系列名は気象庁の形でなくてよい）
    const rename = <T extends { stream: string }>(s: T): T => ({ ...s, stream: s.stream.replace("VPTW", "S") });
    const other = {
      latest: { ...usgs.latest, source: "usgs" as const, streams: usgs.latest.streams.map(rename) },
      history: usgs.history.map((e) => ({ ...e, streams: e.streams.map(rename) })),
    };
    const tooBig: IntelObservationStore = { version: 1, sources: { ...big.sources, usgs: other } };
    assert.ok(Buffer.byteLength(JSON.stringify(tooBig)) > LIMITS.bytes);
    assert.throws(() => store.serializeObservationStore(tooBig), isErr("too-large"));
  });

  it("気象庁の台風だけなら、上限いっぱい（系列 6・時刻 8 件・168 件）でも 200KB に収まる", () => {
    const s = built(168, (h) => okObs(h, 6, 8));
    assert.equal(s.sources.jmatyphoon!.history.length, 168);
    assert.ok(Buffer.byteLength(store.serializeObservationStore(s)) <= LIMITS.bytes);
  });

  it("大きさが上限を超える分は、すべての情報源の中で一番古い履歴から捨てる（直近の観測は残す）", () => {
    // 2 つの情報源に、それぞれ上限いっぱいの観測を交互に足す（合わせると 200KB を超える）
    let s = store.emptyObservationStore();
    let dropped = 0;
    for (let h = 0; h < 168; h++) {
      for (const o of [okObs(h, 6, 8), asUsgs(okObs(h + 0.5, 6, 8))]) {
        const r = store.appendObservation(s, o);
        s = r.store;
        dropped += r.dropped;
      }
    }
    assert.ok(dropped > 0, "古い履歴が捨てられている");
    assert.ok(Buffer.byteLength(store.serializeObservationStore(s)) <= LIMITS.bytes);
    const jma = s.sources.jmatyphoon!;
    const usgs = s.sources.usgs!;
    assert.deepEqual(jma.latest, okObs(167, 6, 8));
    assert.deepEqual(usgs.latest, asUsgs(okObs(167.5, 6, 8)));
    // どちらも新しい側の連続した履歴が残り、捨てたのは全体の中で古いものから
    jma.history.forEach((e, i) => assert.equal(e.fetchedAt, at(167 - i)));
    usgs.history.forEach((e, i) => assert.equal(e.fetchedAt, at(167.5 - i)));
    const oldestKept = Math.min(Date.parse(jma.history.at(-1)!.fetchedAt), Date.parse(usgs.history.at(-1)!.fetchedAt));
    assert.ok(Math.abs(Date.parse(jma.history.at(-1)!.fetchedAt) - Date.parse(usgs.history.at(-1)!.fetchedAt)) <= HOUR);
    assert.equal(jma.history.length + usgs.history.length + dropped, 168 * 2);
    assert.ok(oldestKept > T0);
  });
});

describe("失敗したときに、もとのデータを壊さない", () => {
  it("書き込みに失敗しても、ファイルは元のまま（ok:false）", async () => {
    const initial = store.serializeObservationStore(built(2));
    const b = fakeBrain({ [PATH]: initial });
    b.failWrites(() => new Error("GitHub 503"));
    const r = await store.recordObservation(b.io, okObs(3));
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.error.code, "write-failed");
    assert.equal(b.files.get(PATH)!.text, initial);
  });

  it("読み込みに失敗したら、ファイルが無いとはみなさない（作らない・書かない）", async () => {
    let updates = 0;
    const io: BrainIO = {
      configured: () => true,
      read: async () => {
        throw new Error("GitHub 500");
      },
      // GitHub の updateNote と同じく、最新を読めなければ書き換えの関数を呼ばずに失敗する
      update: async () => {
        updates++;
        throw new Error("GitHub 500");
      },
    };
    const r = await store.readObservationStore(io);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.error.code, "read-failed");
    const w = await store.recordObservation(io, okObs(0));
    assert.equal(w.ok, false);
    assert.equal(updates, 1);
  });

  it("書き換えの関数が例外を出したら、書き込みは起きない（壊れた中身・知らない版のとき）", async () => {
    for (const initial of ["", "{", '{"version":9}']) {
      const b = fakeBrain({ [PATH]: initial });
      const r = await store.recordObservation(b.io, okObs(0));
      assert.equal(r.ok, false);
      assert.equal(b.writes, 0);
      assert.equal(b.files.get(PATH)!.text, initial);
    }
  });
});

describe("つながっているのは収集の 1 回分（collect.ts）だけ（Phase 3-2）", () => {
  const ROOT = resolve(dirname(new URL(import.meta.url).pathname), "..");
  const src = (f: string) => readFileSync(join(ROOT, "src/integrations/intel", f), "utf8");

  it("取得（sources）・状態（state）・情報の保存（store）からは読み込まれていない。collect.ts は保存の関数だけを使う", () => {
    for (const f of ["state.ts", "store.ts", "sources/jma.ts", "sources/common.ts"]) assert.doesNotMatch(src(f), /observation-store/, f);
    const uses = [...src("collect.ts").matchAll(/import \{([^}]*)\} from "\.\/observation-store"/g)].map((m) => m[1].trim());
    assert.deepEqual(uses, ["recordObservation, type ObservationStoreErrorCode"]);
  });

  it("保存の仕組みが読み込むのは、脳の読み書きの口・正規化・情報源の一覧・状態の形の確かめ・型だけ", () => {
    const imports = [...src("observation-store.ts").matchAll(/from "([^"]+)"/g)].map((m) => m[1]).sort();
    assert.deepEqual(imports, ["./brain-io", "./normalize", "./sources", "./state", "./types"]);
    assert.doesNotMatch(src("observation-store.ts"), /fetch\(|node:fs|notify|push/);
  });
});
