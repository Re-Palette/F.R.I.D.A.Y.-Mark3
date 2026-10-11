/**
 * NOAA NHC の分類（PTC・PC）と、気象庁の台風の電文（VPTW60〜65）のテスト。
 * 注意：
 *   - NHC の分類の定義は「NHC Tropical Cyclone Status JSON File Reference」による
 *   - 気象庁の台風の電文は、気象庁「台風解析・予報情報XML の解説」の要素の形をもとに作ったもの（本物の電文の写しではない）
 *   - フィードの見出し・電文の名前・時刻は、2026-10-11 の実データ確認（edith-intel-check）で実際に見えたものを使っている
 *   npm test
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fakeBrain } from "./intel-fake";

const { parseNhc, nhcClassJa, NHC_CLASS_JA } = await import("../src/integrations/intel/sources/nhc");
const { parseAtom, parseTyphoonDoc, latestTyphoonDocs, typhoonCode, fetchJmaTyphoon, JMA_EXTRA_LONG_URL } = await import("../src/integrations/intel/sources/jma");
const { parseUsgs } = await import("../src/integrations/intel/sources/usgs");
const { runIntel } = await import("../src/integrations/intel/collect");
const { INTEL_SETTINGS_PATH, INTEL_ITEMS_PATH } = await import("../src/integrations/intel/brain-io");
const { parseItems, MAX_ITEMS } = await import("../src/integrations/intel/store");
const { renderSettingsNote, defaultSettings } = await import("../src/integrations/intel/settings");

const NOW = Date.UTC(2026, 9, 11, 8, 0, 0);
const DATA = "https://www.data.jma.go.jp/developer/xml/data";

/* ---------- NOAA NHC の分類 ---------- */

describe("NOAA NHC の分類（公式の定義どおり）", () => {
  it("PTC は「熱帯の性質を失った低気圧」、PC は「熱帯低気圧になる可能性のある擾乱」", () => {
    assert.equal(nhcClassJa("PTC"), "熱帯の性質を失った低気圧");
    assert.equal(nhcClassJa("PC"), "熱帯低気圧になる可能性のある擾乱");
    assert.equal(nhcClassJa("HU"), "ハリケーン");
    assert.equal(nhcClassJa("TS"), "熱帯暴風雨");
    assert.equal(nhcClassJa("TD"), "熱帯低気圧");
    assert.equal(nhcClassJa("STS"), "亜熱帯暴風雨");
    assert.equal(nhcClassJa("STD"), "亜熱帯低気圧");
    assert.deepEqual(Object.keys(NHC_CLASS_JA).sort(), ["HU", "PC", "PTC", "STD", "STS", "TD", "TS", "TY"]);
  });

  it("知らない略号には意味を付けない", () => {
    assert.equal(nhcClassJa("XX"), "熱帯低気圧など（XX）");
    assert.equal(nhcClassJa(""), "熱帯低気圧など");
  });

  it("実データで見えた Isaias（PTC・内陸・20 ノット）を正しい分類で見出しにする", () => {
    const [i] = parseNhc(
      { activeStorms: [{ id: "al092026", name: "Isaias", classification: "PTC", intensity: "20", pressure: "1009", latitudeNumeric: 35, longitudeNumeric: -86.7, lastUpdate: "2026-10-11T03:00:00.000Z", forecastAdvisory: { advNum: "018", issuance: "2026-10-11T03:00:00.000Z", url: "https://www.nhc.noaa.gov/text/MIATCMAT4.shtml" } }] },
      NOW,
    );
    assert.equal(i.title, "熱帯の性質を失った低気圧「Isaias」（大西洋）");
    const [pc] = parseNhc({ activeStorms: [{ id: "al102026", name: "Ten", classification: "PC", lastUpdate: "2026-10-11T03:00:00.000Z" }] }, NOW);
    assert.equal(pc.title, "熱帯低気圧になる可能性のある擾乱「Ten」（大西洋）");
  });
});

/* ---------- 気象庁の台風の電文 ---------- */

interface TyOpts {
  status?: string;
  infoType?: string;
  eventId?: string | null;
  number?: string | null;
  name?: string;
  kana?: string;
  report?: string;
  cls?: string;
  area?: string;
  intensity?: string;
  coord?: string;
  pressure?: string;
  windMs?: string;
  windKt?: string;
  location?: string;
  forecastFirst?: boolean;
}

