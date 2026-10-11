/**
 * E.D.I.T.H. の情報収集（Phase 3 第 2 段階：気象庁の台風フィードの観測の記録）のテスト。
 *   - 取得できた・新しい電文が無い・取得や解析に失敗した、を分けて記録する（失敗を 0 件と取り違えない）
 *   - 時刻を 3 種類に分ける：取得した時刻・フィードの項目の時刻・電文の発表時刻（ReportDateTime）
 *   - 観測の記録は渡すだけ。取り込む項目・重複の除き方・例外はこれまでと同じ。終わりの判定はしない
 *   - 失敗の種類（SourceError.kind）。メッセージ・状態の番号・Retry-After はこれまでと同じ
 * 実際のネットワークは使わない（取得は差し替えた偽物）。
 *   npm test
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { FeedObservation, IntelItem } from "../src/integrations/intel/types";

const { fetchJmaTyphoon, JMA_EXTRA_LONG_URL } = await import("../src/integrations/intel/sources/jma");
const { getText, SourceError } = await import("../src/integrations/intel/http");
const { runIntel } = await import("../src/integrations/intel/collect");
const { INTEL_SETTINGS_PATH, INTEL_STATE_PATH, INTEL_ITEMS_PATH } = await import("../src/integrations/intel/brain-io");
const { renderSettingsNote, defaultSettings } = await import("../src/integrations/intel/settings");
const { parseState } = await import("../src/integrations/intel/state");
const { FEED_OBSERVATION_LIMITS } = await import("../src/integrations/intel/types");
const { fakeBrain } = await import("./intel-fake");

/** 10 月 11 日 12:55Z に取得した想定（時刻は実際の観測の並びにそろえる。中身はテスト用） */
const NOW = Date.UTC(2026, 9, 11, 12, 55, 0);
const DATA = "https://www.data.jma.go.jp/developer/xml/data";
const doc = (file: string) => `${DATA}/${file}.xml`;
const R61 = "20261011124037_0_VPTW61_010000";
const R62 = "20261011064059_0_VPTW62_010000";

/* ---------- 固定データ ---------- */

interface Entry {
  title?: string;
  updated: string;
  link: string;
}
function feedXml(entries: Entry[], extra = ""): string {
  return `<?xml version="1.0" encoding="utf-8"?><feed xmlns="http://www.w3.org/2005/Atom"><title>随時</title><updated>2026-10-11T12:45:02+09:00</updated>${entries
    .map((e) => `<entry><title>${e.title ?? "台風解析・予報情報（５日予報）（Ｈ３０）"}</title><id>urn:${e.link}</id><updated>${e.updated}</updated><author><name>気象庁</name></author><link type="application/xml" href="${e.link}"/><content type="text">【台風情報】</content></entry>`)
    .join("")}${extra}</feed>`;
}

/** 10 月 11 日の実際の並び（VPTW61 は 09:40Z・12:40Z、VPTW62 は 06:40Z が最後）＋台風以外のもっと新しい項目 */
function shapedFeed(): string {
  return feedXml([
    { updated: "2026-10-11T12:40:36Z", link: doc(R61) },
    { updated: "2026-10-11T09:40:15Z", link: doc("20261011094015_0_VPTW61_010000") },
    { updated: "2026-10-11T06:40:59Z", link: doc(R62) },
    { updated: "2026-10-11T03:40:32Z", link: doc("20261011034032_0_VPTW62_010000") },
    { title: "気象警報・注意報（Ｈ２７）", updated: "2026-10-11T12:43:05Z", link: doc("20261011124305_0_VPWW53_010000") },
  ]);
}

