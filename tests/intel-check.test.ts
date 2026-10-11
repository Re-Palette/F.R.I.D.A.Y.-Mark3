/**
 * E.D.I.T.H. の「実データ確認」（scripts/intel-check.ts と .github/workflows/edith-intel-check.yml）のテスト。
 *   - スクリプトから、保存・状態・通知・脳（GitHub）・外部操作の処理にたどり着けない（読み込みを全部たどって確かめる）
 *   - 取得と解析の結果だけを出す。見本は最大 2 件、位置は小数 1 桁、全文は出さない
 *   - 429 でも再試行しない。1 つ失敗してもほかは確かめる
 *   - 取った文字が GitHub Actions の命令として解釈されない
 *   - ワークフローは手動実行だけ・読み取り権限だけ・同時実行なし・秘密の値を使わない
 * 注意：テスト用のデータは公式文書の形をもとに作ったもの（本物の写しではない）。
 *   npm test
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const { runChecks, render, checkUsgs, checkJmaTyphoon, windDiagnostics, typhoonStructure } = await import("../scripts/intel-check");
const { USGS_URL } = await import("../src/integrations/intel/sources/usgs");
const { NHC_URL } = await import("../src/integrations/intel/sources/nhc");
const { JMA_EQVOL_URL, JMA_EQVOL_LONG_URL, JMA_EXTRA_LONG_URL } = await import("../src/integrations/intel/sources/jma");

const ROOT = process.cwd();

/* ---------- 読み込みをたどる ---------- */

