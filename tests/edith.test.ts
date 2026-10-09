/**
 * E.D.I.T.H.（グローバル情報 AI）のテスト。
 *   - F.R.I.D.A.Y. / K.A.R.E.N. ⇄ E.D.I.T.H. の切り替えの言葉・呼びかけ
 *   - ニュースの読み取りと、実際に参照したページ（出典）の結び付け（出典の無い話題は出さない）
 *   - 地名から地図の地点を見つける・表の読み取り・世界地図のデータ
 *   npm test
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const { detectModeCommand, setAiMode } = await import("../src/lib/ai-mode");
const { splitWake, stripWake } = await import("../src/lib/speech");
const { parseNewsLines, sourcesForLine } = await import("../src/integrations/edith-news");
const { findPlaces } = await import("../src/lib/edith-geo");
const { trendCounts } = await import("../src/lib/edith-data");
const { landRings, landDots, toXYZ, toLatLon } = await import("../src/lib/edith-globe-data");
const { splitTables } = await import("../src/lib/edith-text");

describe("E.D.I.T.H. への切り替え", () => {
  for (const t of ["イーディスを呼んで", "E.D.I.T.H.を起動", "EDITHお願い", "イーディスを開いて", "グローバルモードに切り替えて"]) {
    it(`「${t}」→ E.D.I.T.H.`, () => assert.equal(detectModeCommand(t), "to-edith"));
  }
  for (const t of ["イーディス終了", "グローバルモードを終了", "フライデーに戻して"]) {
    it(`「${t}」→ F.R.I.D.A.Y.`, () => assert.equal(detectModeCommand(t), "to-friday"));
  }
  it("「イーディスって何？」は切り替えない", () => assert.equal(detectModeCommand("イーディスって何？"), null));
});

describe("E.D.I.T.H. の呼びかけ", () => {
  it("F.R.I.D.A.Y. の間：「イーディス、起動」は名前ごと渡して切り替えの言葉として見分ける", () => {
    setAiMode("friday");
    assert.deepEqual(splitWake("イーディス、起動"), { woke: true, command: "イーディス、起動" });
    assert.equal(detectModeCommand(splitWake("イーディス、起動").command), "to-edith");
  });
  it("E.D.I.T.H. の間：「イーディス、AI の動向を調べて」は名前を取り除く。「フライデー」では起きない（戻る指示だけ）", () => {
    setAiMode("edith");
    assert.deepEqual(splitWake("イーディス、AIの動向を調べて"), { woke: true, command: "AIの動向を調べて" });
    assert.deepEqual(splitWake("エディス、翻訳して"), { woke: true, command: "翻訳して" });
    assert.equal(stripWake("イーディス、天気は"), "天気は");
    assert.equal(splitWake("フライデー").woke, false);
    assert.equal(splitWake("フライデーに戻して").woke, true);
    assert.equal(splitWake("今日はイーディスの話をした").woke, false, "文の途中では起きない");
    setAiMode("friday");
  });
});

describe("REAL-TIME NEWS の読み取りと出典", () => {
  const text = `今日の主な話題です。
・米国でAI規制の新しい枠組み｜ホワイトハウスがAIの安全性に関する方針を発表した｜アメリカ
・欧州で再エネ導入が加速｜EUが2030年に向けた新目標を示した｜EU
・出典の無い話題｜検索で確かめられなかった｜世界`;
  const grounding = {
    chunks: [
      { uri: "https://vertexaisearch.cloud.google.com/grounding-api-redirect/aaa", title: "whitehouse.gov" },
      { uri: "https://vertexaisearch.cloud.google.com/grounding-api-redirect/bbb", title: "europa.eu" },
      null,
    ],
    supports: [
      { text: "米国でAI規制の新しい枠組み｜ホワイトハウスがAIの安全性に関する方針を発表した", chunks: [0] },
      { text: "EUが2030年に向けた新目標を示した", chunks: [1, 2] },
    ],
  };
  const lines = parseNewsLines(text);
  it("「・見出し｜要約｜地域」を読み取る（前置きは除く）", () => {
    assert.equal(lines.length, 3);
    assert.deepEqual(
      { title: lines[0].title, region: lines[0].region },
      { title: "米国でAI規制の新しい枠組み", region: "アメリカ" },
    );
  });
  it("その行の文に結びついたページだけを出典にする（無い話題は出典なし）", () => {
    assert.deepEqual(sourcesForLine(lines[0].line, grounding).map((s) => s.title), ["whitehouse.gov"]);
    assert.deepEqual(sourcesForLine(lines[1].line, grounding).map((s) => s.title), ["europa.eu"]);
    assert.deepEqual(sourcesForLine(lines[2].line, grounding), []);
    assert.deepEqual(sourcesForLine(lines[0].line, undefined), [], "検索の情報が無ければ出典なし");
  });
});

describe("地名から地図の地点を見つける", () => {
  it("国名・都市名を見つける（出てきた順・重複なし）", () => {
    assert.deepEqual(findPlaces("日本とアメリカのAI政策を比較").map((p) => p.name), ["日本", "アメリカ"]);
    assert.deepEqual(findPlaces("ロンドンとパリで開催").map((p) => p.name), ["イギリス", "フランス"]);
  });
  it("似た言葉では見つけない（お米・タイムライン・インドネシアとインドの区別）", () => {
    assert.deepEqual(findPlaces("お米の値段").map((p) => p.name), []);
    assert.deepEqual(findPlaces("タイムラインを確認").map((p) => p.name), []);
    assert.deepEqual(findPlaces("インドネシアの選挙").map((p) => p.name), ["インドネシア"]);
  });
});

describe("GLOBAL TREND（取得した話題から数える）", () => {
  it("分野ごとの関連件数", () => {
    const items = [
      { title: "生成AIの新モデル", summary: "", region: "", place: null, sources: [] },
      { title: "再生可能エネルギーの導入", summary: "太陽光が拡大", region: "", place: null, sources: [] },
      { title: "株式市場が上昇", summary: "", region: "", place: null, sources: [] },
    ];
    const c = Object.fromEntries(trendCounts(items).map((t) => [t.label, t.count]));
    assert.deepEqual(c, { AI: 1, Energy: 1, Health: 0, Finance: 1, Education: 0 });
  });
});

describe("情報ウィンドウの表", () => {
  it("Markdown の表を表として取り出し、前後の文章は残す", () => {
    const blocks = splitTables("比較です。\n\n| 項目 | 日本 | 米国 |\n|---|---|---|\n| 方針 | 推進 | 安全性 |\n\n以上。");
    assert.equal(blocks.length, 3);
    assert.deepEqual(blocks[1], { kind: "table", head: ["項目", "日本", "米国"], rows: [["方針", "推進", "安全性"]] });
  });
});

describe("世界地図のデータ（Natural Earth）", () => {
  const require = createRequire(import.meta.url);
  const rings = landRings(require("world-atlas/land-110m.json"));
  const dots = landDots(rings);
  it("陸地の輪郭と粒がある", () => {
    assert.ok(rings.length > 100);
    assert.ok(dots.length > 3000);
  });
  it("東京は陸、太平洋の真ん中は海", () => {
    const near = (lon: number, lat: number) => dots.some(([x, y]) => Math.abs(x - lon) < 2 && Math.abs(y - lat) < 1.5);
    assert.ok(near(139.7, 35.7));
    assert.ok(!near(-150, 0));
  });
  it("緯度・経度 ⇄ 球の上の位置", () => {
    const [x, y, z] = toXYZ(35.7, 139.7);
    const back = toLatLon(x, y, z);
    assert.ok(Math.abs(back.lat - 35.7) < 1e-6 && Math.abs(back.lon - 139.7) < 1e-6);
  });
});

describe("REAL-TIME NEWS の取得（模擬の Gemini。本物の Google は使わない）", async () => {
  const http = await import("node:http");
  const { getEdithNews } = await import("../src/integrations/edith-news");
  it("Google 検索の出典が付いた話題だけを返し、地点も付ける", async () => {
    let asked = "";
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        asked = body;
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        const text = "・インドで半導体工場の建設が始まる｜政府が支援策を発表した｜インド\n・出典の無い話題です｜確かめられない内容｜世界\n";
        const chunk = {
          candidates: [
            {
              content: { parts: [{ text }] },
              finishReason: "STOP",
              groundingMetadata: {
                groundingChunks: [{ web: { uri: "https://vertexaisearch.cloud.google.com/grounding-api-redirect/x", title: "reuters.com" } }],
                groundingSupports: [{ segment: { text: "インドで半導体工場の建設が始まる｜政府が支援策を発表した" }, groundingChunkIndices: [0] }],
              },
            },
          ],
        };
        res.end(`data: ${JSON.stringify(chunk)}\n\n`);
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    process.env.GEMINI_API_BASE_URL = `http://127.0.0.1:${port}/v1beta`;
    process.env.GEMINI_API_KEY = "test-key";
    try {
      const news = await getEdithNews("tech");
      assert.match(asked, /googleSearch|google_search/, "Google 検索を使って調べる");
      assert.equal(news.items.length, 1, "出典の無い話題は出さない");
      assert.equal(news.items[0].title, "インドで半導体工場の建設が始まる");
      assert.equal(news.items[0].place?.name, "インド");
      assert.equal(news.items[0].sources[0].title, "reuters.com");
    } finally {
      server.close();
      delete process.env.GEMINI_API_BASE_URL;
      delete process.env.GEMINI_API_KEY;
    }
  });
});

describe("モードごとに、そのモードの名前でだけ反応する・「〇〇を開いて」で切り替え", () => {
  it("「〇〇を開いて」で、その AI のモードへ", () => {
    assert.equal(detectModeCommand("カレンを開いて"), "to-karen");
    assert.equal(detectModeCommand("イーディスを開いて"), "to-edith");
    assert.equal(detectModeCommand("フライデーを開いて"), "to-friday");
    assert.equal(detectModeCommand("Spotifyを開いて"), null, "アプリを開く頼みは切り替えではない");
  });
  for (const [mode, own, others] of [
    ["friday", "フライデー、天気は", ["カレン", "カレン、球体を作って", "イーディス、ニュースは"]],
    ["karen", "カレン、球体を作って", ["フライデー", "フライデー、天気は", "イーディス", "イーディス、ニュースは"]],
    ["edith", "イーディス、ニュースは", ["フライデー", "フライデー、天気は", "カレン", "カレン、球体を作って"]],
  ] as const) {
    it(`${mode} の間：自分の名前で起き、ほかの名前だけ・ほかの名前への用件では起きない`, () => {
      setAiMode(mode);
      assert.equal(splitWake(own).woke, true, own);
      for (const t of others) assert.equal(splitWake(t).woke, false, t);
      setAiMode("friday");
    });
  }
  for (const [mode, text, to] of [
    ["friday", "カレンを開いて", "to-karen"],
    ["friday", "イーディスを開いて", "to-edith"],
    ["karen", "イーディスを開いて", "to-edith"],
    ["karen", "フライデーを開いて", "to-friday"],
    ["edith", "カレンを開いて", "to-karen"],
    ["edith", "フライデーに戻して", "to-friday"],
    ["karen", "カレン、イーディスを開いて", "to-edith"],
  ] as const) {
    it(`${mode} の間：「${text}」でモードを変える`, () => {
      setAiMode(mode);
      const r = splitWake(text);
      assert.equal(r.woke, true);
      assert.equal(detectModeCommand(r.command), to);
      setAiMode("friday");
    });
  }
});

describe("E.D.I.T.H. の名前の書かれ方（文字起こしの揺れ）", () => {
  for (const name of ["EDITH", "Edith", "E.D.I.T.H.", "イーディス", "イディス", "イーデス", "エディス", "エーディス", "いでぃす", "エディット"]) {
    it(`「${name}を開いて」→ E.D.I.T.H.（どのモードからでも）`, () => {
      assert.equal(detectModeCommand(`${name}を開いて`), "to-edith");
      for (const mode of ["friday", "karen"] as const) {
        setAiMode(mode);
        const r = splitWake(`${name}を開いて`);
        assert.equal(r.woke, true, mode);
        assert.equal(detectModeCommand(r.command), "to-edith", mode);
      }
      setAiMode("friday");
    });
  }
  it("「開けて」「オープンして」でも開く", () => {
    assert.equal(detectModeCommand("イーディス開けて"), "to-edith");
    assert.equal(detectModeCommand("EDITHをオープンして"), "to-edith");
  });
  it("「かわいいです」「いいですね、お願い」のような普通の言葉では切り替えない", () => {
    assert.equal(detectModeCommand("かわいいです、お願い"), null);
    assert.equal(detectModeCommand("いいですね、開いて"), null);
  });
  it("E.D.I.T.H. の間は「イディス、〜」「EDITH、〜」でも起きる", () => {
    setAiMode("edith");
    assert.deepEqual(splitWake("イディス、ニュースは"), { woke: true, command: "ニュースは" });
    assert.deepEqual(splitWake("EDITH、天気は"), { woke: true, command: "天気は" });
    setAiMode("friday");
  });
});