function typhoonXml(o: { number?: string; kana?: string; report?: string; cls?: string; status?: string; wind?: boolean } = {}): string {
  const wind = o.wind === false ? "" : `<Kind><Property><Type>風</Type><WindPart><jmx_eb:WindSpeed type="最大風速" unit="m/s" condition="中心付近">45</jmx_eb:WindSpeed></WindPart></Property></Kind>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<Report xmlns="http://xml.kishou.go.jp/jmaxml1/" xmlns:jmx_eb="http://xml.kishou.go.jp/jmaxml1/elementBasis1/">
<Control><Title>台風解析・予報情報（５日予報）（Ｈ３０）</Title><Status>${o.status ?? "通常"}</Status></Control>
<Head xmlns="http://xml.kishou.go.jp/jmaxml1/informationBasis1/"><Title>台風解析・予報情報</Title><ReportDateTime>${o.report ?? "2026-10-11T21:45:00+09:00"}</ReportDateTime><EventID>TC2634</EventID><InfoType>発表</InfoType><Headline><Text></Text></Headline></Head>
<Body xmlns="http://xml.kishou.go.jp/jmaxml1/body/meteorology1/"><MeteorologicalInfos type="台風情報"><MeteorologicalInfo><DateTime type="実況">2026-10-11T21:00:00+09:00</DateTime><Item><Kind><Property><Type>呼称</Type><TyphoonNamePart><Name>KOGUMA</Name><NameKana>${o.kana ?? "コグマ"}</NameKana><Number>${o.number ?? "2629"}</Number></TyphoonNamePart></Property></Kind><Kind><Property><Type>階級</Type><ClassPart><jmx_eb:TyphoonClass type="熱帯擾乱種類">${o.cls ?? "台風(TY)"}</jmx_eb:TyphoonClass></ClassPart></Property></Kind><Kind><Property><Type>中心</Type><CenterPart><jmx_eb:Coordinate type="中心位置（度）">+26.1+147.5/</jmx_eb:Coordinate><Location>小笠原近海</Location><jmx_eb:Pressure type="中心気圧" unit="hPa">950</jmx_eb:Pressure></CenterPart></Property></Kind>${wind}</Item></MeteorologicalInfo></MeteorologicalInfos></Body></Report>`;
}

type Handler = Response | (() => Response | Promise<Response>);
const xmlRes = (body: string) => () => new Response(body, { status: 200, headers: { "content-type": "application/xml" } });

/** 取得の偽物（決まった URL だけに答え、呼ばれた URL を記録する） */
function fakeFetch(routes: Record<string, Handler>) {
  const calls: string[] = [];
  const fn = async (url: string) => {
    calls.push(url);
    const h = routes[url];
    if (!h) return new Response("not found", { status: 404 });
    return typeof h === "function" ? h() : h;
  };
  return { fn, calls };
}

function ctx(over: Partial<{ knownReports: Set<string>; observe: (o: FeedObservation) => void }> = {}) {
  return { now: NOW, known: new Set<string>(), knownReports: new Set<string>(), lastSuccessAt: null, ...over };
}

/** 観測の記録を集める */
function collector() {
  const seen: FeedObservation[] = [];
  return { seen, observe: (o: FeedObservation) => void seen.push(o) };
}

const fullRoutes = (): Record<string, Handler> => ({
  [JMA_EXTRA_LONG_URL]: xmlRes(shapedFeed()),
  [doc(R61)]: xmlRes(typhoonXml()),
  [doc(R62)]: xmlRes(typhoonXml({ number: "2628", kana: "ノロ", cls: "熱帯低気圧(TD)", report: "2026-10-11T15:45:00+09:00", wind: false })),
});

/* ---------- テスト ---------- */

