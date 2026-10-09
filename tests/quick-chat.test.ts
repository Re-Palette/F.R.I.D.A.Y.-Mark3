/**
 * 短い日常会話の判定のテスト（ローカル AI で答えてよいか。迷ったら Gemini）。
 *   npm test
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isQuickChat } from "../src/lib/quick-chat";

const quick = (text: string, previousAssistant?: string, hasAttachment?: boolean) => isQuickChat({ text, previousAssistant, hasAttachment });

describe("ローカル AI で答える（短い日常会話）", () => {
  for (const t of ["こんにちは", "ありがとう！", "了解", "なるほどね", "疲れた〜", "元気？", "おやすみ", "フライデー、ただいま", "いいね", "眠い"]) {
    it(t, () => assert.equal(quick(t), true));
  }
});

describe("いつもどおり Gemini（ツール・情報が要る・迷う）", () => {
  for (const t of [
    "今日の予定は？",
    "明日の天気教えて",
    "牛乳買うのToDoに入れて",
    "これ覚えておいて",
    "YouTube開いて",
    "ニュース調べて",
    "音楽かけて",
    "ありがとう、じゃあ明日10時に打ち合わせ入れて",
    "ARQOどう？",
    "青学の課題",
    "Re-Paletteの資料作って",
    "おはよう", // 朝のまとめ（予定・天気・ToDo）を話すので Gemini
    "なんで空は青いの？",
    "量子コンピュータについて詳しく教えてほしいんだけど時間ある？",
    "3時に起こして",
    "https://example.com",
    "了解です。では来週の月曜日の午後にお願いします",
    "ちょっと相談があって",
  ]) {
    it(t, () => assert.equal(quick(t), false));
  }
});

describe("直前に FRIDAY が質問していたら Gemini（答えが操作につながる）", () => {
  it("「追加しますか？」への「はい」", () => assert.equal(quick("はい", "牛乳を ToDo に追加しますか？"), false));
  it("「どちらにしますか」への「うん」", () => assert.equal(quick("うん", "A案とB案、どちらにしますか"), false));
  it("質問でない返事のあとの「ありがとう」はローカル", () => assert.equal(quick("ありがとう", "ToDo に入れておきました。"), true));
});

describe("写真・ファイル・録った声が付いていたら Gemini", () => {
  it("写真つきの「ありがとう」", () => assert.equal(quick("ありがとう", undefined, true), false));
  it("空の発言", () => assert.equal(quick("   "), false));
});