function typhoonXml(o: TyOpts = {}): string {
  const namePart =
    o.number === null
      ? ""
      : `<Kind><Property><Type>呼称</Type><TyphoonNamePart><Name>${o.name ?? "FUNG-WONG"}</Name><NameKana>${o.kana ?? "フンウォン"}</NameKana><Number>${o.number ?? "2621"}</Number></TyphoonNamePart></Property></Kind>`;
  const info = (type: string, coord: string) =>
    `<MeteorologicalInfo><DateTime type="${type}">${type === "実況" ? "2026-10-11T15:00:00+09:00" : "2026-10-12T15:00:00+09:00"}</DateTime><Item>${namePart}<Kind><Property><Type>階級</Type><ClassPart><jmx_eb:TyphoonClass type="熱帯擾乱種類">${o.cls ?? "台風（STS）"}</jmx_eb:TyphoonClass><jmx_eb:AreaClass type="大きさ階級">${o.area ?? "大型"}</jmx_eb:AreaClass><jmx_eb:IntensityClass type="強さ階級">${o.intensity ?? "強い"}</jmx_eb:IntensityClass></ClassPart></Property></Kind><Kind><Property><Type>中心</Type><CenterPart><jmx_eb:Coordinate type="中心位置（度）">${coord}</jmx_eb:Coordinate><Location>${o.location ?? "日本の南"}</Location><jmx_eb:Pressure type="中心気圧" unit="hPa">${o.pressure ?? "965"}</jmx_eb:Pressure></CenterPart></Property></Kind><Kind><Property><Type>風</Type><WindPart><jmx_eb:WindSpeed type="最大風速" unit="ノット" condition="中心付近">${o.windKt ?? "70"}</jmx_eb:WindSpeed><jmx_eb:WindSpeed type="最大風速" unit="m/s" condition="中心付近">${o.windMs ?? "35"}</jmx_eb:WindSpeed></WindPart></Property></Kind></Item></MeteorologicalInfo>`;
  const infos = o.forecastFirst ? info("予報 24時間後", "+33.0+138.0/") + info("実況", o.coord ?? "+28.5+134.2/") : info("実況", o.coord ?? "+28.5+134.2/") + info("予報 24時間後", "+33.0+138.0/");
  return `<?xml version="1.0" encoding="UTF-8"?>
<Report xmlns="http://xml.kishou.go.jp/jmaxml1/" xmlns:jmx_eb="http://xml.kishou.go.jp/jmaxml1/elementBasis1/">
<Control><Title>台風解析・予報情報（５日予報）（Ｈ３０）</Title><Status>${o.status ?? "通常"}</Status></Control>
<Head xmlns="http://xml.kishou.go.jp/jmaxml1/informationBasis1/"><Title>台風解析・予報情報</Title><ReportDateTime>${o.report ?? "2026-10-11T16:00:00+09:00"}</ReportDateTime>${o.eventId === null ? "" : `<EventID>${o.eventId ?? "TC2621"}</EventID>`}<InfoType>${o.infoType ?? "発表"}</InfoType><Headline><Text></Text></Headline></Head>
<Body xmlns="http://xml.kishou.go.jp/jmaxml1/body/meteorology1/"><MeteorologicalInfos type="台風情報">${infos}</MeteorologicalInfos></Body></Report>`;
}

const doc = (file: string) => `${DATA}/${file}.xml`;