describe("観測の記録：取得できた回", () => {
  it("1. 新しい電文を読んだ：系列ごとに new-read・項目の id・電文の発表時刻", async () => {
    const c = collector();
    const items = await fetchJmaTyphoon({ ...ctx({ observe: c.observe }), fetchImpl: fakeFetch(fullRoutes()).fn });
    assert.equal(c.seen.length, 1);
    const o = c.seen[0];
    assert.equal(o.status, "ok");
    assert.equal(o.failure, null);
    assert.equal(o.entryCount, 5);
    assert.equal(o.typhoonEntryCount, 4);
    assert.deepEqual(
      o.streams.map((s) => [s.stream, s.bulletin, s.itemId, s.reportAt]),
      [
        ["VPTW61", "new-read", "jma:typhoon:2629", "2026-10-11T12:45:00.000Z"],
        ["VPTW62", "new-read", "jma:typhoon:2628", "2026-10-11T06:45:00.000Z"],
      ],
    );
    assert.deepEqual(items.map((i) => i.id).sort(), ["jma:typhoon:2628", "jma:typhoon:2629"]);
  });

  it("2. 既知の電文しかない：取得は成功・新しい電文なし（already-known）。電文は取りに行かない", async () => {
    const c = collector();
    const f = fakeFetch(fullRoutes());
    const items = await fetchJmaTyphoon({ ...ctx({ knownReports: new Set([R61, R62]), observe: c.observe }), fetchImpl: f.fn });
    assert.deepEqual(items, []);
    assert.deepEqual(f.calls, [JMA_EXTRA_LONG_URL]);
    const o = c.seen[0];
    assert.equal(o.status, "ok");
    assert.equal(o.entryCount, 5); // 0 件ではない
    assert.deepEqual(o.streams.map((s) => [s.stream, s.bulletin, s.itemId, s.reportAt, s.latestAt]), [
      ["VPTW61", "already-known", null, null, "2026-10-11T12:40:36.000Z"],
      ["VPTW62", "already-known", null, null, "2026-10-11T06:40:59.000Z"],
    ]);
  });

  it("8. 電文 1 通の取得失敗・解析失敗・訓練電文：ほかの台風は取り込み、系列ごとに理由を記録する", async () => {
    const c = collector();
    const routes = fullRoutes();
    routes[doc(R61)] = () => new Response("busy", { status: 503 });
    const items = await fetchJmaTyphoon({ ...ctx({ observe: c.observe }), fetchImpl: fakeFetch(routes).fn });
    assert.deepEqual(items.map((i) => i.id), ["jma:typhoon:2628"]);
    const s61 = c.seen[0].streams.find((s) => s.stream === "VPTW61")!;
    assert.equal(s61.bulletin, "doc-fetch-failed");
    assert.deepEqual(s61.docError, { kind: "http", httpStatus: 503 });
    assert.equal(s61.reportAt, null);
    assert.equal(s61.latestAt, "2026-10-11T12:40:36.000Z"); // フィードの時刻は分かっている

    for (const [body, want] of [
      ["<html>maintenance</html>", "doc-unparseable"],
      [typhoonXml({ status: "訓練" }), "doc-not-normal"],
    ] as const) {
      const c2 = collector();
      const r = fullRoutes();
      r[doc(R61)] = xmlRes(body);
      const got = await fetchJmaTyphoon({ ...ctx({ observe: c2.observe }), fetchImpl: fakeFetch(r).fn });
      assert.deepEqual(got.map((i) => i.id), ["jma:typhoon:2628"]);
      const s = c2.seen[0].streams.find((x) => x.stream === "VPTW61")!;
      assert.equal(s.bulletin, want);
      assert.equal(s.itemId, null);
      assert.equal(s.docError, null);
    }
  });

  it("9. フィード全体の最新の時刻と、系列ごとの最新の時刻は別", async () => {
    const c = collector();
    await fetchJmaTyphoon({ ...ctx({ knownReports: new Set([R61, R62]), observe: c.observe }), fetchImpl: fakeFetch(fullRoutes()).fn });
    const o = c.seen[0];
    // フィードは 12:43Z の警報の項目まで新しい。VPTW62 は 06:40Z のまま（ここでは判定しない）
    assert.equal(o.feedNewestEntryAt, "2026-10-11T12:43:05.000Z");
    assert.equal(o.streams.find((s) => s.stream === "VPTW62")!.latestAt, "2026-10-11T06:40:59.000Z");
    assert.deepEqual(o.streams.find((s) => s.stream === "VPTW62")!.recentAt, ["2026-10-11T06:40:59.000Z", "2026-10-11T03:40:32.000Z"]);
    assert.equal(o.feedLastModified, null); // いまは取得しない（推測しない）
  });

  it("10. 取得した時刻・フィードの項目の時刻・電文の発表時刻（ReportDateTime）を取り違えない", async () => {
    const c = collector();
    const items = await fetchJmaTyphoon({ ...ctx({ observe: c.observe }), fetchImpl: fakeFetch(fullRoutes()).fn });
    const o = c.seen[0];
    const s62 = o.streams.find((s) => s.stream === "VPTW62")!;
    assert.equal(o.fetchedAt, "2026-10-11T12:55:00.000Z"); // こちらが取得した時刻
    assert.equal(s62.latestAt, "2026-10-11T06:40:59.000Z"); // フィードの項目の時刻
    assert.equal(s62.reportAt, "2026-10-11T06:45:00.000Z"); // 電文の発表時刻（15:45+09:00）
    assert.notEqual(s62.latestAt, s62.reportAt);
    // 項目の時刻はこれまでどおり（発表時刻＝updatedAt、取得した時刻＝fetchedAt）
    const it62 = items.find((i) => i.id === "jma:typhoon:2628")!;
    assert.equal(it62.updatedAt, s62.reportAt);
    assert.equal(it62.fetchedAt, o.fetchedAt);
  });

  it("11. 同じフィードを取り直しても重複しない（2 回目は既知・項目は増えない）", async () => {
    const c = collector();
    const first = await fetchJmaTyphoon({ ...ctx({ observe: c.observe }), fetchImpl: fakeFetch(fullRoutes()).fn });
    const known = new Set(first.map((i) => String(i.facts.report)));
    const f2 = fakeFetch(fullRoutes());
    const second = await fetchJmaTyphoon({ ...ctx({ knownReports: known, observe: c.observe }), fetchImpl: f2.fn });
    assert.deepEqual(second, []);
    assert.equal(f2.calls.length, 1);
    assert.deepEqual(c.seen[1].streams.map((s) => s.bulletin), ["already-known", "already-known"]);
    // 系列の時刻は 1 回目と同じ（同じフィードだから）
    assert.deepEqual(
      c.seen[1].streams.map((s) => [s.latestAt, s.latestReport, s.recentAt]),
      c.seen[0].streams.map((s) => [s.latestAt, s.latestReport, s.recentAt]),
    );
  });

  it("系列の名前は VPTW60〜65 だけ。直近の時刻は上限まで・新しい順。読めない時刻は使わない", async () => {
    const entries: Entry[] = [
      ...Array.from({ length: 12 }, (_, i) => ({ updated: new Date(NOW - i * 3 * 3600_000).toISOString(), link: doc(`r${i}_0_VPTW60_010000`) })),
      { updated: "2026-10-11T12:00:00Z", link: doc("x_0_VPTW66_010000") }, // 範囲外の番号
      { updated: "いつか", link: doc("y_0_VPTW63_010000") }, // 読めない時刻
    ];
    const c = collector();
    await fetchJmaTyphoon({ ...ctx({ knownReports: new Set(["r0_0_VPTW60_010000", "y_0_VPTW63_010000"]), observe: c.observe }), fetchImpl: fakeFetch({ [JMA_EXTRA_LONG_URL]: xmlRes(feedXml(entries)) }).fn });
    const o = c.seen[0];
    assert.deepEqual(o.streams.map((s) => s.stream), ["VPTW60", "VPTW63"]);
    const s60 = o.streams[0];
    assert.equal(s60.recentAt.length, FEED_OBSERVATION_LIMITS.recentAt);
    assert.equal(s60.recentAt[0], new Date(NOW).toISOString());
    assert.deepEqual([...s60.recentAt].sort().reverse(), s60.recentAt);
    const s63 = o.streams[1];
    assert.equal(s63.latestAt, null);
    assert.deepEqual(s63.recentAt, []);
  });
});

