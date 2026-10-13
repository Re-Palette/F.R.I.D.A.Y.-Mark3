import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";

const lib = await import("../src/lib/line");
const line = await import("../src/integrations/line");
const route = await import("../src/app/api/line/webhook/route");

const USER = "U" + "a".repeat(32);
const OTHER = "U" + "b".repeat(32);
const env = { LINE_CHANNEL_SECRET: "sec", LINE_CHANNEL_ACCESS_TOKEN: "tok", LINE_ALLOWED_USER_IDS: USER };
const sign = (secret: string, body: string) => createHmac("sha256", secret).update(body).digest("base64");

function fakeBrain() {
  const files = new Map<string, string>();
  return {
    files,
    brain: {
      configured: true,
      read: async (p: string) => files.get(p) ?? null,
      update: async (p: string, f: (c: string | null) => string) => void files.set(p, f(files.get(p) ?? null)),
    },
  };
}

describe("LINE：受け取り", () => {
  it("署名：正しいものだけ通す", () => {
    const body = '{"events":[]}';
    assert.ok(lib.verifyLineSignature("sec", body, sign("sec", body)));
    assert.ok(!lib.verifyLineSignature("sec", body, sign("other", body)));
    assert.ok(!lib.verifyLineSignature("sec", body + " ", sign("sec", body)));
    assert.ok(!lib.verifyLineSignature("sec", body, null));
  });
  it("1 対 1 のトークのメッセージだけ取り出す", () => {
    const ev = lib.parseLineWebhook({
      events: [
        { type: "message", mode: "active", replyToken: "r1", source: { type: "user", userId: USER }, message: { type: "text", id: "1", text: "こんにちは" } },
        { type: "message", replyToken: "r2", source: { type: "user", userId: USER }, message: { type: "audio", id: "2" } },
        { type: "message", replyToken: "r3", source: { type: "group", groupId: "G1", userId: USER }, message: { type: "text", text: "x" } },
        { type: "follow", replyToken: "r4", source: { type: "user", userId: USER } },
        { type: "message", replyToken: "r5", source: { type: "user", userId: "bad" }, message: { type: "text", text: "x" } },
      ],
    });
    assert.deepEqual(ev.map((e) => e.kind), ["text", "audio"]);
  });
  it("メモの指示：「メモ：」「記録して」だけ。質問は AI に渡す", () => {
    assert.equal(lib.parseMemoCommand("メモ：牛乳を買う"), "牛乳を買う");
    assert.equal(lib.parseMemoCommand("記録して 明日は9時に集合"), "明日は9時に集合");
    assert.equal(lib.parseMemoCommand("メモして、駐車場は B2"), "駐車場は B2");
    assert.equal(lib.parseMemoCommand("メモして"), null);
    assert.equal(lib.parseMemoCommand("記録を見せて"), null);
    assert.equal(lib.parseMemoCommand("メモ：これ何？"), null);
    assert.equal(lib.parseMemoCommand("明日の予定は"), null);
  });
  it("長い返事は 5000 字ごとに分け、5 通まで", () => {
    const parts = lib.splitForLine("あ".repeat(12000));
    assert.equal(parts.length, 3);
    assert.ok(parts.every((p) => p.length <= 4900));
    assert.equal(lib.splitForLine("い".repeat(40000)).length, 5);
    assert.equal(lib.plainForLine("## 見出し\n**太字** [Google](https://google.com)\n- 項目"), "■ 見出し\n太字 Google（https://google.com）\n・項目");
  });
});