describe("気象庁の台風の電文（VPTW60〜65）", () => {
  it("番号・名前・階級・大きさ・強さ・中心位置・中心気圧・最大風速を、実況の部分から読む", () => {
    const i = parseTyphoonDoc(typhoonXml({ forecastFirst: true }), doc("20261011070122_0_VPTW61_010000"), NOW)!;
    assert.equal(i.id, "jma:typhoon:2621");
    assert.equal(i.source, "jmatyphoon");
    assert.equal(i.kind, "official");
    assert.equal(i.title, "台風第21号（フンウォン）［大型・強い］");
    assert.deepEqual(i.place, { name: "日本の南", lat: 28.5, lon: 134.2 }); // 予報の位置ではなく実況の位置
    assert.equal(i.publishedAt, new Date("2026-10-11T15:00:00+09:00").toISOString());
    assert.equal(i.updatedAt, new Date("2026-10-11T16:00:00+09:00").toISOString());
    assert.equal(i.facts.typhoon, 21);
    assert.equal(i.facts.name, "FUNG-WONG");
    assert.equal(i.facts.typhoonClass, "台風（STS）");
    assert.equal(i.facts.pressureHpa, 965);
    assert.equal(i.facts.windMs, 35);
    assert.equal(i.facts.windKt, 70);
    assert.equal(i.facts.code, "VPTW61");
    assert.match(i.summary, /中心は日本の南・中心気圧 965hPa・最大風速 35m\/s/);
  });

  it("大きさ・強さの階級が空（弱い台風）なら、見出しに付けない", () => {
    const i = parseTyphoonDoc(typhoonXml({ area: "", intensity: "" }), doc("a_VPTW60_010000"), NOW)!;
    assert.equal(i.title, "台風第21号（フンウォン）");
  });

  it("番号が「21」だけでも「2621」でも、同じ台風として 1 件にまとめる（年を付けて区別）", () => {
    const a = parseTyphoonDoc(typhoonXml({ number: "2621" }), doc("a_VPTW61_010000"), NOW)!;
    const b = parseTyphoonDoc(typhoonXml({ number: "２１" }), doc("b_VPTW61_010000"), NOW)!;
    assert.equal(a.id, b.id);
    // 去年の 21 号とは混ざらない
    const lastYear = parseTyphoonDoc(typhoonXml({ number: "21", report: "2025-10-11T16:00:00+09:00" }), doc("c_VPTW61_010000"), NOW)!;
    assert.notEqual(lastYear.id, a.id);
  });

  it("番号の無い熱帯低気圧は EventID で区別し、別の EventID とは混ぜない。どちらも無ければ取り込まない", () => {
    const td1 = parseTyphoonDoc(typhoonXml({ number: null, eventId: "TD2622" }), doc("x_VPTW62_010000"), NOW)!;
    const td2 = parseTyphoonDoc(typhoonXml({ number: null, eventId: "TD2623" }), doc("y_VPTW63_010000"), NOW)!;
    assert.equal(td1.title.startsWith("熱帯低気圧（台風になる見込み）"), true);
    assert.equal(td1.id, "jma:typhoon:ev:TD2622");
    assert.notEqual(td1.id, td2.id);
    assert.equal(parseTyphoonDoc(typhoonXml({ number: null, eventId: null }), doc("z_VPTW64_010000"), NOW), null);
  });

  it("訓練・試験は取り込まない。取消は取消として残す", () => {
    assert.equal(parseTyphoonDoc(typhoonXml({ status: "訓練" }), doc("a_VPTW60_010000"), NOW), null);
    assert.equal(parseTyphoonDoc(typhoonXml({ status: "試験" }), doc("a_VPTW60_010000"), NOW), null);
    const c = parseTyphoonDoc(typhoonXml({ infoType: "取消" }), doc("a_VPTW60_010000"), NOW)!;
    assert.match(c.title, /^（取消）/);
    assert.equal(c.facts.cancelled, true);
  });

  it("実況（いまの解析）が無い電文は、予報の位置を「いま」と取り違えないよう取り込まない", () => {
    const onlyForecast = typhoonXml().replace(/<MeteorologicalInfo><DateTime type="実況">[\s\S]*?<\/MeteorologicalInfo>/, "");
    assert.ok(!onlyForecast.includes('type="実況"'));
    assert.equal(parseTyphoonDoc(onlyForecast, doc("a_VPTW60_010000"), NOW), null);
  });

  it("4 桁の番号も年で区別する（2521 と 2621 は別の台風）", () => {
    const a = parseTyphoonDoc(typhoonXml({ number: "2521" }), doc("a_VPTW61_010000"), NOW)!;
    const b = parseTyphoonDoc(typhoonXml({ number: "2621" }), doc("b_VPTW61_010000"), NOW)!;
    assert.notEqual(a.id, b.id);
  });

  it("同じ電文コードでも、番号が違えば別の台風（前の台風が消えたあと、同じコードが別の台風に使われても混ぜない）", () => {
    const old = parseTyphoonDoc(typhoonXml({ number: "2619" }), doc("a_VPTW60_010000"), NOW)!;
    const next = parseTyphoonDoc(typhoonXml({ number: "2623" }), doc("b_VPTW60_010000"), NOW)!;
    assert.equal(old.facts.code, next.facts.code);
    assert.notEqual(old.id, next.id);
  });

  it("形が違う電文・壊れた電文でも止まらない（読めなければ null）", () => {
    assert.equal(parseTyphoonDoc("<Report><Control><Status>通常</Status></Control><Body></Body></Report>", doc("a_VPTW60_010000"), NOW), null);
    assert.equal(parseTyphoonDoc("壊れている", doc("a_VPTW60_010000"), NOW), null);
    // 位置・気圧・風が読めなくても、番号があれば取り込む（読めなかった項目は空）
    const partial = parseTyphoonDoc(typhoonXml({ coord: "不明", pressure: "", windMs: "" }), doc("a_VPTW60_010000"), NOW)!;
    assert.equal(partial.place, null);
    assert.equal(partial.facts.pressureHpa, null);
    assert.equal(partial.facts.windMs, null);
  });

  it("電文コード（VPTW60〜65）を読む。それ以外は台風の電文として扱わない", () => {
    assert.equal(typhoonCode(doc("20261011070122_0_VPTW61_010000")), "VPTW61");
    assert.equal(typhoonCode(doc("20261011070122_0_VPTW40_010000")), null);
    assert.equal(typhoonCode(doc("20261011070122_0_VPWW54_010000")), null);
  });
});