describe("観測の記録：取得・解析に失敗した回（0 件・系列なしと取り違えない）", () => {
  async function failing(handler: Handler | ((url: string) => Promise<Response>)): Promise<{ o: FeedObservation; err: unknown }> {
    const c = collector();
    const fn = typeof handler === "function" && handler.length === 1 ? (handler as (url: string) => Promise<Response>) : fakeFetch({ [JMA_EXTRA_LONG_URL]: handler as Handler }).fn;
    let err: unknown = null;
    await fetchJmaTyphoon({ ...ctx({ observe: c.observe }), fetchImpl: fn }).catch((e) => (err = e));
    assert.equal(c.seen.length, 1);
    return { o: c.seen[0], err };
  }
  const assertUnknown = (o: FeedObservation) => {
    assert.equal(o.entryCount, null);
    assert.equal(o.typhoonEntryCount, null);
    assert.equal(o.feedNewestEntryAt, null);
    assert.deepEqual(o.streams, []);
  };

  it("3. HTTP 429・503：fetch-failed（http）。例外・状態の番号・Retry-After はこれまでどおり", async () => {
    const r429 = await failing(() => new Response("slow down", { status: 429, headers: { "retry-after": "120" } }));
    assert.equal(r429.o.status, "fetch-failed");
    assert.deepEqual(r429.o.failure, { kind: "http", httpStatus: 429, message: "アクセスの制限" });
    assertUnknown(r429.o);
    assert.ok(r429.err instanceof SourceError);
    assert.equal((r429.err as InstanceType<typeof SourceError>).status, 429);
    assert.equal((r429.err as InstanceType<typeof SourceError>).retryAfterMs, 120_000);
    assert.equal((r429.err as InstanceType<typeof SourceError>).kind, "http");

    const r503 = await failing(() => new Response("down", { status: 503 }));
    assert.deepEqual(r503.o.failure, { kind: "http", httpStatus: 503, message: "HTTP 503" });
    assert.equal((r503.err as Error).message, "HTTP 503");
  });

  it("4. 時間切れ：fetch-failed（timeout）", async () => {
    const { o, err } = await failing(async (_url: string) => {
      throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
    });
    assert.equal(o.status, "fetch-failed");
    assert.deepEqual(o.failure, { kind: "timeout", httpStatus: null, message: "時間切れ（10 秒）" });
    assertUnknown(o);
    assert.equal((err as Error).message, "時間切れ（10 秒）");
  });

  it("5. 通信エラー：fetch-failed（network）", async () => {
    const { o } = await failing(async (_url: string) => {
      throw new TypeError("fetch failed");
    });
    assert.deepEqual(o.failure, { kind: "network", httpStatus: null, message: "接続できませんでした" });
    assertUnknown(o);
  });

  it("6. 大きすぎる・ほかの取得先への転送：too-large・redirect", async () => {
    const big = await failing(() => new Response("x", { status: 200, headers: { "content-length": String(9_000_000) } }));
    assert.deepEqual(big.o.failure, { kind: "too-large", httpStatus: null, message: "データが大きすぎます" });
    const moved = await failing(() => {
      const res = new Response(shapedFeed(), { status: 200 });
      Object.defineProperty(res, "url", { value: "https://evil.example/feed.xml" });
      return res;
    });
    assert.deepEqual(moved.o.failure, { kind: "redirect", httpStatus: null, message: "許可していない取得先へ転送されました" });
    assertUnknown(moved.o);
  });

  it("7. フィード全体が読めない（XML の形が違う・空）：unparseable。例外はこれまでどおり", async () => {
    for (const body of ["<html>maintenance</html>", ""]) {
      const { o, err } = await failing(xmlRes(body));
      assert.equal(o.status, "unparseable");
      assert.equal(o.failure?.kind, "other");
      assert.equal(o.failure?.message, "気象庁のフィードの形が正しくありません");
      assertUnknown(o);
      assert.equal((err as Error).message, "気象庁のフィードの形が正しくありません");
    }
  });

  it("12. 失敗しても・LOW・TD・風が無い・系列が消えても、終わりを推測しない（終わりの項目そのものが無い）", async () => {
    const keys = ["source", "fetchedAt", "status", "failure", "feedLastModified", "feedNewestEntryAt", "entryCount", "typhoonEntryCount", "streams"];
    const streamKeys = ["stream", "latestAt", "latestReport", "recentAt", "bulletin", "itemId", "reportAt", "docError"];
    const failed = await failing(() => new Response("down", { status: 503 }));
    assert.deepEqual(Object.keys(failed.o).sort(), [...keys].sort());

    const routes = fullRoutes();
    routes[doc(R61)] = xmlRes(typhoonXml({ cls: "温帯低気圧(LOW)", wind: false }));
    const c = collector();
    await fetchJmaTyphoon({ ...ctx({ observe: c.observe }), fetchImpl: fakeFetch(routes).fn });
    const o = c.seen[0];
    assert.deepEqual(Object.keys(o).sort(), [...keys].sort());
    for (const s of o.streams) {
      assert.deepEqual(Object.keys(s).sort(), [...streamKeys].sort());
      assert.equal(s.bulletin, "new-read"); // LOW・TD・風なしでも、ただ「読んだ」だけ
    }
    // 系列が無いフィード（台風の項目なし）も「読めた・0 系列」。終わりとは書かない
    const c2 = collector();
    await fetchJmaTyphoon({ ...ctx({ observe: c2.observe }), fetchImpl: fakeFetch({ [JMA_EXTRA_LONG_URL]: xmlRes(feedXml([])) }).fn });
    assert.equal(c2.seen[0].status, "ok");
    assert.equal(c2.seen[0].entryCount, 0);
    assert.deepEqual(c2.seen[0].streams, []);
    assert.doesNotMatch(JSON.stringify([...c.seen, ...c2.seen, failed.o]), /ended|終了|dissipat/i);
  });
});