describe("LINE：答える", () => {
  it("登録されていない人には、登録に使う ID だけ返す（会話はしない）", async () => {
    let talked = false;
    const out = await line.answerLine({ kind: "text", userId: OTHER, replyToken: "r", text: "予定は？" }, { env, converse: async function* () { talked = true; } });
    assert.match(out[0], /LINE_ALLOWED_USER_IDS/);
    assert.match(out[0], new RegExp(OTHER));
    assert.equal(talked, false);
  });
  it("メモ：AI を通さず、脳の メモ/LINE/<日付>.md に書く", async () => {
    const { files, brain } = fakeBrain();
    let talked = false;
    const out = await line.answerLine({ kind: "text", userId: USER, replyToken: "r", text: "メモ：駐車場は B2" }, { env, brain, now: () => new Date("2026-10-13T03:05:00Z"), converse: async function* () { talked = true; } });
    const path = [...files.keys()][0];
    assert.match(path, /^メモ\/LINE\/2026-10-13\.md$/);
    assert.match(files.get(path) ?? "", /- 12:05 駐車場は B2/);
    assert.match(out[0], /脳に記録しました/);
    assert.equal(talked, false);
  });
  it("会話：答え・操作・関連ノート（引用）を返し、脳に残し、直前の会話を保存する", async () => {
    const { files, brain } = fakeBrain();
    const saved: unknown[] = [];
    let seenHistory: { role: string; content: string }[] = [];
    const deps = {
      env,
      brain,
      converse: async function* (h: { role: string; content: string }[], _s: AbortSignal, onTurn: (t: never) => void) {
        seenHistory = h;
        yield { type: "delta", text: "**明日は** 10時から会議です。" } as never;
        yield { type: "calendar", action: "add", ok: true, title: "会議", when: "10/14 10:00" } as never;
        yield { type: "done" } as never;
        onTurn({ user: "u", assistant: "a" } as never);
      },
      recall: async () => [{ source: "授業/経済学/2026-10-01.md" }, { source: ".friday/session.json" }, { source: "メモ/予定.md" }],
      save: async (t: unknown) => void saved.push(t),
    };
    const out = await line.answerLine({ kind: "text", userId: USER, replyToken: "r", text: "明日の会議を入れて" }, deps as never);
    const text = out.join("\n");
    assert.match(text, /明日は 10時から会議です。/);
    assert.match(text, /📅 予定を追加しました：会議（10\/14 10:00）/);
    assert.match(text, /📝 脳の関連ノート：\n・授業\/経済学\/2026-10-01\n・メモ\/予定/);
    assert.doesNotMatch(text, /\.friday/);
    assert.equal(saved.length, 1);
    // 2 回目は直前の会話を渡す
    await line.answerLine({ kind: "text", userId: USER, replyToken: "r2", text: "それ何時まで？" }, deps as never);
    assert.deepEqual(seenHistory.map((m) => m.content), ["明日の会議を入れて", "**明日は** 10時から会議です。", "それ何時まで？"]);
    assert.ok([...files.keys()].some((k) => k.startsWith(".friday/line/")));
  });
  it("声：LINE から受け取って文字にし、聞き取った文を添える", async () => {
    const { brain } = fakeBrain();
    const fetchImpl = (async (url: string) => {
      assert.match(url, /api-data\.line\.me\/v2\/bot\/message\/123\/content/);
      return new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "audio/x-m4a" } });
    }) as never;
    let gotAudio: { mimeType: string } | undefined;
    const out = await line.answerLine({ kind: "audio", userId: USER, replyToken: "r", messageId: "123" }, {
      env,
      brain,
      fetchImpl,
      recall: async () => [],
      converse: async function* (h: { audio?: { mimeType: string } }[]) {
        gotAudio = h[h.length - 1].audio;
        yield { type: "transcript", text: "今日の天気は" } as never;
        yield { type: "delta", text: "晴れです。" } as never;
      },
    } as never);
    assert.equal(gotAudio?.mimeType, "audio/mp4");
    assert.match(out[0], /🎤 聞き取り：今日の天気は/);
    assert.match(out[0], /晴れです。/);
  });
  it("送る：返事の権利が切れていたら push", async () => {
    const calls: string[] = [];
    const f = (async (url: string) => (calls.push(url), new Response("{}", { status: url.endsWith("/reply") ? 400 : 200 }))) as never;
    assert.equal(await line.sendLine("tok", { replyToken: "r", userId: USER }, ["a"], f), "push");
    assert.deepEqual(calls.map((u) => u.split("/").pop()), ["reply", "push"]);
  });
});

describe("LINE：受け口の API", () => {
  it("設定が無ければ 503、署名が違えば 401、接続確認（空）は 200", async () => {
    const keep = { ...process.env };
    try {
      delete process.env.LINE_CHANNEL_SECRET;
      delete process.env.LINE_CHANNEL_ACCESS_TOKEN;
      assert.equal((await route.POST(new Request("http://x/api/line/webhook", { method: "POST", body: "{}" }))).status, 503);
      process.env.LINE_CHANNEL_SECRET = "sec";
      process.env.LINE_CHANNEL_ACCESS_TOKEN = "tok";
      const body = '{"destination":"x","events":[]}';
      assert.equal((await route.POST(new Request("http://x/api/line/webhook", { method: "POST", body, headers: { "x-line-signature": sign("wrong", body) } }))).status, 401);
      assert.equal((await route.POST(new Request("http://x/api/line/webhook", { method: "POST", body, headers: { "x-line-signature": sign("sec", body) } }))).status, 200);
    } finally {
      process.env = keep;
    }
  });
});

describe("LINE：F.R.I.D.A.Y. から知らせる", () => {
  it("リマインダーは登録した人全員に push で送る（設定が無ければ送らない）", async () => {
    const sent: { to: string; text: string }[] = [];
    const f = (async (url: string, init: RequestInit) => {
      assert.match(url, /\/message\/push$/);
      const b = JSON.parse(String(init.body));
      sent.push({ to: b.to, text: b.messages[0].text });
      return new Response("{}");
    }) as never;
    const n = await line.notifyLine("⏰ 15:00 リマインダー", "薬を飲む", { env: { ...env, LINE_ALLOWED_USER_IDS: `${USER},${OTHER}` }, fetchImpl: f });
    assert.equal(n, 2);
    assert.deepEqual(sent.map((s) => s.to), [USER, OTHER]);
    assert.equal(sent[0].text, "⏰ 15:00 リマインダー\n薬を飲む");
    assert.equal(await line.notifyLine("a", "b", { env: {}, fetchImpl: f }), 0);
    assert.equal(line.canNotifyLine(env), true);
    assert.equal(line.canNotifyLine({ ...env, LINE_ALLOWED_USER_IDS: "" }), false);
  });
});