/* ---------- フィードから電文コードごとに最新を選ぶ ---------- */

/** 実データ確認で見えた形のフィード（台風の項目 132 件・電文コード 2 種類・ほかの電文も混ざる） */
function realShapedFeed(): string {
  const entries: string[] = [];
  const add = (title: string, file: string, updated: string) =>
    entries.push(`<entry><title>${title}</title><id>urn:${file}</id><updated>${updated}</updated><author><name>気象庁</name></author><link type="application/xml" href="${doc(file)}"/><content type="text">【${title}】</content></entry>`);
  for (let k = 0; k < 66; k++) {
    const t = new Date(Date.UTC(2026, 9, 11, 7, 1, 22) - k * 3 * 3600_000);
    const stamp = t.toISOString().replace(/[-:T]/g, "").slice(0, 14);
    add("台風解析・予報情報（５日予報）（Ｈ３０）", `${stamp}_0_VPTW61_010000`, t.toISOString().replace(".000", ""));
    const t2 = new Date(t.getTime() - 20 * 60_000 - 23_000);
    const s2 = t2.toISOString().replace(/[-:T]/g, "").slice(0, 14);
    add("台風解析・予報情報（５日予報）（Ｈ３０）", `${s2}_0_VPTW62_010000`, t2.toISOString().replace(".000", ""));
  }
  add("気象警報・注意報（Ｈ２７）", "20261011073253_0_VPWW53_400000", "2026-10-11T07:32:53Z");
  add("台風の暴風域に入る確率", "20261011070000_0_VPTA50_010000", "2026-10-11T07:00:00Z");
  return `<feed xmlns="http://www.w3.org/2005/Atom"><updated>2026-10-11T07:33:45Z</updated>${entries.join("")}</feed>`;
}

describe("フィードから台風の電文を選ぶ", () => {
  it("132 件の台風の項目から、電文コードごとに最新の 1 通だけを選ぶ", () => {
    const entries = parseAtom(realShapedFeed());
    assert.equal(entries.filter((e) => /台風解析/.test(e.title)).length, 132);
    const picked = latestTyphoonDocs(entries);
    assert.deepEqual(
      picked.map((p) => p.code),
      ["VPTW61", "VPTW62"],
    );
    assert.equal(picked[0].url, doc("20261011070122_0_VPTW61_010000"));
    assert.equal(picked[1].url, doc("20261011064059_0_VPTW62_010000"));
  });

  it("時刻の書き方（Z と +09:00）が混ざっても、新しいほうを選ぶ", () => {
    const entry = (file: string, updated: string) => ({ title: "台風解析・予報情報（５日予報）（Ｈ３０）", id: file, updated, author: "気象庁", link: doc(file), content: "" });
    // 15:30+09:00（= 06:30Z）は 07:00Z より古い。文字のまま比べると取り違える組み合わせ
    const picked = latestTyphoonDocs([entry("new_VPTW61_010000", "2026-10-11T07:00:00Z"), entry("old_VPTW61_010000", "2026-10-11T15:30:00+09:00")]);
    assert.equal(picked[0].url, doc("new_VPTW61_010000"));
  });

  it("気象庁以外のリンクは選ばない", () => {
    const [e] = parseAtom(realShapedFeed());
    assert.deepEqual(latestTyphoonDocs([{ ...e, link: "https://evil.example/20261011070122_0_VPTW61_010000.xml" }]), []);
  });
});

/* ---------- 取得（電文の取得・失敗の切り分け） ---------- */

function fakeFetch(routes: Record<string, () => Response>) {
  const calls: string[] = [];
  const fn = async (url: string) => {
    calls.push(String(url));
    const r = routes[String(url)];
    return r ? r() : new Response("nf", { status: 404 });
  };
  return { fn: fn as unknown as typeof fetch, calls };
}
const xmlRes = (body: string) => () => new Response(body, { status: 200, headers: { "content-type": "text/xml" } });
const ctx = (over: Record<string, unknown> = {}) => ({ now: NOW, known: new Set<string>(), knownReports: new Set<string>(), lastSuccessAt: null, ...over });