describe("観測の記録を渡しても、これまでの取り込みは変わらない", () => {
  const strip = (items: IntelItem[]) => items.map((i) => ({ ...i }));

  it("13. 観測の受け口が無いとき：これまでどおり（同じ項目・同じ取得・例外も同じ）", async () => {
    const f1 = fakeFetch(fullRoutes());
    const without = await fetchJmaTyphoon({ ...ctx(), fetchImpl: f1.fn });
    const c = collector();
    const f2 = fakeFetch(fullRoutes());
    const withObs = await fetchJmaTyphoon({ ...ctx({ observe: c.observe }), fetchImpl: f2.fn });
    assert.deepEqual(strip(without), strip(withObs));
    assert.deepEqual(f1.calls, f2.calls);
    await assert.rejects(fetchJmaTyphoon({ ...ctx(), fetchImpl: fakeFetch({ [JMA_EXTRA_LONG_URL]: () => new Response("down", { status: 503 }) }).fn }), /HTTP 503/);
  });

  it("14. 観測の受け口が失敗しても（例外・失敗する Promise・中身の書き換え）、取り込みは続く", async () => {
    const expected = strip(await fetchJmaTyphoon({ ...ctx(), fetchImpl: fakeFetch(fullRoutes()).fn }));
    const throwing = () => {
      throw new Error("受け口の故障");
    };
    const rejecting = (() => Promise.reject(new Error("非同期の故障"))) as unknown as (o: FeedObservation) => void;
    const mutating = (o: FeedObservation) => {
      o.streams.length = 0;
      (o as { status: string }).status = "書き換え";
    };
    for (const observe of [throwing, rejecting, mutating]) {
      const got = await fetchJmaTyphoon({ ...ctx({ observe }), fetchImpl: fakeFetch(fullRoutes()).fn });
      assert.deepEqual(strip(got), expected);
    }
    // 失敗の回も、受け口の故障ではなく、元の取得の失敗が伝わる
    await assert.rejects(fetchJmaTyphoon({ ...ctx({ observe: throwing }), fetchImpl: fakeFetch({ [JMA_EXTRA_LONG_URL]: () => new Response("x", { status: 503 }) }).fn }), /HTTP 503/);
  });

  it("15. 1 回分の実行（runIntel）：これまでどおり保存し、状態ファイルに観測・追跡の記録は書かない", async () => {
    const s = defaultSettings();
    for (const k of Object.keys(s.sources) as (keyof typeof s.sources)[]) s.sources[k] = k === "jmatyphoon";
    const b = fakeBrain({ [INTEL_SETTINGS_PATH]: renderSettingsNote(s) });
    const f = fakeFetch(fullRoutes());
    const r = await runIntel({ io: b.io, env: { EDITH_INTEL: "on" }, now: () => NOW, fetchImpl: f.fn });
    assert.equal(r.status, "done");
    assert.deepEqual(r.sources.jmatyphoon, { ok: true, count: 2 });
    const state = parseState(b.files.get(INTEL_STATE_PATH)!.text);
    assert.equal(state.tracking, undefined);
    assert.equal(state.unsupportedTracking, undefined);
    assert.doesNotMatch(b.files.get(INTEL_STATE_PATH)!.text, /streams|fetchedAt|observ/);
    assert.ok(b.files.get(INTEL_ITEMS_PATH));
  });

  it("失敗の種類（kind）は、指定が無ければ状態の番号の有無で決まる（これまでの使い方のまま）", async () => {
    assert.equal(new SourceError("x", 500).kind, "http");
    assert.equal(new SourceError("x").kind, "other");
    const e = new SourceError("x", undefined, 1000, "timeout");
    assert.equal(e.kind, "timeout");
    assert.equal(e.retryAfterMs, 1000);
    await assert.rejects(getText("https://evil.example/x", { hosts: ["www.data.jma.go.jp"] }), (err: unknown) => err instanceof SourceError && err.kind === "other");
  });
});

