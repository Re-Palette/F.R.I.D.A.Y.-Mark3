/**
 * K.A.R.E.N.（クリエイティブ AI）のテスト。
 *   - F.R.I.D.A.Y. ⇄ K.A.R.E.N. の切り替えの言葉を見分ける（迷うものは切り替えない）
 *   - 指示の読み取り（作る・編集・未実装・聞き返し・会話）
 *   - 状態の移り方（球が消える演出 → 制作 → 完成。古い結果・キャンセル・演出中の完成）
 *   npm test
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

const { detectModeCommand, setAiMode } = await import("../src/lib/ai-mode");
const { splitWake } = await import("../src/lib/speech");
const { parseKarenCommand, startsCreation } = await import("../src/lib/karen-intent");
const { reduce, INITIAL, busy } = await import("../src/lib/karen-state");

describe("F.R.I.D.A.Y. ⇄ K.A.R.E.N. の切り替え", () => {
  for (const t of ["K.A.R.E.N.を呼び出して", "カレン、起動", "KARENを呼んで", "クリエイティブモードに切り替えて", "3D制作を始めたい", "カレンを開いて"]) {
    it(`「${t}」→ K.A.R.E.N.`, () => assert.equal(detectModeCommand(t), "to-karen"));
  }
  for (const t of ["FRIDAYに戻して", "フライデーに戻って", "通常モードに戻って", "カレン終了", "クリエイティブモードを終了"]) {
    it(`「${t}」→ F.R.I.D.A.Y.`, () => assert.equal(detectModeCommand(t), "to-friday"));
  }
  for (const t of ["カレンって何？", "今日の予定は？", "ロケットのホログラムを作って", "フライデー、天気は？", "カレンダーを見せて", "カレントディレクトリ", ""]) {
    it(`「${t}」は切り替えない`, () => assert.equal(detectModeCommand(t), null));
  }
  it("呼びかけを取り除いたあとの「に戻して」「終了」も F.R.I.D.A.Y. に戻る", () => {
    for (const t of ["に戻して", "戻って", "戻りたい", "終了"]) assert.equal(detectModeCommand(t), "to-friday", t);
  });
  it("名前だけ（「カレン」）・「お願い」だけでは切り替えない", () => {
    for (const t of ["カレン", "お願い", "を呼んで"]) assert.equal(detectModeCommand(t), null, t);
  });
  it("「フライデーを呼んで」「FRIDAYお願い」も F.R.I.D.A.Y. に戻る", () => {
    assert.equal(detectModeCommand("フライデーを呼んで"), "to-friday");
    assert.equal(detectModeCommand("FRIDAYお願い"), "to-friday");
  });
});

describe("声の呼びかけ（フライデー）：文字起こしの揺れも拾う", () => {
  for (const t of ["フライデー", "フライデイ、今日の天気は", "フライ・デー", "Friday", "フライディ", "ふらいでー"]) {
    it(`「${t}」で起きる`, () => {
      setAiMode("friday");
      assert.equal(splitWake(t).woke, true);
    });
  }
  it("「フライデイ、今日の天気は」→ 用件は「今日の天気は」", () => assert.equal(splitWake("フライデイ、今日の天気は").command, "今日の天気は"));
  for (const t of ["ねえフライデー", "ヘイ、フライデー、今日の予定は", "Friday, 天気は", "プライデー"]) {
    it(`「${t}」でも起きる（頭で呼んだとき）`, () => {
      setAiMode("friday");
      assert.equal(splitWake(t).woke, true);
    });
  }
  for (const t of ["ブラックフライデーのセールが始まりました", "今日はフライデーだね", "フライドポテト", "ぶらいてい", "フライてー", "プライデ", "テレビでフライデーって言ってた", "カレーライス", "それはかれんだね"]) {
    it(`「${t}」では起きない（文の途中・似た言葉）`, () => {
      setAiMode("friday");
      assert.equal(splitWake(t).woke, false);
    });
  }
});

describe("声の呼びかけ（カレン）", () => {
  it("F.R.I.D.A.Y. の間：「カレン、起動」は名前ごと渡して切り替えの言葉として見分ける。「カレンダー」では起きない", () => {
    setAiMode("friday");
    assert.deepEqual(splitWake("カレン、起動"), { woke: true, command: "カレン、起動" });
    assert.equal(detectModeCommand(splitWake("カレン、起動").command), "to-karen");
    assert.equal(splitWake("カレンダーを見せて").woke, false);
  });
  it("K.A.R.E.N. の間：「カレン、球体を作って」は名前を取り除く。「フライデーに戻して」は「に戻して」で戻る", () => {
    setAiMode("karen");
    assert.deepEqual(splitWake("カレン、球体を作って"), { woke: true, command: "球体を作って" });
    assert.equal(detectModeCommand(splitWake("フライデーに戻して").command), "to-friday");
    setAiMode("friday");
  });
});

describe("K.A.R.E.N. への指示の読み取り", () => {
  it("「球体を作って、青くして、少し大きくして」→ 作る → 青 → 1.1 倍（順番どおり）", () => {
    const { ops, chat } = parseKarenCommand("球体を作って、青くして、少し大きくして");
    assert.equal(chat, false);
    assert.deepEqual(
      ops.map((o) => o.kind),
      ["add-primitive", "color", "scale"],
    );
    assert.equal(ops[0].kind === "add-primitive" && ops[0].shape, "sphere");
    assert.equal(ops[1].kind === "color" && ops[1].label, "青");
    assert.ok(ops[2].kind === "scale" && Math.abs(ops[2].factor - 1.1) < 1e-9);
  });
  for (const [t, subject] of [
    ["未来都市のモデルを作って", "未来都市"],
    ["ロケットの3Dホログラムを作成して", "ロケット"],
    ["スポーツカーを3Dで作って", "スポーツカー"],
  ] as const) {
    it(`「${t}」→ 「${subject}」の 3D モデルを作る`, () => {
      const { ops } = parseKarenCommand(t);
      assert.equal(ops.length, 1);
      assert.equal(ops[0].kind, "create-model");
      assert.equal(ops[0].kind === "create-model" && ops[0].subject, subject);
      assert.ok(startsCreation(ops[0]));
    });
  }
  it("何を作るか分からなければ聞き返す（決めつけない）", () => {
    assert.equal(parseKarenCommand("3Dホログラムを作成して").ops[0].kind, "ask");
    assert.equal(parseKarenCommand("この商品の3Dモデルを生成して").ops[0].kind, "ask");
  });
  it("道具が無い制作は未実装と伝える（作ったふりをしない）", () => {
    for (const t of ["Webサイトのデザインを作って", "アニメーションを作成して", "ロゴを作って"]) {
      const op = parseKarenCommand(t).ops[0];
      assert.equal(op.kind, "unsupported", t);
    }
  });
  it("編集・保存・書き出し・キャンセル・待機に戻る", () => {
    const kinds = (t: string) => parseKarenCommand(t).ops.map((o) => o.kind);
    assert.deepEqual(kinds("右に動かして"), ["move"]);
    assert.deepEqual(kinds("90度回して"), ["rotate"]);
    assert.deepEqual(kinds("赤にして"), ["color"]);
    assert.deepEqual(kinds("2倍にして"), ["scale"]);
    assert.deepEqual(kinds("消して"), ["delete"]);
    assert.deepEqual(kinds("保存して"), ["save"]);
    assert.deepEqual(kinds("GLBで書き出して"), ["export"]);
    assert.deepEqual(kinds("制作をキャンセル"), ["cancel"]);
    assert.deepEqual(kinds("待機状態に戻って"), ["idle"]);
    assert.deepEqual(kinds("次の制作を開始"), ["next"]);
  });
  it("「青い立方体を作って」は形と色、「地球のモデルを作って」は 3D モデル", () => {
    assert.deepEqual(
      parseKarenCommand("青い立方体を作って").ops.map((o) => o.kind),
      ["add-primitive", "color"],
    );
    assert.equal(parseKarenCommand("地球のモデルを作って").ops[0].kind, "create-model");
  });
  it("質問・雑談は会話として AI に渡す（制作を始めない）", () => {
    for (const t of ["3Dモデルってどうやって作るの？", "おすすめの配色を教えて", "ありがとう"]) assert.equal(parseKarenCommand(t).chat, true, t);
  });
});

describe("状態の移り方", () => {
  const run = (...events: Parameters<typeof reduce>[1][]) => events.reduce((s, e) => reduce(s, e, 1000), INITIAL);

  it("待機 → 聞く → 読み取り → 球が消える演出 → 制作 → 完成（結果は出したまま）", () => {
    let s = run({ type: "LISTEN_START" });
    assert.equal(s.phase, "LISTENING");
    s = reduce(s, { type: "HEARD", text: "未来都市を作って" });
    assert.equal(s.phase, "UNDERSTANDING");
    s = reduce(s, { type: "START_CREATE", request: "未来都市の 3D ホログラムを作成", jobId: 1 });
    assert.equal(s.phase, "TRANSITIONING");
    assert.equal(s.workspace, true);
    assert.ok(busy(s));
    s = reduce(s, { type: "TRANSITION_DONE" });
    assert.equal(s.phase, "CREATING");
    s = reduce(s, { type: "JOB_STEP", jobId: 1, step: "research" });
    assert.deepEqual(s.job?.done, ["find"]);
    s = reduce(s, { type: "JOB_DONE", jobId: 1 });
    assert.equal(s.phase, "COMPLETED");
    assert.equal(s.workspace, true, "完成しても球には自動で戻らない");
  });
  it("演出の途中で制作が終わっても、演出が終わってから COMPLETED（画面が飛ばない）", () => {
    let s = run({ type: "START_CREATE", request: "x", jobId: 2 }, { type: "JOB_DONE", jobId: 2 });
    assert.equal(s.phase, "TRANSITIONING");
    s = reduce(s, { type: "TRANSITION_DONE" });
    assert.equal(s.phase, "COMPLETED");
  });
  it("キャンセルのあとに届いた古い結果・別の制作の結果は捨てる", () => {
    let s = run({ type: "START_CREATE", request: "a", jobId: 3 }, { type: "TRANSITION_DONE" }, { type: "CANCEL" });
    assert.equal(s.phase, "CANCELLED");
    s = reduce(s, { type: "JOB_DONE", jobId: 3 });
    assert.equal(s.phase, "CANCELLED");
    s = reduce(s, { type: "START_CREATE", request: "b", jobId: 4 });
    assert.equal(s.phase, "CREATING", "ワークスペースが出ていれば演出は繰り返さない");
    s = reduce(s, { type: "JOB_ERROR", jobId: 3, error: "古い" });
    assert.equal(s.phase, "CREATING");
    s = reduce(s, { type: "JOB_ERROR", jobId: 4, error: "失敗" });
    assert.equal(s.phase, "ERROR");
    assert.equal(s.error, "失敗");
  });
  it("制作中は聞き取りで表示を上書きしない。編集は EDITING → PREVIEW", () => {
    let s = run({ type: "START_CREATE", request: "a", jobId: 5 }, { type: "TRANSITION_DONE" }, { type: "LISTEN_START" });
    assert.equal(s.phase, "CREATING");
    s = reduce(s, { type: "JOB_DONE", jobId: 5 });
    s = reduce(s, { type: "EDIT_START" });
    assert.equal(s.phase, "EDITING");
    s = reduce(s, { type: "EDIT_DONE" });
    assert.equal(s.phase, "PREVIEW");
  });
  it("形を足す（その場で終わる制作）は演出のあと PREVIEW。待機に戻ると球に戻る", () => {
    let s = run({ type: "START_CREATE", request: "球体を作成" }, { type: "TRANSITION_DONE" });
    assert.equal(s.phase, "PREVIEW");
    assert.equal(busy(s), false);
    s = reduce(s, { type: "RESET" });
    assert.equal(s.phase, "IDLE");
    assert.equal(s.workspace, false);
  });
  it("会話の発言だったら、読み取りの前の状態に戻る", () => {
    let s = run({ type: "START_CREATE", request: "球体" }, { type: "TRANSITION_DONE" }, { type: "HEARD", text: "ありがとう" });
    assert.equal(s.phase, "UNDERSTANDING");
    s = reduce(s, { type: "NOT_CREATIVE" });
    assert.equal(s.phase, "PREVIEW");
  });
});

describe("拍手 2 回で起動したときの一言", async () => {
  const { bootLine } = await import("../src/lib/boot-line");
  const at = (h: number, m = 0) => new Date(2026, 9, 9, h, m);
  it("朝（4:00〜11:59）は Good morning", () => {
    assert.equal(bootLine(at(4)), "All systems are online. Good morning, sir.");
    assert.equal(bootLine(at(11, 59)), "All systems are online. Good morning, sir.");
  });
  it("昼（12:00〜17:59）は Good afternoon", () => {
    assert.equal(bootLine(at(12)), "All systems are online. Good afternoon, sir.");
    assert.equal(bootLine(at(17, 59)), "All systems are online. Good afternoon, sir.");
  });
  it("夜（18:00〜3:59）は Good evening", () => {
    assert.equal(bootLine(at(18)), "All systems are online. Good evening, sir.");
    assert.equal(bootLine(at(0)), "All systems are online. Good evening, sir.");
    assert.equal(bootLine(at(3, 59)), "All systems are online. Good evening, sir.");
  });
});

describe("K.A.R.E.N. の間は「フライデー」では起きない", () => {
  it("「フライデー」「フライデー、今日の天気は」では起きない。「フライデーに戻して」だけは戻る指示として受け付ける", () => {
    setAiMode("karen");
    assert.equal(splitWake("フライデー").woke, false);
    assert.equal(splitWake("フライデー、今日の天気は").woke, false);
    assert.deepEqual(splitWake("フライデーに戻して"), { woke: true, command: "フライデーに戻して" });
    assert.equal(detectModeCommand(splitWake("フライデーに戻して").command), "to-friday");
    assert.equal(detectModeCommand(splitWake("フライデー、通常モードに戻って").command), "to-friday");
    assert.deepEqual(splitWake("カレン、球体を作って"), { woke: true, command: "球体を作って" });
    setAiMode("friday");
    assert.equal(splitWake("フライデー").woke, true, "F.R.I.D.A.Y. に戻れば、また「フライデー」で起きる");
  });
});

describe("「カレン」が漢字で文字になっても呼べる", () => {
  it("K.A.R.E.N. の間：「花蓮、球体を作って」で起きる。「可憐な花」では切り替えない", () => {
    setAiMode("karen");
    assert.deepEqual(splitWake("花蓮、球体を作って"), { woke: true, command: "球体を作って" });
    setAiMode("friday");
    assert.equal(detectModeCommand("可憐、起動"), "to-karen");
    assert.equal(splitWake("可憐な花ですね").woke, false);
  });
});