function resolveImport(from: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = join(ROOT, "src", spec.slice(2));
  else if (spec.startsWith(".")) base = resolve(dirname(from), spec);
  else return null; // node: の標準機能など
  for (const c of [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts")]) if (existsSync(c) && /\.(ts|tsx)$/.test(c)) return c;
  throw new Error(`${from} の ${spec} が見つかりません`);
}

function importGraph(entry: string): { files: Set<string>; external: Set<string> } {
  const files = new Set<string>();
  const external = new Set<string>();
  const stack = [entry];
  while (stack.length) {
    const f = stack.pop()!;
    if (files.has(f)) continue;
    files.add(f);
    const src = readFileSync(f, "utf8");
    for (const m of src.matchAll(/(?:^|\n)\s*(?:import|export)\s[^;]*?from\s*["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g)) {
      const spec = m[1] ?? m[2];
      const next = resolveImport(f, spec);
      if (next) stack.push(next);
      else external.add(spec);
    }
  }
  return { files, external };
}

describe("確認用スクリプトから書き込み・通知にたどり着けない", () => {
  it("読み込むのは取得・解析・型だけ。脳・保存・状態・通知・外部操作のファイルは読み込まない", () => {
    const { files, external } = importGraph(join(ROOT, "scripts/intel-check.ts"));
    const rel = [...files].map((f) => f.slice(ROOT.length + 1)).sort();
    const forbidden = /brain-io|github-brain|\/store\.ts$|\/state\.ts$|\/settings\.ts$|collect|push|notify|gmail|calendar|spotify|memory\/|app\/api/;
    for (const f of rel) assert.doesNotMatch(f, forbidden, `${f} を読み込んでいる`);
    assert.deepEqual(rel, [
      "scripts/intel-check.ts",
      "src/integrations/intel/http.ts",
      "src/integrations/intel/normalize.ts",
      "src/integrations/intel/sources.ts",
      "src/integrations/intel/sources/common.ts",
      "src/integrations/intel/sources/jma.ts",
      "src/integrations/intel/sources/nhc.ts",
      "src/integrations/intel/sources/usgs.ts",
      "src/integrations/intel/types.ts",
    ]);
    // 外部のパッケージは使わない（Node.js の標準機能だけ）
    for (const e of external) assert.match(e, /^node:/);
    // ファイルの書き込み・子プロセスなども使わない
    for (const f of files) assert.doesNotMatch(readFileSync(f, "utf8"), /node:fs|node:child_process|writeFile|appendFile|GITHUB_STEP_SUMMARY|GITHUB_OUTPUT/, f);
  });
});

/* ---------- テスト用のデータ ---------- */

const NOW = Date.now();
const DATA = "https://www.data.jma.go.jp/developer/xml/data";
const usgs = {
  type: "FeatureCollection",
  metadata: { generated: NOW, count: 3 },
  features: [1, 2, 3].map((k) => ({
    type: "Feature",
    id: `us${k}`,
    geometry: { coordinates: [142.4567, 38.3456, 10] },
    properties: { mag: 4.5 + k, place: `place ${k}`, time: NOW - k * 60_000, updated: NOW, url: `https://earthquake.usgs.gov/earthquakes/eventpage/us${k}`, tsunami: 0, alert: null, status: "reviewed", sig: 300, title: `M ${4.5 + k}` },
  })),
};
const atom = (entries: { title: string; file: string; content?: string }[]) =>
  `<feed xmlns="http://www.w3.org/2005/Atom"><updated>2026-10-11T00:00:00Z</updated>${entries
    .map((e) => `<entry><title>${e.title}</title><id>urn:${e.file}</id><updated>2026-10-11T00:00:00Z</updated><author><name>気象庁</name></author><link type="application/xml" href="${DATA}/${e.file}.xml"/><content type="text">${e.content ?? ""}</content></entry>`)
    .join("")}</feed>`;
const quakeXml = `<Report><Control><Title>震源・震度に関する情報</Title><Status>通常</Status></Control><Head><Title>震源・震度情報</Title><ReportDateTime>2026-10-11T09:02:00+09:00</ReportDateTime><EventID>20261011085800</EventID><InfoType>発表</InfoType><Headline><Text>地震がありました。</Text></Headline></Head><Body><Earthquake><OriginTime>2026-10-11T08:58:00+09:00</OriginTime><Hypocenter><Area><Name>茨城県南部</Name><jmx_eb:Coordinate>+36.12+140.07-50000/</jmx_eb:Coordinate></Area></Hypocenter><jmx_eb:Magnitude>4.6</jmx_eb:Magnitude></Earthquake><Intensity><Observation><MaxInt>4</MaxInt></Observation></Intensity><Comments><ForecastComment><Text>この地震による津波の心配はありません。</Text></ForecastComment></Comments></Body></Report>`;

const typhoonXml = `<Report><Control><Title>台風解析・予報情報（５日予報）（Ｈ３０）</Title><Status>通常</Status></Control><Head><Title>台風解析・予報情報</Title><ReportDateTime>2026-10-11T16:00:00+09:00</ReportDateTime><EventID>TC2621</EventID><InfoType>発表</InfoType><Headline><Text></Text></Headline></Head><Body><MeteorologicalInfos type="台風情報"><MeteorologicalInfo><DateTime type="実況">2026-10-11T15:00:00+09:00</DateTime><Item><Kind><Property><Type>呼称</Type><TyphoonNamePart><Name>NAME</Name><NameKana>ネーム</NameKana><Number>2621</Number></TyphoonNamePart></Property></Kind><Kind><Property><Type>階級</Type><ClassPart><jmx_eb:TyphoonClass type="熱帯擾乱種類">台風（TS）</jmx_eb:TyphoonClass><jmx_eb:AreaClass type="大きさ階級"></jmx_eb:AreaClass><jmx_eb:IntensityClass type="強さ階級"></jmx_eb:IntensityClass></ClassPart></Property></Kind><Kind><Property><Type>中心</Type><CenterPart><jmx_eb:Coordinate type="中心位置（度）">+20.12+130.98/</jmx_eb:Coordinate><Location>フィリピンの東</Location><jmx_eb:Pressure type="中心気圧" unit="hPa">990</jmx_eb:Pressure></CenterPart></Property></Kind><Kind><Property><Type>風</Type><WindPart><jmx_eb:WindSpeed type="最大風速" unit="ノット" condition="中心付近">45</jmx_eb:WindSpeed><jmx_eb:WindSpeed type="最大風速" unit="m/s" condition="中心付近">23</jmx_eb:WindSpeed></WindPart></Property></Kind></Item></MeteorologicalInfo></MeteorologicalInfos></Body></Report>`;

function fakeFetch(routes: Record<string, () => Response>) {
  const calls: string[] = [];
  const fn = async (url: string) => {
    calls.push(String(url));
    const r = routes[String(url)];
    return r ? r() : new Response("nf", { status: 404 });
  };
  return { fn: fn as unknown as typeof fetch, calls };
}
const ok = (body: string, type = "application/json") => () => new Response(body, { status: 200, headers: { "content-type": type, "last-modified": "Sun, 11 Oct 2026 00:00:00 GMT" } });

const allRoutes = () => ({
  [USGS_URL]: ok(JSON.stringify(usgs)),
  [NHC_URL]: ok(JSON.stringify({ activeStorms: [] })),
  [JMA_EQVOL_URL]: ok(atom([]), "application/atom+xml"),
  [JMA_EQVOL_LONG_URL]: ok(atom([{ title: "震源・震度に関する情報", file: "q1_VXSE53" }]), "application/atom+xml"),
  [`${DATA}/q1_VXSE53.xml`]: ok(quakeXml, "application/xml"),
  [JMA_EXTRA_LONG_URL]: ok(atom([{ title: "台風解析・予報情報（５日予報）（Ｈ３０）", file: "20261011070122_0_VPTW61_010000" }]), "application/atom+xml"),
  [`${DATA}/20261011070122_0_VPTW61_010000.xml`]: ok(typhoonXml, "application/xml"),
});

describe("実データ確認の結果", () => {
  it("情報源ごとに、状態・形式・項目・時刻・件数・見本を出す（見本は最大 2 件、位置は小数 1 桁）", async () => {
    const f = fakeFetch(allRoutes());
    const reports = await runChecks(f.fn);
    assert.deepEqual(reports.map((r) => [r.source, r.ok]), [
      ["USGS 地震", true],
      ["NOAA NHC 熱帯低気圧", true],
      ["気象庁 地震・津波", true],
      ["気象庁 台風", true],
    ]);
    const [u, n, q, t] = reports;
    assert.equal(u.raw, 3);
    assert.equal(u.parsed, 3);
    assert.equal(u.samples.length, 2);
    assert.deepEqual((u.samples[0] as { place: unknown }).place, { name: "place 3", lat: 38.3, lon: 142.5 });
    assert.equal(u.http[0].status, 200);
    assert.ok(u.http[0].lastModified);
    assert.deepEqual(u.mismatches, []);
    assert.ok(u.times.generated);
    assert.equal(n.raw, 0);
    assert.equal(q.parsed, 1);
    assert.equal((q.samples[0] as { title: string }).title, "最大震度4（茨城県南部・M4.6）");
    assert.equal(t.parsed, 1);
    assert.equal((t.samples[0] as { title: string }).title, "台風第21号（ネーム）");
    assert.deepEqual(t.mismatches, []);
    // 取りに行った先は決まった場所だけ（電文は 1 通だけ）
    assert.equal(f.calls.length, 7);
  });

  it("形式が違えば「項目がありません」と知らせる", async () => {
    const bad = { ...usgs, features: [{ ...usgs.features[0], properties: { mag: 5, time: NOW } }] };
    const r = await checkUsgs(fakeFetch({ [USGS_URL]: ok(JSON.stringify(bad)) }).fn);
    assert.ok(r.mismatches.some((m) => m.includes("place")));
  });

  it("429・5xx でも再試行しない。1 つ失敗してもほかは確かめる", async () => {
    const routes = { ...allRoutes(), [USGS_URL]: () => new Response("slow", { status: 429, headers: { "retry-after": "60" } }), [NHC_URL]: () => new Response("down", { status: 503 }) };
    const f = fakeFetch(routes);
    const reports = await runChecks(f.fn);
    assert.equal(f.calls.filter((c) => c === USGS_URL).length, 1);
    assert.equal(f.calls.filter((c) => c === NHC_URL).length, 1);
    assert.equal(reports[0].ok, false);
    assert.equal(reports[0].http[0].status, 429);
    assert.match(reports[0].error ?? "", /制限/);
    assert.equal(reports[1].ok, false);
    assert.equal(reports[2].ok, true);
  });

  it("表示：取った文字が GitHub Actions の命令として解釈されない。全文は出さない", async () => {
    const evil = { ...usgs, features: [{ ...usgs.features[0], properties: { ...usgs.features[0].properties, place: `::set-env name=X::y\n::error::hacked ${"長".repeat(500)}` } }] };
    const reports = await runChecks(fakeFetch({ ...allRoutes(), [USGS_URL]: ok(JSON.stringify(evil)) }).fn);
    const lines = render(reports, "TOKEN123");
    assert.equal(lines[0], "::stop-commands::TOKEN123");
    assert.equal(lines[lines.length - 1], "::TOKEN123::");
    // 命令の形（行頭の ::）は、最初と最後の 2 行だけ
    assert.equal(lines.join("\n").split("\n").filter((l) => l.startsWith("::")).length, 2);
    assert.ok(!lines.join("\n").includes("長".repeat(100)));
  });
});

/* ---------- 台風：電文ごとの結果と、最大風速が読めないときの調査 ---------- */

/** 実況の「風」の部分を差し替えた台風の電文（ほかは typhoonXml と同じ） */
const typhoonWith = (opts: { number: string; wind: string; headline?: string }) =>
  typhoonXml
    .replace("<Number>2621</Number>", `<Number>${opts.number}</Number>`)
    .replace(/<Kind><Property><Type>風<\/Type>[\s\S]*?<\/Kind>/, opts.wind)
    .replace("<Headline><Text></Text></Headline>", `<Headline><Text>${opts.headline ?? ""}</Text></Headline>`);

const KT_ONLY = `<Kind><Property><Type>風</Type><WindPart><jmx_eb:WindSpeed type="最大風速" unit="ノット" condition="中心付近">35</jmx_eb:WindSpeed></WindPart></Property></Kind>`;
const NO_WIND = "";
const EMPTY_WIND = `<Kind><Property><Type>風</Type><WindPart><jmx_eb:WindSpeed type="最大風速" unit="m/s" condition="中心付近"/></WindPart></Property></Kind>`;

const typhoonFeed = atom([
  { title: "台風解析・予報情報（５日予報）（Ｈ３０）", file: "t0_VPTW60_010000" },
  { title: "台風解析・予報情報（５日予報）（Ｈ３０）", file: "t1_VPTW61_010000" },
  { title: "台風解析・予報情報（５日予報）（Ｈ３０）", file: "t2_VPTW62_010000" },
  { title: "台風解析・予報情報（５日予報）（Ｈ３０）", file: "t3_VPTW63_010000" },
]);

describe("台風の調査（電文ごとの結果・最大風速が読めないとき）", () => {
  it("見本は最大 6 件。電文ごとに番号・名前・位置・気圧・風速を出す", async () => {
    const f = fakeFetch({
      [JMA_EXTRA_LONG_URL]: ok(typhoonFeed, "application/atom+xml"),
      [`${DATA}/t0_VPTW60_010000.xml`]: ok(typhoonWith({ number: "2620", wind: KT_ONLY })),
      [`${DATA}/t1_VPTW61_010000.xml`]: ok(typhoonXml),
      [`${DATA}/t2_VPTW62_010000.xml`]: ok(typhoonWith({ number: "2622", wind: NO_WIND })),
      [`${DATA}/t3_VPTW63_010000.xml`]: ok(typhoonWith({ number: "2623", wind: EMPTY_WIND })),
    });
    const r = await checkJmaTyphoon(f.fn);
    assert.equal(r.parsed, 4);
    assert.equal(r.samples.length, 4); // 以前の上限（2 件）を超えて出る
    assert.equal(r.details?.length, 4);
    const byCode = Object.fromEntries((r.details ?? []).map((d) => [d.code as string, d]));
    assert.equal(byCode.VPTW61.windMs, 23);
    assert.equal(byCode.VPTW61.windDiagnostics, undefined); // 読めたときは調査を付けない
    assert.equal(byCode.VPTW61.typhoon, 21);
    assert.equal(byCode.VPTW61.name, "NAME");
    assert.deepEqual(byCode.VPTW61.place, { name: "フィリピンの東", lat: 20.1, lon: 131 });
    assert.equal(byCode.VPTW61.pressureHpa, 990);
  });

  it("ノットだけで m/s が無い：値はあるが m/s では読めていない、と分かる", () => {
    const d = windDiagnostics(typhoonWith({ number: "2620", wind: KT_ONLY }));
    assert.equal(d.observed, true);
    assert.equal(d.windPart, true);
    assert.deepEqual(d.windElements, [{ element: "jmx_eb:WindSpeed", attrs: { type: "最大風速", unit: "ノット", condition: "中心付近" }, value: "35" }]);
    assert.ok((d.propertyTypes as string[]).includes("風"));
  });

  it("風の部分が無い：値そのものが無い、と分かる", () => {
    const d = windDiagnostics(typhoonWith({ number: "2622", wind: NO_WIND }));
    assert.equal(d.windPart, false);
    assert.deepEqual(d.windElements, []);
    assert.ok(!(d.propertyTypes as string[]).includes("風"));
  });

  it("要素はあるが中身が空：空の要素として分かる", () => {
    const d = windDiagnostics(typhoonWith({ number: "2623", wind: EMPTY_WIND }));
    assert.deepEqual(d.windElements, [{ element: "jmx_eb:WindSpeed", attrs: { type: "最大風速", unit: "m/s", condition: "中心付近" }, value: null }]);
  });

  it("実況の部分が無い電文も、止まらずにそう伝える", () => {
    assert.deepEqual(windDiagnostics("<Report><Body></Body></Report>"), { meteorologicalInfos: 0, observed: false });
  });

  it("電文の全文や関係のない本文は出さない。属性・値は短く切る", async () => {
    const secret = "関係のない長い本文".repeat(200);
    const longAttr = `<Kind><Property><Type>風</Type><WindPart><jmx_eb:WindSpeed type="最大風速" unit="ノット" condition="${"長".repeat(300)}">${"9".repeat(300)}</jmx_eb:WindSpeed></WindPart></Property></Kind>`;
    const f = fakeFetch({
      [JMA_EXTRA_LONG_URL]: ok(atom([{ title: "台風解析・予報情報（５日予報）（Ｈ３０）", file: "t0_VPTW60_010000" }]), "application/atom+xml"),
      [`${DATA}/t0_VPTW60_010000.xml`]: ok(typhoonWith({ number: "2620", wind: longAttr, headline: secret })),
    });
    const out = render([await checkJmaTyphoon(f.fn)], "TOK").join("\n");
    // 見出し文は調査のため 100 文字までは出すが、それを超えて（全文を）出さない
    assert.ok(!out.includes(secret.slice(0, 101)));
    // 本文 200 回分のうち、出るのは見出し文の 100 文字に入る分（11 回）まで
    assert.ok(out.split("関係のない長い本文").length - 1 <= 11);
    assert.ok(!out.includes("長".repeat(41)));
    assert.ok(!out.includes("9".repeat(21)));
    assert.ok(!out.includes("<Report"));
  });
});

describe("台風の電文の構造（同じ台風の見分け方・発表の終わりの印の調査）", () => {
  it("EventID・番号の元の書き方・発表の種類・時刻・実況と予報の並びを出す", () => {
    const st = typhoonStructure(typhoonXml);
    assert.equal(st.eventId, "TC2621");
    assert.equal(st.numberRaw, "2621");
    assert.equal(st.numberDigits, 4);
    assert.equal(st.status, "通常");
    assert.equal(st.infoType, "発表");
    assert.equal(st.reportDateTime, "2026-10-11T16:00:00+09:00");
    assert.equal(st.meteorologicalInfos, 1);
    assert.deepEqual(st.dateTimeTypes, ["実況"]);
  });

  it("予報が並ぶ電文では、その並びが分かる。番号が 2 桁ならそう分かる", () => {
    const withForecast = typhoonXml
      .replace("<Number>2621</Number>", "<Number>２１</Number>")
      .replace("</MeteorologicalInfos>", '<MeteorologicalInfo><DateTime type="予報 24時間後">2026-10-12T15:00:00+09:00</DateTime><Item></Item></MeteorologicalInfo><MeteorologicalInfo><DateTime type="予報 48時間後">2026-10-13T15:00:00+09:00</DateTime><Item></Item></MeteorologicalInfo></MeteorologicalInfos>');
    const st = typhoonStructure(withForecast);
    assert.equal(st.numberDigits, 2);
    assert.equal(st.meteorologicalInfos, 3);
    assert.deepEqual(st.dateTimeTypes, ["実況", "予報 24時間後", "予報 48時間後"]);
  });

  it("見出し文は 100 文字までに切る。番号が無ければ null", () => {
    const st = typhoonStructure(typhoonXml.replace("<Headline><Text></Text></Headline>", `<Headline><Text>台風第２１号は熱帯低気圧に変わりました。${"あ".repeat(300)}</Text></Headline>`).replace(/<Number>[^<]*<\/Number>/, ""));
    assert.ok(String(st.headline).startsWith("台風第２１号は熱帯低気圧に変わりました。"));
    assert.ok(String(st.headline).length <= 100);
    assert.equal(st.numberRaw, null);
    assert.equal(st.numberDigits, null);
  });

  it("電文ごとの結果に構造が付き、電文コードごとの発表時刻（新しい順・最大 8 件）が分かる", async () => {
    const entries = Array.from({ length: 10 }, (_, k) => ({ title: "台風解析・予報情報（５日予報）（Ｈ３０）", file: `h${k}_VPTW61_010000` }));
    // atom() は同じ時刻を付けるので、時刻を差し替える
    let feed = atom(entries);
    entries.forEach((e, k) => {
      feed = feed.replace(`<id>urn:${e.file}</id><updated>2026-10-11T00:00:00Z</updated>`, `<id>urn:${e.file}</id><updated>2026-10-1${k < 5 ? 0 : 1}T0${k % 5}:00:00Z</updated>`);
    });
    const routes: Record<string, () => Response> = { [JMA_EXTRA_LONG_URL]: ok(feed, "application/atom+xml") };
    for (const e of entries) routes[`${DATA}/${e.file}.xml`] = ok(typhoonXml);
    const r = await checkJmaTyphoon(fakeFetch(routes).fn);
    const history = (r.format as { history: Record<string, string[]> }).history.VPTW61;
    assert.equal(history.length, 8);
    assert.equal(history[0], "2026-10-11T04:00:00Z");
    assert.ok(Date.parse(history[0]) >= Date.parse(history[7]));
    assert.equal((r.details?.[0].structure as { eventId: string }).eventId, "TC2621");
  });
});

/* ---------- ワークフローの確認 ---------- */

describe("ワークフロー（edith-intel-check.yml）", () => {
  const yml = readFileSync(join(ROOT, ".github/workflows/edith-intel-check.yml"), "utf8");
  const code = yml.split("\n").filter((l) => !l.trim().startsWith("#")).join("\n");

  it("手動実行だけ（定期実行・push などのきっかけは無い）", () => {
    const on = /\non:\n([\s\S]*?)\n\S/.exec(code)?.[1] ?? "";
    assert.equal(on.trim(), "workflow_dispatch: {}");
    assert.doesNotMatch(code, /schedule|cron|pull_request|push:/);
  });

  it("読み取り権限だけ・同時実行なし・時間の上限あり", () => {
    assert.match(code, /\npermissions:\n  contents: read\n/);
    assert.doesNotMatch(code, /write/);
    assert.match(code, /concurrency:\n  group: edith-intel-check/);
    assert.match(code, /timeout-minutes: 5/);
    assert.match(code, /persist-credentials: false/);
  });

  it("秘密の値・本番（Vercel）・EDITH_INTEL を使わない。依存パッケージも入れない", () => {
    assert.doesNotMatch(code, /secrets\.|vercel|FRIDAY_URL|CRON_SECRET|EDITH_INTEL|npm (ci|install)/i);
    assert.match(code, /scripts\/intel-check\.ts/);
  });
});