/* ---------- 16. 書き込み・通知にたどり着けない ---------- */

const ROOT = process.cwd();
function resolveImport(from: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = join(ROOT, "src", spec.slice(2));
  else if (spec.startsWith(".")) base = resolve(dirname(from), spec);
  else return null;
  for (const c of [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts")]) if (existsSync(c) && /\.(ts|tsx)$/.test(c)) return c;
  throw new Error(`${from} の ${spec} が見つかりません`);
}
function importGraph(entry: string): string[] {
  const files = new Set<string>();
  const stack = [entry];
  while (stack.length) {
    const f = stack.pop()!;
    if (files.has(f)) continue;
    files.add(f);
    for (const m of readFileSync(f, "utf8").matchAll(/(?:^|\n)\s*(?:import|export)\s[^;]*?from\s*["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g)) {
      const next = resolveImport(f, m[1] ?? m[2]);
      if (next) stack.push(next);
    }
  }
  return [...files].map((f) => f.slice(ROOT.length + 1)).sort();
}

describe("16. 観測の記録を作る処理から、書き込み・通知にたどり着けない", () => {
  it("気象庁の取得（観測の記録を含む）が読み込むのは、取得・解析・型だけ", () => {
    const files = importGraph(join(ROOT, "src/integrations/intel/sources/jma.ts"));
    const forbidden = /brain-io|github-brain|\/store\.ts$|\/state\.ts$|\/settings\.ts$|collect|push|notify|gmail|calendar|spotify|memory\/|app\/api/;
    for (const f of files) assert.doesNotMatch(f, forbidden, `${f} を読み込んでいる`);
    assert.deepEqual(files, [
      "src/integrations/intel/http.ts",
      "src/integrations/intel/normalize.ts",
      "src/integrations/intel/sources.ts",
      "src/integrations/intel/sources/common.ts",
      "src/integrations/intel/sources/jma.ts",
      "src/integrations/intel/types.ts",
    ]);
    for (const f of files) assert.doesNotMatch(readFileSync(join(ROOT, f), "utf8"), /node:fs|node:child_process|writeFile|appendFile/, f);
  });
});