describe("台風の取得", () => {
  it("読むのは電文コードごとの最新だけ（132 件あっても電文は 2 通）。同じ台風は 1 件", async () => {
    const f = fakeFetch({
      [JMA_EXTRA_LONG_URL]: xmlRes(realShapedFeed()),
      [doc("20261011070122_0_VPTW61_010000")]: xmlRes(typhoonXml({ number: "2621" })),
      [doc("20261011064059_0_VPTW62_010000")]: xmlRes(typhoonXml({ number: "2622", kana: "ツー", eventId: "TC2622" })),
    });
    const items = await fetchJmaTyphoon({ ...ctx(), fetchImpl: f.fn });
    assert.equal(f.calls.length, 3);
    assert.deepEqual(items.map((i) => i.id).sort(), ["jma:typhoon:2621", "jma:typhoon:2622"]);
  });

  it("1 通の取得・解析に失敗しても、ほかの台風は取り込む。読んだことのある電文は読み直さない", async () => {
    const f = fakeFetch({
      [JMA_EXTRA_LONG_URL]: xmlRes(realShapedFeed()),
      [doc("20261011070122_0_VPTW61_010000")]: () => new Response("err", { status: 503 }),
      [doc("20261011064059_0_VPTW62_010000")]: xmlRes(typhoonXml({ number: "2622" })),
    });
    const items = await fetchJmaTyphoon({ ...ctx(), fetchImpl: f.fn });
    assert.deepEqual(items.map((i) => i.id), ["jma:typhoon:2622"]);
    const f2 = fakeFetch({ [JMA_EXTRA_LONG_URL]: xmlRes(realShapedFeed()) });
    const again = await fetchJmaTyphoon({ ...ctx({ knownReports: new Set(["20261011070122_0_VPTW61_010000", "20261011064059_0_VPTW62_010000"]) }), fetchImpl: f2.fn });
    assert.deepEqual(again, []);
    assert.equal(f2.calls.length, 1);
  });

  it("壊れた電文は取り込まずに続ける", async () => {
    const f = fakeFetch({
      [JMA_EXTRA_LONG_URL]: xmlRes(realShapedFeed()),
      [doc("20261011070122_0_VPTW61_010000")]: xmlRes("<html>maintenance</html>"),
      [doc("20261011064059_0_VPTW62_010000")]: xmlRes(typhoonXml({ number: "2622" })),
    });
    const items = await fetchJmaTyphoon({ ...ctx(), fetchImpl: f.fn });
    assert.equal(items.length, 1);
  });
});

/* ---------- 保存の上限を圧迫しない ---------- */

describe("保存（台風が地震などを押し出さない）", () => {
  it("何度更新しても台風は 1 台 1 件。地震の情報は残る", async () => {
    const s = defaultSettings();
    for (const k of Object.keys(s.sources) as (keyof typeof s.sources)[]) s.sources[k] = k === "jmatyphoon" || k === "usgs";
    const b = fakeBrain({ [INTEL_SETTINGS_PATH]: renderSettingsNote(s) });
    const quakes = parseUsgs(
      {
        type: "FeatureCollection",
        features: Array.from({ length: 30 }, (_, k) => ({ id: `q${k}`, geometry: { coordinates: [140, 35, 10] }, properties: { mag: 5, place: "x", time: NOW - k * 60_000, updated: NOW, status: "reviewed" } })),
      },
      NOW,
    );
    // 24 回分（1 日分）の台風の更新を重ねる
    for (let run = 0; run < 24; run++) {
      const t = NOW + run * 3600_000;
      const report = new Date(t).toISOString();
      await runIntel({
        io: b.io,
        env: { EDITH_INTEL: "on" },
        now: () => t,
        fetchers: {
          usgs: async () => (run === 0 ? quakes : []),
          jmatyphoon: async () => [
            parseTyphoonDoc(typhoonXml({ number: "2621", report }), doc(`r${run}_VPTW61_010000`), t)!,
            parseTyphoonDoc(typhoonXml({ number: "2622", report }), doc(`r${run}_VPTW62_010000`), t)!,
          ],
        },
      });
    }
    const items = parseItems(b.files.get(INTEL_ITEMS_PATH)!.text);
    assert.equal(items.filter((i) => i.source === "jmatyphoon").length, 2);
    assert.equal(items.filter((i) => i.source === "usgs").length, 30);
    // 最新の発表が残っている
    const t21 = items.find((i) => i.id === "jma:typhoon:2621")!;
    assert.equal(t21.facts.report, "r23_VPTW61_010000");
    assert.ok(items.length < MAX_ITEMS);
  });
});
